from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware


DB_PATH = Path(os.getenv("CMF_DB_PATH", "data/cmf/cmf.db"))
METRICS: dict[str, dict[str, Any]] = {
    "revenue": {"label": "Ingresos", "unit": "CLP mm", "tone": "gold", "patterns": ["revenue", "sales", "ingresos", "ventas"]},
    "ebitda": {"label": "EBITDA", "unit": "CLP mm", "tone": "mint", "patterns": ["ebitda"]},
    "ebit": {"label": "EBIT", "unit": "CLP mm", "tone": "blue", "patterns": ["operatingprofitloss", "operatingincome", "ebit"]},
    "income": {"label": "Utilidad neta", "unit": "CLP mm", "tone": "violet", "patterns": ["profitloss", "profitforperiod", "netincome", "gananciaperdida"]},
    "cash": {"label": "Caja y equivalentes", "unit": "CLP mm", "tone": "mint", "patterns": ["cashandcashequivalents", "cash"]},
    "debt": {"label": "Deuda financiera", "unit": "CLP mm", "tone": "rose", "patterns": ["borrowings", "financialliability", "debt", "obligacionesfinancieras"]},
}

app = FastAPI(title="CMF CreditView API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CMF_ALLOWED_ORIGINS", "*").split(",")],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def clean_rut(value: str) -> str:
    return re.sub(r"[^0-9Kk]", "", value).upper()


def connection() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(status_code=503, detail="CMF database is not available")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def local_concept(concept: str) -> str:
    return concept.rsplit(":", 1)[-1].lower()


def display_unit(unit: str) -> str:
    """Human-readable label without changing the value reported by XBRL."""
    normalized = (unit or "").strip()
    if not normalized:
        return "Unidad XBRL no informada"
    if normalized.startswith("iso4217:"):
        return f"{normalized.removeprefix('iso4217:')} · XBRL"
    return f"{normalized} · XBRL"


def metric_facts(rows: list[sqlite3.Row], patterns: list[str]) -> list[tuple[str, float, str]]:
    selected: dict[str, tuple[int, float, str]] = {}
    for row in rows:
        if row["value_numeric"] is None or not row["period_end"]:
            continue
        concept = local_concept(row["concept"])
        rank = next((index for index, pattern in enumerate(patterns) if pattern in concept), None)
        if rank is None:
            continue
        dimensions = json.loads(row["dimensions_json"] or "{}")
        rank = rank * 10 + (100 if dimensions else 0)
        period_end = row["period_end"]
        candidate = (rank, float(row["value_numeric"]), row["unit"] or "")
        if period_end not in selected or rank < selected[period_end][0]:
            selected[period_end] = candidate
    return [(period, value, unit) for period, (_, value, unit) in sorted(selected.items())]


def build_metrics(rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for key, definition in METRICS.items():
        series = metric_facts(rows, definition["patterns"])
        values = [value for _, value, _ in series]
        change = None
        if len(values) >= 2 and values[-2] != 0:
            change = f"{((values[-1] / values[-2]) - 1) * 100:.1f}%"
        units = sorted({unit for _, _, unit in series if unit})
        result[key] = {
            "label": definition["label"],
            # Never relabel a USD/EUR fact as CLP. The API exposes the unit
            # published in the CMF XBRL instance and leaves conversion to a
            # separately versioned calculation layer.
            "unit": display_unit(units[0]) if len(units) == 1 else ("Múltiples unidades XBRL" if units else definition["unit"]),
            "sourceUnit": units[0] if len(units) == 1 else units,
            "values": values,
            "change": change,
            "tone": definition["tone"],
            "periods": [period for period, _, _ in series],
            "source": "CMF XBRL",
        }
    return result


def issuer_payload(rut: str) -> dict[str, Any]:
    normalized = clean_rut(rut)
    conn = connection()
    try:
        documents = conn.execute(
            "SELECT * FROM source_document WHERE issuer_rut = ? ORDER BY period DESC",
            (normalized,),
        ).fetchall()
        rows = conn.execute(
            "SELECT * FROM xbrl_fact WHERE issuer_rut = ? ORDER BY period_end, id",
            (normalized,),
        ).fetchall()
    finally:
        conn.close()
    if not documents:
        raise HTTPException(status_code=404, detail="No CMF XBRL data ingested for this issuer")
    return {
        "issuer_rut": normalized,
        "hasXbrl": True,
        "metrics": build_metrics(rows),
        "ratings": [],
        "events": [],
        "riskFlags": [],
        "lineage": {
            "source": "CMF XBRL",
            "documents": [
                {
                    "period": document["period"],
                    "sourceUrl": document["source_url"],
                    "contentHash": document["content_hash"],
                    "retrievedAt": document["retrieved_at"],
                }
                for document in documents
            ],
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "database": str(DB_PATH), "database_exists": DB_PATH.exists()}


@app.get("/api/issuer/{rut}/financials")
def financials(rut: str) -> dict[str, Any]:
    return issuer_payload(rut)


@app.get("/api/issuer/{rut}/history")
def history(rut: str, metric: str = Query("revenue")) -> dict[str, Any]:
    payload = issuer_payload(rut)
    if metric not in payload["metrics"]:
        raise HTTPException(status_code=400, detail="Unknown metric")
    return {"issuer_rut": payload["issuer_rut"], "metric": metric, **payload["metrics"][metric]}


@app.get("/api/issuer/{rut}")
def issuer(rut: str) -> dict[str, Any]:
    return issuer_payload(rut)
