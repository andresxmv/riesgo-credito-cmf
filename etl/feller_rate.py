"""Incremental public extractor for Feller Rate Chile.

Feller exposes a public issuer profile with links to the issuer's historical
classification releases. This job discovers those profiles, parses only
structured credit fields, and keeps a source URL for every observation. It
does not store or republish the full copyrighted report text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from lxml import html
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter


BASE_URL = "https://www.feller-rate.cl"
INDEX_URL = f"{BASE_URL}/clasificacion-area/CL/16/"
USER_AGENT = "CMF-CreditView/0.2 (+public-credit-etl)"
MONTHS = {
    "JANUARY": 1,
    "FEBRUARY": 2,
    "MARCH": 3,
    "APRIL": 4,
    "MAY": 5,
    "JUNE": 6,
    "JULY": 7,
    "AUGUST": 8,
    "SEPTEMBER": 9,
    "OCTOBER": 10,
    "NOVEMBER": 11,
    "DECEMBER": 12,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def absolute_url(value: str) -> str:
    return urljoin(BASE_URL, value)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, TimeoutError)),
    stop=stop_after_attempt(4),
    wait=wait_exponential_jitter(initial=1, max=12),
    reraise=True,
)
def fetch_text(url: str, *, method: str = "GET", data: dict[str, str] | None = None) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
    with httpx.Client(timeout=45, follow_redirects=True, headers=headers) as client:
        response = client.request(method, url, data=data)
        response.raise_for_status()
        return response.text


def parse_profile_links(source: str) -> dict[str, dict[str, str]]:
    tree = html.fromstring(source)
    profiles: dict[str, dict[str, str]] = {}
    for anchor in tree.xpath('//a[contains(@href, "/clasificacion-riesgo/")]'):
        href = anchor.get("href", "")
        match = re.search(r"/clasificacion-riesgo/(\d+)/([^/?#]+)", href)
        if not match:
            continue
        profile_id, slug = match.groups()
        name = clean_text(" ".join(anchor.xpath(".//text()"))).replace(" (CL)", "")
        name = re.sub(r"\s+info\s*$", "", name, flags=re.IGNORECASE)
        profiles[profile_id] = {
            "profileId": profile_id,
            "slug": slug,
            "name": name,
            "profileUrl": absolute_url(href),
        }
    return profiles


def discover_profiles() -> dict[str, dict[str, str]]:
    profiles: dict[str, dict[str, str]] = {}
    for page in range(1, 11):
        if page == 1:
            source = fetch_text(INDEX_URL)
        else:
            source = fetch_text(
                INDEX_URL,
                method="POST",
                data={
                    "paginaclas": str(page),
                    "areas": "16",
                    "fe": "",
                    "Nemo": "",
                    "tipo": "",
                    "TipoInstrumento": "",
                    "accionclas": "",
                    "tex": "",
                    "pais_busca2": "",
                    "pais": "CL",
                },
            )
        profiles.update(parse_profile_links(source))
    return profiles


def parse_report_links(source: str, profile_id: str | None = None) -> list[str]:
    tree = html.fromstring(source)
    links = set()
    for href in tree.xpath('//a[contains(@href, "/clasificacion-cp/")]/@href'):
        match = re.search(r"/clasificacion-cp/(\d+)/(\d+)/", href)
        if match and (profile_id is None or match.group(1) == profile_id):
            links.add(absolute_url(href))
    return sorted(links)


def parse_date(text: str) -> str | None:
    match = re.search(r"\b(\d{1,2})\s+([A-Z]+)\s+(\d{4})\b", text.upper())
    if not match or match.group(2) not in MONTHS:
        return None
    day, month, year = int(match.group(1)), MONTHS[match.group(2)], int(match.group(3))
    return f"{year:04d}-{month:02d}-{day:02d}"


def class_values(row: Any, class_name: str) -> str:
    values = row.xpath(
        ".//*[contains(concat(' ', normalize-space(@class), ' '), $class_name)]//text()",
        class_name=f" {class_name} ",
    )
    return clean_text(" ".join(values))


def parse_rating_rows(tree: Any) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for instrument in tree.xpath(
        "//*[contains(concat(' ', normalize-space(@class), ' '), ' clasif_empresa_inst ')]"
    ):
        ancestors = instrument.xpath(
            "ancestor::*[.//*[contains(concat(' ', normalize-space(@class), ' '), ' clasif_empresa_date ')]]"
        )
        row = ancestors[0] if ancestors else instrument.getparent()
        if row is None:
            continue
        values = {
            "instrument": clean_text(" ".join(instrument.xpath(".//text()"))),
            "date": class_values(row, "clasif_empresa_date"),
            "rating": class_values(row, "clasif_empresa_categ"),
            "outlook": class_values(row, "clasif_empresa_persp"),
        }
        if not values["instrument"] or not values["rating"]:
            continue
        key = tuple(values[name] for name in ("instrument", "date", "rating", "outlook"))
        if key not in seen:
            rows.append(values)
            seen.add(key)
    return rows


SIGNAL_GROUPS: dict[str, tuple[str, ...]] = {
    "business_profile": ("perfil de negocio", "diversificación", "backlog", "posición competitiva", "industria"),
    "financial_profile": ("posición financiera", "margen", "ebitda", "generación de flujos"),
    "liquidity": ("liquidez", "caja", "capital de trabajo", "flujo operacional"),
    "leverage": ("endeudamiento", "deuda financiera", "deuda neta", "cobertura", "apalancamiento"),
    "refinancing": ("refinanciamiento", "vencimiento", "acceso al mercado", "bonos"),
    "governance": ("controlador", "propiedad", "gobierno corporativo"),
}


def technical_signals(body_text: str) -> dict[str, Any]:
    lowered = body_text.casefold()
    topics = [name for name, words in SIGNAL_GROUPS.items() if any(word in lowered for word in words)]
    return {
        "topics": topics,
        "hasBaseScenario": "escenario base" in lowered,
        "hasDownsideScenario": "escenario de baja" in lowered or "escenario baj" in lowered,
        "hasUpsideScenario": "escenario de alza" in lowered or "escenario alcista" in lowered,
        "hasAnalystTeam": "equipo de análisis" in lowered,
    }


def parse_report(report_url: str, source: str) -> dict[str, Any]:
    tree = html.fromstring(source)
    body_text = clean_text(" ".join(tree.xpath("//body//text()")))
    heading = tree.xpath("//h2[1]")
    title = clean_text(" ".join(heading[0].xpath(".//text()"))) if heading else ""
    article = heading[0].getparent() if heading else None
    article_text = clean_text(" ".join(article.xpath(".//text()"))) if article is not None else body_text
    meta = tree.xpath('//meta[@name="description"]/@content')
    if not title and meta:
        title = clean_text(meta[0])
    report_match = re.search(r"/clasificacion-cp/(\d+)/(\d+)/([^/?#]+)", report_url)
    if not report_match:
        raise ValueError(f"URL Feller no reconocida: {report_url}")
    profile_id, report_id, slug = report_match.groups()
    pdf_links = tree.xpath('//a[contains(@href, "/comunicado-pdf/")]/@href')
    pdf_url = absolute_url(pdf_links[0]) if pdf_links else f"{BASE_URL}/comunicado-pdf/{profile_id}/{report_id}/{slug.removesuffix('-sa')}"
    published_at = parse_date(article_text) or parse_date(body_text)
    rating_pattern = r"(?:AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|CCC[+-]?|CC[+-]?|C|D)"
    quoted_ratings = re.findall(rf"[\"“']\s*({rating_pattern})\s*[\"”']", f"{title} {article_text}", re.IGNORECASE)
    rating = quoted_ratings[-1].upper() if quoted_ratings else None
    outlook_match = re.search(
        r"perspectivas?(?:\s+de\s+la\s+clasificaci[oó]n)?\s+(?:son|se mantienen|mantiene|asigna|asignó|cambian?\s+a|cambia\s+a|pasan?\s+a)\s+[\"“']([^\"”']+)",
        article_text,
        re.IGNORECASE,
    )
    if not outlook_match:
        outlook_match = re.search(r"perspectivas?\s*:\s*([A-Za-záéíóúÁÉÍÓÚ ]+)", article_text, re.IGNORECASE)
    outlook = clean_text(outlook_match.group(1)) if outlook_match else None
    rows = parse_rating_rows(tree)
    if not rows and (rating or outlook):
        rows = [{"instrument": "Solvencia", "date": published_at or "", "rating": rating or "", "outlook": outlook or ""}]
    solvency = next((row for row in rows if "solvencia" in row["instrument"].casefold()), rows[0] if rows else {})
    watch = None
    watch_match = re.search(r"\b(CW\s*(?:Pos|Neg|En desarrollo)?|Creditwatch[^.]*)", article_text, re.IGNORECASE)
    if watch_match:
        watch = clean_text(watch_match.group(1))
    return {
        "profileId": profile_id,
        "reportId": report_id,
        "slug": slug,
        "publishedAt": published_at,
        "title": title,
        "rating": solvency.get("rating"),
        "outlook": solvency.get("outlook"),
        "watch": watch,
        "classificationRows": rows,
        "technicalSignals": technical_signals(article_text),
        "sourceUrl": report_url,
        "pdfUrl": pdf_url,
        "contentHash": sha256(source),
        "retrievedAt": utc_now(),
    }


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def collect(output_path: Path, cache_path: Path, *, refresh: bool = False) -> dict[str, Any]:
    cache = load_json(cache_path, {"reports": {}})
    profiles = discover_profiles()
    profile_reports: dict[str, list[str]] = {}

    def profile_task(profile: dict[str, str]) -> tuple[str, list[str]]:
        source = fetch_text(profile["profileUrl"])
        return profile["profileId"], parse_report_links(source, profile["profileId"])

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(profile_task, profile) for profile in profiles.values()]
        for future in as_completed(futures):
            profile_id, links = future.result()
            profile_reports[profile_id] = links

    report_urls = sorted({url for links in profile_reports.values() for url in links})
    reports: dict[str, dict[str, Any]] = {}

    def report_task(url: str) -> tuple[str, dict[str, Any]]:
        if not refresh and url in cache.get("reports", {}):
            return url, cache["reports"][url]
        return url, parse_report(url, fetch_text(url))

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(report_task, url) for url in report_urls]
        for future in as_completed(futures):
            url, report = future.result()
            reports[url] = report

    cache["reports"] = reports
    save_json(cache_path, cache)
    profile_payloads = []
    for profile_id, profile in sorted(profiles.items(), key=lambda item: item[1]["name"].casefold()):
        profile_payloads.append(
            {
                **profile,
                "reports": sorted(
                    [reports[url] for url in profile_reports.get(profile_id, []) if url in reports],
                    key=lambda report: report.get("publishedAt") or "",
                    reverse=True,
                ),
            }
        )
    result = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "source": "Feller Rate",
        "profileCount": len(profile_payloads),
        "reportCount": sum(len(profile["reports"]) for profile in profile_payloads),
        "profiles": profile_payloads,
    }
    save_json(output_path, result)
    return {"profiles": len(profile_payloads), "reports": result["reportCount"], "output": str(output_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Extrae informes públicos de Feller Rate por emisor")
    parser.add_argument("--output", type=Path, default=Path("data/feller/feller_rate.json"))
    parser.add_argument("--cache", type=Path, default=Path("data/feller/cache.json"))
    parser.add_argument("--refresh", action="store_true", help="vuelve a descargar informes ya cacheados")
    args = parser.parse_args()
    print(json.dumps(collect(args.output, args.cache, refresh=args.refresh), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
