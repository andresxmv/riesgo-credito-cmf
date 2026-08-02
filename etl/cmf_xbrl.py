from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import re
import sqlite3
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode, urljoin

import httpx
from lxml import etree
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter


LOGGER = logging.getLogger("cmf.etl")
CMF_BASE = "https://www.cmfchile.cl"
CATALOG_URL = f"{CMF_BASE}/institucional/mercados/consulta.php?Estado=VI&entidad=RVEMI&mercado=V"
ENTITY_PATH = "/institucional/mercados/entidad.php"
USER_AGENT = "CMF-CreditView/0.1 (+public-data-etl)"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def prefixed_name(element: etree._Element) -> str:
    name = local_name(element.tag)
    return f"{element.prefix}:{name}" if element.prefix else name


def rut_key(value: str) -> str:
    normalized = value.replace(".", "").upper()
    # The CMF download endpoint uses the numeric RUT body. The local catalog
    # may include the verifier after a hyphen, so remove it before requests.
    if "-" in normalized:
        normalized = normalized.split("-", 1)[0]
    return re.sub(r"[^0-9]", "", normalized)


@dataclass(frozen=True)
class Issuer:
    rut: str
    name: str
    status: str = "Vigente"


@dataclass(frozen=True)
class Period:
    year: int
    month: int

    @property
    def code(self) -> str:
        return f"{self.year:04d}{self.month:02d}"


@dataclass
class SourceDocument:
    issuer_rut: str
    period: str
    statement_type: str
    page_url: str
    source_url: str
    content_hash: str
    local_path: str
    retrieved_at: str


