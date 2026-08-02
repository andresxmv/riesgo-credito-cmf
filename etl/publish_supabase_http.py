from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx


class SupabaseBatchUploader:
    """Publishes the local XBRL read model through the private Edge Function."""

    def __init__(self, function_url: str, publishable_key: str, ingest_key: str, timeout: float = 120.0) -> None:
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=30),
            headers={
                "Authorization": f"Bearer {publishable_key}",
                "x-cmf-ingest-key": ingest_key,
                "Content-Type": "application/json",
            },
        )
        self.function_url = function_url

    def post(self, action: str, rows: list[dict[str, Any]], document: dict[str, str] | None = None) -> int:
        payload: dict[str, Any] = {"action": action, "rows": rows}
        if document:
            payload["document"] = document
        last_error: Exception | None = None
        for attempt in range(1, 7):
            try:
                response = self.client.post(self.function_url, json=payload)
                if response.status_code < 400:
                    return int(response.json().get("count", len(rows)))
                if response.status_code not in {408, 425, 429, 500, 502, 503, 504}:
                    response.raise_for_status()
                last_error = RuntimeError(f"{response.status_code}: {response.text[:500]}")
            except (httpx.HTTPError, ValueError) as error:
                last_error = error
            time.sleep(min(30.0, 2.0**(attempt - 1)))
        raise RuntimeError(f"Supabase batch failed after retries: {last_error}")

    def close(self) -> None:
        self.client.close()


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def publish(
    sqlite_path: Path,
    function_url: str,
    publishable_key: str,
    ingest_key: str,
    state_path: Path,
    fact_batch_size: int = 1000,
    shard_index: int = 0,
    shard_count: int = 1,
) -> dict[str, int]:
    local = sqlite3.connect(f"file:{sqlite_path.as_posix()}?mode=ro", uri=True)
    local.row_factory = sqlite3.Row
    uploader = SupabaseBatchUploader(function_url, publishable_key, ingest_key)
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    counts = {"issuers": 0, "quarters": 0, "documents": 0, "facts": 0, "skipped_documents": 0}
    try:
        issuers = [dict(row) for row in local.execute("SELECT rut, name, status, source, retrieved_at FROM issuer ORDER BY rut")]
        for start in range(0, len(issuers), 100):
            counts["issuers"] += uploader.post("issuer", issuers[start : start + 100])

        quarters = [
            {"period_code": row["period"], "period_end": row["period_end"],
             "fiscal_year": int(row["period"][:4]), "fiscal_month": int(row["period"][4:6])}
            for row in local.execute(
                """
                SELECT d.period, max(f.period_end) AS period_end
                FROM source_document d
                JOIN xbrl_fact f ON f.source_document_id = d.id
                WHERE f.period_end IS NOT NULL
                GROUP BY d.period
                ORDER BY d.period
                """
            )
        ]
        for start in range(0, len(quarters), 100):
            counts["quarters"] += uploader.post("quarter", quarters[start : start + 100])

        documents = local.execute("SELECT * FROM source_document ORDER BY issuer_rut, period, statement_type")
        for document_index, document in enumerate(documents):
            if document_index % shard_count != shard_index:
                continue
            key = f"{document['issuer_rut']}:{document['period']}:{document['statement_type']}"
            document_row = {
                "issuer_rut": document["issuer_rut"],
                "period_code": document["period"],
                "statement_type": document["statement_type"],
                "page_url": document["page_url"],
                "source_url": document["source_url"],
                "content_hash": document["content_hash"],
                "local_path": document["local_path"],
                "retrieved_at": document["retrieved_at"],
            }
            uploader.post("document", [document_row])
            if state.get(key) == document["content_hash"]:
                counts["skipped_documents"] += 1
                continue

            fact_rows = local.execute(
                """
                SELECT issuer_rut, statement_type, concept, context_id,
                       period_start, period_end, instant, unit, decimals,
                       value_numeric, value_text, dimensions_json, source_url
                FROM xbrl_fact WHERE source_document_id = ? ORDER BY id
                """,
                (document["id"],),
            )
            batch: list[dict[str, Any]] = []
            for fact in fact_rows:
                row = dict(fact)
                row["dimensions"] = json.loads(row.pop("dimensions_json") or "{}")
                batch.append(row)
                if len(batch) >= fact_batch_size:
                    counts["facts"] += uploader.post(
                        "facts", batch,
                        {"issuer_rut": document["issuer_rut"], "period_code": document["period"], "statement_type": document["statement_type"]},
                    )
                    batch = []
            if batch:
                counts["facts"] += uploader.post(
                    "facts", batch,
                    {"issuer_rut": document["issuer_rut"], "period_code": document["period"], "statement_type": document["statement_type"]},
                )
            state[key] = document["content_hash"]
            save_state(state_path, state)
            counts["documents"] += 1
            print(json.dumps({"document": key, **counts}, ensure_ascii=False), flush=True)
        return counts
    finally:
        uploader.close()
        local.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Publica XBRL CMF local por lotes en Supabase")
    parser.add_argument("--sqlite", type=Path, default=Path("data/cmf/cmf.db"))
    parser.add_argument("--function-url", default=os.getenv("CMF_INGEST_FUNCTION_URL"))
    parser.add_argument("--publishable-key", default=os.getenv("SUPABASE_PUBLISHABLE_KEY"))
    parser.add_argument("--ingest-key", default=os.getenv("CMF_INGEST_KEY"))
    parser.add_argument("--state", type=Path, default=Path("data/cmf/supabase-upload-state.json"))
    parser.add_argument("--fact-batch-size", type=int, default=1000)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    args = parser.parse_args()
    missing = [name for name, value in {
        "CMF_INGEST_FUNCTION_URL": args.function_url,
        "SUPABASE_PUBLISHABLE_KEY": args.publishable_key,
        "CMF_INGEST_KEY": args.ingest_key,
    }.items() if not value]
    if missing:
        raise SystemExit("Faltan variables: " + ", ".join(missing))
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        raise SystemExit("--shard-index debe estar entre 0 y --shard-count - 1")
    print(json.dumps(publish(args.sqlite, args.function_url, args.publishable_key, args.ingest_key, args.state, args.fact_batch_size, args.shard_index, args.shard_count), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
