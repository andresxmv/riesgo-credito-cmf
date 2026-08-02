from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def publish(sqlite_path: Path, database_url: str) -> dict[str, int]:
    local = sqlite3.connect(sqlite_path)
    local.row_factory = sqlite3.Row
    remote = psycopg.connect(database_url, row_factory=dict_row)
    documents_count = 0
    facts_count = 0
    issuers_count = 0
    try:
        issuers = local.execute("SELECT * FROM issuer ORDER BY rut").fetchall()
        for issuer in issuers:
            remote.execute(
                """
                INSERT INTO public.issuer (rut, name, status, source, retrieved_at)
                VALUES (%s, %s, %s, 'CMF', %s)
                ON CONFLICT (rut) DO UPDATE SET
                  name = EXCLUDED.name,
                  status = EXCLUDED.status,
                  retrieved_at = EXCLUDED.retrieved_at
                """,
                (issuer["rut"], issuer["name"], issuer["status"], issuer["retrieved_at"]),
            )
            issuers_count += 1

        documents = local.execute("SELECT * FROM source_document ORDER BY issuer_rut, period").fetchall()
        for document in documents:
            period_end = local.execute(
                "SELECT max(period_end) AS period_end FROM xbrl_fact WHERE source_document_id = ?",
                (document["id"],),
            ).fetchone()["period_end"]
            if not period_end:
                continue
            remote.execute(
                """
                INSERT INTO public.quarter (period_code, period_end, fiscal_year, fiscal_month)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (period_code) DO UPDATE SET
                  period_end = EXCLUDED.period_end,
                  fiscal_year = EXCLUDED.fiscal_year,
                  fiscal_month = EXCLUDED.fiscal_month
                """,
                (document["period"], period_end, int(document["period"][:4]), int(document["period"][4:6])),
            )
            remote.execute(
                """
                INSERT INTO public.source_document
                  (issuer_rut, period_code, statement_type, page_url, source_url,
                   content_hash, local_path, retrieved_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (issuer_rut, period_code, statement_type) DO UPDATE SET
                  page_url = EXCLUDED.page_url,
                  source_url = EXCLUDED.source_url,
                  content_hash = EXCLUDED.content_hash,
                  local_path = EXCLUDED.local_path,
                  retrieved_at = EXCLUDED.retrieved_at
                """,
                (
                    document["issuer_rut"], document["period"], document["statement_type"],
                    document["page_url"], document["source_url"], document["content_hash"],
                    document["local_path"], document["retrieved_at"],
                ),
            )
            remote_document = remote.execute(
                """
                SELECT id FROM public.source_document
                WHERE issuer_rut = %s AND period_code = %s AND statement_type = %s
                """,
                (document["issuer_rut"], document["period"], document["statement_type"]),
            ).fetchone()
            facts = local.execute(
                "SELECT * FROM xbrl_fact WHERE source_document_id = ? ORDER BY id",
                (document["id"],),
            ).fetchall()
            remote.executemany(
                """
                INSERT INTO public.xbrl_fact
                  (source_document_id, issuer_rut, statement_type, concept, context_id,
                   period_start, period_end, instant, unit, decimals, value_numeric,
                   value_text, dimensions, source_url)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (source_document_id, context_id, concept, dimensions) DO UPDATE SET
                  value_numeric = EXCLUDED.value_numeric,
                  value_text = EXCLUDED.value_text,
                  unit = EXCLUDED.unit,
                  decimals = EXCLUDED.decimals,
                  source_url = EXCLUDED.source_url
                """,
                [
                    (
                        remote_document["id"], fact["issuer_rut"], fact["statement_type"],
                        fact["concept"], fact["context_id"], fact["period_start"],
                        fact["period_end"], fact["instant"], fact["unit"], fact["decimals"],
                        fact["value_numeric"], fact["value_text"], fact["dimensions_json"],
                        fact["source_url"],
                    )
                    for fact in facts
                ],
            )
            documents_count += 1
            facts_count += len(facts)
        remote.commit()
    except Exception:
        remote.rollback()
        raise
    finally:
        local.close()
        remote.close()
    return {"issuers": issuers_count, "documents": documents_count, "facts": facts_count}


def main() -> int:
    parser = argparse.ArgumentParser(description="Publica el read model XBRL local en PostgreSQL/Supabase")
    parser.add_argument("--sqlite", type=Path, default=Path("data/cmf/cmf.db"))
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    args = parser.parse_args()
    if not args.database_url:
        raise SystemExit("Configura DATABASE_URL o usa --database-url")
    print(json.dumps(publish(args.sqlite, args.database_url), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
