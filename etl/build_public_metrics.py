"""Build the small, public read model used by the free deployment.

The full normalized XBRL fact store is intentionally not copied into a
small Postgres plan.  This job derives only the time series needed by the
CreditView screen from the local CMF XBRL database.  Every value remains
traceable to a source_document URL and content hash; missing facts are kept
missing instead of being filled with estimates.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


METRICS: dict[str, dict[str, Any]] = {
    "revenue": {"label": "Ingresos", "unit": "CLP mm", "tone": "gold", "patterns": ["revenue", "sales", "ingresos", "ventas"]},
    "ebitda": {"label": "EBITDA", "unit": "CLP mm", "tone": "mint", "patterns": ["ebitda"]},
    "ebit": {"label": "EBIT", "unit": "CLP mm", "tone": "blue", "patterns": ["profitlossfromoperatingactivities", "operatingprofitloss", "operatingincome", "ebit"]},
    "income": {"label": "Utilidad neta", "unit": "CLP mm", "tone": "violet", "patterns": ["profitloss", "profitforperiod", "netincome", "gananciaperdida"]},
    "cash": {"label": "Caja y equivalentes", "unit": "CLP mm", "tone": "mint", "patterns": ["cashandcashequivalents", "cash"]},
    "debt": {"label": "Deuda financiera", "unit": "CLP mm", "tone": "rose", "patterns": ["borrowings", "financialliability", "debt", "obligacionesfinancieras"]},
}

RATIO_FACTS: dict[str, dict[str, Any]] = {
    "assets": {"patterns": ["assets"], "kind": "balance"},
    "current_assets": {"patterns": ["currentassets"], "kind": "balance"},
    "current_liabilities": {"patterns": ["currentliabilities"], "kind": "balance"},
    "cash": {"patterns": ["cashandcashequivalents", "cash"], "kind": "balance"},
    "receivables": {"patterns": ["tradeandothercurrentreceivables", "currenttradereceivables", "tradeandotherreceivables", "currentreceivables"], "kind": "balance"},
    "debt": {"patterns": ["borrowings", "financialliabilities", "debt"], "kind": "balance"},
    "equity": {"patterns": ["equityattributabletoownersofparent", "equity"], "kind": "balance"},
    "ebit": {"patterns": ["profitlossfromoperatingactivities", "operatingprofitloss", "operatingincome", "ebit"], "kind": "flow"},
    "interest_expense": {"patterns": ["interestexpense"], "kind": "flow"},
    "operating_cash_flow": {"patterns": ["cashflowsfromusedinoperatingactivities", "cashflowsfromusedinoperations"], "kind": "flow"},
    "capex": {"patterns": ["purchaseofpropertyplantandequipmentclassifiedasinvestingactivities", "additionsotherthanthroughbusinesscombinationspropertyplantandequipment"], "kind": "flow"},
    "depreciation_amortization": {"patterns": ["depreciationandamortisationexpense", "depreciationexpense", "depreciationpropertyplantandequipment"], "kind": "flow"},
}

RATIO_DEFINITIONS = {
    "currentRatio": ("Current Ratio", "current_assets", "current_liabilities", "x"),
    "quickRatio": ("Quick Ratio", "quick_assets", "current_liabilities", "x"),
    "cashRatio": ("Cash Ratio", "cash", "current_liabilities", "x"),
    "debtEquity": ("Debt / Equity", "debt", "equity", "x"),
    "debtAssets": ("Debt / Assets", "debt", "assets", "x"),
    "netDebt": ("Net Debt", "net_debt", None, "XBRL"),
    "netDebtEbitda": ("Net Debt / EBITDA", "net_debt", "ebitda", "x"),
    "interestCoverage": ("Interest Coverage", "ebit", "interest_expense", "x"),
    "roa": ("ROA", "income", "assets", "%"),
    "roe": ("ROE", "income", "equity", "%"),
    "roic": ("ROIC", "ebit", "invested_capital", "%"),
    "fcf": ("FCF", "fcf", None, "XBRL"),
    "operatingCashFlow": ("Operating Cash Flow", "operating_cash_flow", None, "XBRL"),
    "capex": ("Capex", "capex", None, "XBRL"),
}


def local_concept(value: str) -> str:
    return value.rsplit(":", 1)[-1].lower()


def pattern_rank(concept: str, patterns: list[str]) -> int | None:
    for index, pattern in enumerate(patterns):
        if concept == pattern:
            return index * 100
        if pattern in concept:
            return index * 100 + 10
    return None


def display_unit(unit: str) -> str:
    normalized = (unit or "").strip()
    if not normalized:
        return "Unidad XBRL no informada"
    if normalized.startswith("iso4217:"):
        return f"{normalized.removeprefix('iso4217:')} · XBRL"
    return f"{normalized} · XBRL"


def empty_metrics() -> dict[str, dict[str, Any]]:
    return {
        key: {
            "label": definition["label"],
            "unit": definition["unit"],
            "tone": definition["tone"],
            "values": [],
            "change": None,
            "periods": [],
            "source": "CMF XBRL",
            "sourceUnit": [],
        }
        for key, definition in METRICS.items()
    }


def build_metrics(rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    result = empty_metrics()
    for key, definition in METRICS.items():
        selected: dict[str, tuple[int, float, str]] = {}
        for row in rows:
            if row["value_numeric"] is None or not row["period_end"]:
                continue
            concept = local_concept(row["concept"])
            rank = pattern_rank(concept, definition["patterns"])
            if rank is None:
                continue
            try:
                value = float(row["value_numeric"])
            except (TypeError, ValueError):
                continue
            dimensions = row["dimensions_json"] or "{}"
            rank = rank * 10 + (100 if dimensions not in {"", "{}"} else 0)
            period_end = row["period_end"]
            candidate = (rank, value, row["unit"] or "")
            if period_end not in selected or rank < selected[period_end][0]:
                selected[period_end] = candidate

        series = sorted((period, value[1], value[2]) for period, value in selected.items())
        values = [value for _, value, _ in series]
        units = sorted({unit for _, _, unit in series if unit})
        result[key].update(
            {
                "unit": display_unit(units[0]) if len(units) == 1 else ("Múltiples unidades XBRL" if units else definition["unit"]),
                "sourceUnit": units if len(units) != 1 else units[0],
                "values": values,
                "periods": [period for period, _, _ in series],
                "change": f"{((values[-1] / values[-2]) - 1) * 100:.1f}%" if len(values) >= 2 and values[-2] != 0 else None,
            }
        )
    return result


def finalize_metrics(selected_by_metric: dict[str, dict[str, tuple[int, float, str]]]) -> dict[str, dict[str, Any]]:
    result = empty_metrics()
    for key, definition in METRICS.items():
        selected = selected_by_metric[key]
        series = sorted((period, value[1], value[2]) for period, value in selected.items())
        values = [value for _, value, _ in series]
        units = sorted({unit for _, _, unit in series if unit})
        result[key].update(
            {
                "unit": display_unit(units[0]) if len(units) == 1 else ("Múltiples unidades XBRL" if units else definition["unit"]),
                "sourceUnit": units if len(units) != 1 else units[0],
                "values": values,
                "periods": [period for period, _, _ in series],
                "change": f"{((values[-1] / values[-2]) - 1) * 100:.1f}%" if len(values) >= 2 and values[-2] != 0 else None,
            }
        )
    return result


def empty_ratios() -> dict[str, dict[str, Any]]:
    return {
        key: {
            "label": definition[0],
            "value": None,
            "unit": definition[3],
            "period": None,
            "source": "CMF XBRL",
            "available": False,
            "series": [],
        }
        for key, definition in RATIO_DEFINITIONS.items()
    }


def selected_series(
    selected: dict[str, tuple[int, float, str, str | None, str | None]],
    *,
    scale: float = 1.0,
) -> dict[str, float]:
    return {period: value[1] * scale for period, value in selected.items()}


def ratio_series(
    label: str,
    unit: str,
    values: dict[str, float],
    *,
    multiplier: float = 1.0,
) -> dict[str, Any]:
    series = [{"period": period, "value": round(value * multiplier, 6)} for period, value in sorted(values.items())]
    latest = series[-1] if series else None
    return {
        "label": label,
        "value": latest["value"] if latest else None,
        "unit": unit,
        "period": latest["period"] if latest else None,
        "source": "CMF XBRL",
        "available": bool(series),
        "series": series,
    }


def finalize_ratios(
    selected_facts: dict[str, dict[str, tuple[int, float, str, str | None, str | None]]],
    metrics: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    facts = {key: selected_series(value) for key, value in selected_facts.items()}
    income = {period: value for period, value in zip(metrics["income"]["periods"], metrics["income"]["values"])}
    ebit = facts.get("ebit", {})
    if not ebit:
        ebit = {period: value for period, value in zip(metrics["ebit"]["periods"], metrics["ebit"]["values"])}
    da = facts.get("depreciation_amortization", {})
    ebitda = {period: ebit[period] + da[period] for period in ebit.keys() & da.keys()}
    if not ebitda:
        ebitda = {period: value for period, value in zip(metrics["ebitda"]["periods"], metrics["ebitda"]["values"])}
    facts["income"] = income
    facts["ebitda"] = ebitda
    facts["quick_assets"] = {
        period: facts.get("cash", {}).get(period, 0.0) + facts.get("receivables", {}).get(period, 0.0)
        for period in facts.get("current_liabilities", {})
        if period in facts.get("cash", {}) or period in facts.get("receivables", {})
    }
    facts["net_debt"] = {
        period: facts["debt"][period] - facts["cash"][period]
        for period in facts.get("debt", {}).keys() & facts.get("cash", {}).keys()
    }
    facts["invested_capital"] = {
        period: facts["debt"][period] + facts["equity"][period] - facts["cash"].get(period, 0.0)
        for period in facts.get("debt", {}).keys() & facts.get("equity", {}).keys()
    }
    facts["fcf"] = {
        period: facts["operating_cash_flow"][period] - abs(facts["capex"].get(period, 0.0))
        for period in facts.get("operating_cash_flow", {}).keys()
        if period in facts.get("capex", {})
    }

    result = empty_ratios()
    for key, (label, numerator_key, denominator_key, unit) in RATIO_DEFINITIONS.items():
        numerator = facts.get(numerator_key, {})
        denominator = facts.get(denominator_key, {}) if denominator_key else {}
        values: dict[str, float] = {}
        if key in {"netDebt", "fcf", "operatingCashFlow", "capex"}:
            values = numerator
        else:
            for period in numerator.keys() & denominator.keys():
                if denominator[period] == 0:
                    continue
                values[period] = numerator[period] / denominator[period]
        if key in {"roa", "roe", "roic"}:
            values = {period: value * 100 for period, value in values.items()}
        result[key] = ratio_series(label, unit, values)
    return result


def build(db_path: Path, output_path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        issuers: dict[str, dict[str, Any]] = {}
        for row in connection.execute("SELECT rut, name, status, source, retrieved_at FROM issuer ORDER BY rut"):
            issuers[row["rut"]] = {
                "name": row["name"],
                "status": row["status"],
                "source": row["source"],
                "retrievedAt": row["retrieved_at"],
                "hasXbrl": False,
                "metrics": empty_metrics(),
                "ratios": empty_ratios(),
                "ratings": [],
                "events": [],
                "riskFlags": [],
                "lineage": {"source": "CMF XBRL", "documents": []},
            }

        for rut in issuers:
            documents = connection.execute(
                """
                SELECT period, source_url, content_hash, retrieved_at
                FROM source_document
                WHERE issuer_rut = ?
                ORDER BY period DESC, statement_type
                """,
                (rut,),
            ).fetchall()
            issuers[rut]["lineage"]["documents"] = [
                {
                    "period": row["period"],
                    "sourceUrl": row["source_url"],
                    "contentHash": row["content_hash"],
                    "retrievedAt": row["retrieved_at"],
                }
                for row in documents
            ]

        selected_by_rut: dict[str, dict[str, dict[str, tuple[int, float, str]]]] = {
            rut: {key: {} for key in METRICS} for rut in issuers
        }
        selected_facts_by_rut: dict[str, dict[str, dict[str, tuple[int, float, str, str | None, str | None]]]] = {
            rut: {key: {} for key in RATIO_FACTS} for rut in issuers
        }
        fact_counts: dict[str, int] = {rut: 0 for rut in issuers}
        for row in connection.execute(
            """
            SELECT issuer_rut, concept, period_start, period_end, instant, unit, value_numeric, dimensions_json
            FROM xbrl_fact
            """
        ):
            rut = row["issuer_rut"]
            if rut not in selected_by_rut:
                continue
            fact_counts[rut] += 1
            if row["value_numeric"] is None or not row["period_end"]:
                continue
            concept = local_concept(row["concept"])
            try:
                value = float(row["value_numeric"])
            except (TypeError, ValueError):
                continue
            dimensions = row["dimensions_json"] or "{}"
            for key, definition in METRICS.items():
                rank = pattern_rank(concept, definition["patterns"])
                if rank is None:
                    continue
                rank = rank * 10 + (100 if dimensions not in {"", "{}"} else 0)
                period_end = row["period_end"]
                candidate = (rank, value, row["unit"] or "")
                selected = selected_by_rut[rut][key]
                if period_end not in selected or rank < selected[period_end][0]:
                    selected[period_end] = candidate

            for key, definition in RATIO_FACTS.items():
                rank = pattern_rank(concept, definition["patterns"])
                if rank is None:
                    continue
                period_key = row["instant"] if definition["kind"] == "balance" and row["instant"] else row["period_end"]
                if not period_key:
                    continue
                rank = rank * 100 + (100 if dimensions not in {"", "{}"} else 0)
                if definition["kind"] == "balance" and not row["instant"]:
                    rank += 20
                candidate = (rank, value, row["unit"] or "", row["period_start"], row["instant"])
                selected = selected_facts_by_rut[rut][key]
                if period_key not in selected or rank < selected[period_key][0]:
                    selected[period_key] = candidate

        for rut, payload in issuers.items():
            payload["hasXbrl"] = fact_counts[rut] > 0
            metrics = finalize_metrics(selected_by_rut[rut])
            derived_selected = {key: {} for key in METRICS}
            ebit_facts = selected_facts_by_rut[rut]["ebit"]
            da_facts = selected_facts_by_rut[rut]["depreciation_amortization"]
            if not metrics["ebit"]["values"]:
                derived_selected["ebit"] = {
                    period: (fact[0], fact[1], fact[2]) for period, fact in ebit_facts.items()
                }
            ebit_values = {period: fact[1] for period, fact in ebit_facts.items()}
            da_values = {period: fact[1] for period, fact in da_facts.items()}
            if not metrics["ebitda"]["values"]:
                derived_selected["ebitda"] = {
                    period: (0, ebit_values[period] + da_values[period], fact[2])
                    for period, fact in ebit_facts.items()
                    if period in da_values
                }
            derived_metrics = finalize_metrics(derived_selected)
            for key in ("ebit", "ebitda"):
                if not metrics[key]["values"] and derived_metrics[key]["values"]:
                    metrics[key] = derived_metrics[key]
            payload["metrics"] = metrics
            payload["ratios"] = finalize_ratios(selected_facts_by_rut[rut], metrics)

        result = {
            "schemaVersion": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "CMF XBRL",
            "periods": {"from": "202003", "to": "202612"},
            "issuerCount": len(issuers),
            "issuers": issuers,
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = output_path.with_suffix(output_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        temporary.replace(output_path)
        return {
            "issuers": len(issuers),
            "with_xbrl": sum(1 for payload in issuers.values() if payload["hasXbrl"]),
            "output_bytes": output_path.stat().st_size,
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Construye el read model gratuito desde CMF XBRL")
    parser.add_argument("--db", type=Path, default=Path("data/cmf/cmf.db"))
    parser.add_argument("--output", type=Path, default=Path("public/data/cmf-financials.json"))
    args = parser.parse_args()
    print(json.dumps(build(args.db, args.output), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
