from api import main as api_main
from etl.cmf_xbrl import ManifestStore, SourceDocument
from fastapi.testclient import TestClient


def test_financials_endpoint_returns_cmf_xbrl_units(tmp_path):
    db_path = tmp_path / "cmf.db"
    store = ManifestStore(db_path)
    document_id = store.save_document(
        SourceDocument(
            issuer_rut="61704000",
            period="202503",
            statement_type="C",
            page_url="https://www.cmfchile.cl/entity",
            source_url="https://www.cmfchile.cl/file.zip",
            content_hash="real-hash",
            local_path=str(tmp_path / "file.zip"),
            retrieved_at="2026-08-01T00:00:00+00:00",
        )
    )
    facts = []
    for context_id, period_end, value in [("q1", "2025-03-31", "100"), ("q2", "2025-06-30", "120")]:
        facts.append({
            "issuer_rut": "61704000",
            "statement_type": "C",
            "concept": "cl-ci:Revenue",
            "context_id": context_id,
            "period_start": "2025-01-01",
            "period_end": period_end,
            "instant": None,
            "unit": "iso4217:USD",
            "decimals": "-3",
            "value_numeric": value,
            "value_text": value,
            "dimensions": {},
            "source_url": "https://www.cmfchile.cl/file.zip",
        })
    store.replace_facts(document_id, facts)
    store.close()

    original_path = api_main.DB_PATH
    api_main.DB_PATH = db_path
    try:
        response = TestClient(api_main.app).get("/api/issuer/61704000/financials")
    finally:
        api_main.DB_PATH = original_path

    assert response.status_code == 200
    payload = response.json()
    assert payload["hasXbrl"] is True
    assert payload["metrics"]["revenue"]["values"] == [100.0, 120.0]
    assert payload["metrics"]["revenue"]["unit"] == "USD · XBRL"
    assert payload["lineage"]["documents"][0]["contentHash"] == "real-hash"


def test_clean_rut_removes_verifier():
    assert api_main.clean_rut("93.834.000-5") == "93834000"