class ManifestStore:
    """SQLite manifest: controla idempotencia y conserva los hechos normalizados."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS source_document (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              issuer_rut TEXT NOT NULL,
              period TEXT NOT NULL,
              statement_type TEXT NOT NULL,
              page_url TEXT NOT NULL,
              source_url TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              local_path TEXT NOT NULL,
              retrieved_at TEXT NOT NULL,
              UNIQUE (issuer_rut, period, statement_type)
            );
            CREATE TABLE IF NOT EXISTS xbrl_fact (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_document_id INTEGER NOT NULL REFERENCES source_document(id),
              issuer_rut TEXT NOT NULL,
              statement_type TEXT NOT NULL,
              concept TEXT NOT NULL,
              context_id TEXT NOT NULL,
              period_start TEXT,
              period_end TEXT,
              instant TEXT,
              unit TEXT,
              decimals TEXT,
              value_numeric TEXT,
              value_text TEXT,
              dimensions_json TEXT NOT NULL,
              source_url TEXT NOT NULL,
              UNIQUE (source_document_id, context_id, concept, dimensions_json)
            );
            CREATE INDEX IF NOT EXISTS idx_source_issuer_period
              ON source_document(issuer_rut, period, statement_type);
            CREATE INDEX IF NOT EXISTS idx_fact_issuer_period
              ON xbrl_fact(issuer_rut, period_end, concept);
            """
        )
        self.connection.commit()

    def existing_document(self, issuer_rut: str, period: str, statement_type: str) -> sqlite3.Row | None:
        return self.connection.execute(
            "SELECT * FROM source_document WHERE issuer_rut = ? AND period = ? AND statement_type = ?",
            (issuer_rut, period, statement_type),
        ).fetchone()

    def save_document(self, document: SourceDocument) -> int:
        self.connection.execute(
            """
            INSERT INTO source_document
              (issuer_rut, period, statement_type, page_url, source_url, content_hash, local_path, retrieved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (issuer_rut, period, statement_type) DO UPDATE SET
              page_url = excluded.page_url,
              source_url = excluded.source_url,
              content_hash = excluded.content_hash,
              local_path = excluded.local_path,
              retrieved_at = excluded.retrieved_at
            """,
            (
                document.issuer_rut,
                document.period,
                document.statement_type,
                document.page_url,
                document.source_url,
                document.content_hash,
                document.local_path,
                document.retrieved_at,
            ),
        )
        row = self.existing_document(document.issuer_rut, document.period, document.statement_type)
        if row is None:
            raise RuntimeError("No se pudo registrar el documento CMF")
        self.connection.commit()
        return int(row["id"])

    def replace_facts(self, document_id: int, facts: Iterable[dict[str, Any]]) -> int:
        self.connection.execute("DELETE FROM xbrl_fact WHERE source_document_id = ?", (document_id,))
        rows = [
            (
                document_id,
                fact["issuer_rut"],
                fact["statement_type"],
                fact["concept"],
                fact["context_id"],
                fact["period_start"],
                fact["period_end"],
                fact["instant"],
                fact["unit"],
                fact["decimals"],
                fact["value_numeric"],
                fact["value_text"],
                json.dumps(fact["dimensions"], ensure_ascii=False, sort_keys=True),
                fact["source_url"],
            )
            for fact in facts
        ]
        self.connection.executemany(
            """
            INSERT INTO xbrl_fact
              (source_document_id, issuer_rut, statement_type, concept, context_id,
               period_start, period_end, instant, unit, decimals, value_numeric,
               value_text, dimensions_json, source_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        self.connection.commit()
        return len(rows)

    def close(self) -> None:
        self.connection.close()


def parse_number(text: str | None, attributes: dict[str, str]) -> str | None:
    if text is None or not text.strip() or attributes.get("nil", "false").lower() == "true":
        return None
    normalized = text.strip().replace(" ", "").replace(",", ".")
    try:
        value = Decimal(normalized)
        if attributes.get("sign") == "-":
            value = -value
        scale = int(attributes.get("scale", "0"))
        if scale:
            value *= Decimal(10) ** scale
        return str(value)
    except (InvalidOperation, ValueError):
        return None


def parse_xbrl(xml_bytes: bytes, source_url: str, issuer_rut: str, statement_type: str) -> list[dict[str, Any]]:
    parser = etree.XMLParser(recover=True, huge_tree=True, remove_comments=True)
    root = etree.fromstring(xml_bytes, parser=parser)
    contexts: dict[str, dict[str, Any]] = {}
    for element in root.xpath("//*[local-name()='context']"):
        context_id = element.get("id", "")
        identifier = element.xpath("string(.//*[local-name()='identifier'])").strip()
        instant = element.xpath("string(.//*[local-name()='instant'])").strip() or None
        start = element.xpath("string(.//*[local-name()='startDate'])").strip() or None
        end = element.xpath("string(.//*[local-name()='endDate'])").strip() or None
        dimensions = {
            member.get("dimension", ""): (member.text or "").strip()
            for member in element.xpath(".//*[local-name()='explicitMember']")
            if member.get("dimension")
        }
        contexts[context_id] = {
            "identifier": identifier,
            "instant": instant,
            "period_start": start,
            "period_end": end or instant,
            "dimensions": dimensions,
        }

    units: dict[str, str] = {}
    for element in root.xpath("//*[local-name()='unit']"):
        unit_id = element.get("id", "")
        measures = [value.strip() for value in element.xpath(".//*[local-name()='measure']/text()") if value.strip()]
        units[unit_id] = "/".join(measures)

    facts: list[dict[str, Any]] = []
    for element in root.iter():
        context_id = element.get("contextRef")
        if not context_id or context_id not in contexts:
            continue
        context = contexts[context_id]
        text = "".join(element.itertext()).strip()
        attributes = {local_name(key): value for key, value in element.attrib.items()}
        facts.append(
            {
                "issuer_rut": issuer_rut,
                "statement_type": statement_type,
                "concept": prefixed_name(element),
                "context_id": context_id,
                "period_start": context["period_start"],
                "period_end": context["period_end"],
                "instant": context["instant"],
                "unit": units.get(attributes.get("unitRef", "")),
                "decimals": attributes.get("decimals"),
                "value_numeric": parse_number(text, attributes),
                "value_text": text or None,
                "dimensions": context["dimensions"],
                "source_url": source_url,
            }
        )
    return facts


def parse_issuer_catalog(html: bytes) -> list[Issuer]:
    parser = etree.HTMLParser(recover=True, encoding="utf-8")
    root = etree.fromstring(html, parser=parser)
    issuers: list[Issuer] = []
    seen: set[str] = set()
    for row in root.xpath("//tr[.//a[contains(@href, 'rut=')]]"):
        links = row.xpath(".//a[contains(@href, 'rut=')]")
        if len(links) < 2:
            continue
        href = links[0].get("href", "")
        rut_match = re.search(r"[?&]rut=([^&#]+)", href, flags=re.IGNORECASE)
        rut_text = rut_match.group(1) if rut_match else " ".join(links[0].itertext()).strip()
        name = " ".join(links[1].itertext()).strip()
        key = rut_key(rut_text)
        if not key or not name or key in seen:
            continue
        status = " ".join(row.xpath(".//td[last()]/text()")) or "Vigente"
        issuers.append(Issuer(rut=key, name=name, status=status.strip()))
        seen.add(key)
    return issuers


class CmfXbrlClient:
    def __init__(self, store: ManifestStore, raw_dir: Path, timeout: float = 90.0) -> None:
        self.store = store
        self.raw_dir = raw_dir
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=30),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/zip,*/*"},
        )

    @retry(
        retry=retry_if_exception_type((httpx.HTTPError, OSError)),
        wait=wait_exponential_jitter(initial=1, max=20),
        stop=stop_after_attempt(4),
        reraise=True,
    )
    def get(self, url: str) -> httpx.Response:
        response = self.client.get(url)
        response.raise_for_status()
        return response

    def issuer_page_url(self, rut: str, period: Period, statement_type: str) -> str:
        query = urlencode(
            {
                "aa": period.year,
                "auth": "",
                "control": "svs",
                "mercado": "V",
                "mm": f"{period.month:02d}",
                "pestania": 3,
                "rut": re.sub(r"[^0-9]", "", rut),
                "tipo": statement_type,
                "tipo_norma": "IFRS",
                "tipoentidad": "RVEMI",
                "vig": "VI",
            }
        )
        return f"{CMF_BASE}{ENTITY_PATH}?{query}"

    def catalog(self) -> list[Issuer]:
        return parse_issuer_catalog(self.get(CATALOG_URL).content)

    def find_xbrl_url(self, page_url: str, html: bytes) -> str | None:
        parser = etree.HTMLParser(recover=True, encoding="utf-8")
        root = etree.fromstring(html, parser=parser)
        links = root.xpath(
            "//a[contains(normalize-space(string(.)), 'Estados financieros (XBRL)')]/@href"
        )
        return urljoin(page_url, links[0]) if links else None

    def extract_xbrl(self, archive: bytes, source_url: str, issuer_rut: str, statement_type: str) -> list[dict[str, Any]]:
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            names = [name for name in zipped.namelist() if name.lower().endswith((".xbrl", ".xml"))]
            names = [name for name in names if "dimension" not in name.lower() and "dim_" not in name.lower()]
            if not names:
                raise ValueError("El ZIP XBRL de CMF no contiene un archivo de instancia .xbrl/.xml")
            xml_bytes = zipped.read(sorted(names, key=lambda name: (not name.lower().endswith(".xbrl"), name))[0])
        return parse_xbrl(xml_bytes, source_url, issuer_rut, statement_type)

    def ingest_period(self, issuer: Issuer, period: Period, statement_type: str = "C", force: bool = False) -> dict[str, Any]:
        rut = rut_key(issuer.rut)
        existing = self.store.existing_document(rut, period.code, statement_type)
        if existing and not force and Path(existing["local_path"]).exists():
            return {"status": "skipped", "rut": rut, "period": period.code, "facts": self._fact_count(int(existing["id"]))}

        page_url = self.issuer_page_url(rut, period, statement_type)
        page_response = self.get(page_url)
        source_url = self.find_xbrl_url(page_url, page_response.content)
        if not source_url:
            return {"status": "missing", "rut": rut, "period": period.code, "facts": 0}

        archive = self.get(source_url).content
        content_hash = hashlib.sha256(archive).hexdigest()
        target_dir = self.raw_dir / rut
        target_dir.mkdir(parents=True, exist_ok=True)
        local_path = target_dir / f"{period.code}_{statement_type}_{content_hash[:16]}.zip"
        if not local_path.exists():
            local_path.write_bytes(archive)
        document = SourceDocument(
            issuer_rut=rut,
            period=period.code,
            statement_type=statement_type,
            page_url=page_url,
            source_url=source_url,
            content_hash=content_hash,
            local_path=str(local_path),
            retrieved_at=utc_now(),
        )
        document_id = self.store.save_document(document)
        facts = self.extract_xbrl(archive, source_url, rut, statement_type)
        count = self.store.replace_facts(document_id, facts)
        return {"status": "ingested", "rut": rut, "period": period.code, "facts": count, "source_url": source_url}

    def _fact_count(self, document_id: int) -> int:
        row = self.store.connection.execute("SELECT count(*) AS count FROM xbrl_fact WHERE source_document_id = ?", (document_id,)).fetchone()
        return int(row["count"] if row else 0)

    def close(self) -> None:
        self.client.close()


def periods_for_years(years: Iterable[int], months: Iterable[int]) -> list[Period]:
    return [Period(year, month) for year in years for month in months]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingesta incremental de XBRL IFRS publicado por la CMF")
    parser.add_argument("--data-dir", type=Path, default=Path("data/cmf"))
    parser.add_argument("--rut")
    parser.add_argument("--year", type=int, default=datetime.now().year)
    parser.add_argument("--month", type=int, default=3)
    parser.add_argument("--balance", choices=["C", "I"], default="C")
    parser.add_argument("--all", action="store_true", dest="all_issuers")
    parser.add_argument("--from-year", type=int)
    parser.add_argument("--to-year", type=int)
    parser.add_argument("--months", default="3,6,9,12")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv or sys.argv[1:])
    db_path = args.data_dir / "cmf.db"
    store = ManifestStore(db_path)
    client = CmfXbrlClient(store, args.data_dir / "raw")
    try:
        if args.all_issuers:
            issuers = client.catalog()
        elif args.rut:
            issuers = [Issuer(args.rut, args.rut)]
        else:
            raise SystemExit("Usa --rut RUT o --all")
        years = range(args.from_year or args.year, (args.to_year or args.year) + 1)
        months = [int(value) for value in args.months.split(",")] if args.all_issuers else [args.month]
        results = []
        for issuer in issuers:
            for period in periods_for_years(years, months):
                try:
                    result = client.ingest_period(issuer, period, args.balance, args.force)
                    results.append(result)
                    LOGGER.info("%s %s %s facts=%s", result["status"], result["rut"], result["period"], result["facts"])
                except Exception:
                    LOGGER.exception("Fallo ingestando RUT %s período %s", issuer.rut, period.code)
        print(json.dumps({"results": results, "ingested": sum(item["status"] == "ingested" for item in results)}, ensure_ascii=False))
        return 0
    finally:
        client.close()
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
