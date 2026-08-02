from etl.cmf_xbrl import Issuer, ManifestStore, SourceDocument, parse_issuer_catalog, parse_number, parse_xbrl


def test_parse_number_honors_sign_and_scale():
    assert parse_number("1,25", {"scale": "3"}) == "1250.00"
    assert parse_number("10", {"sign": "-"}) == "-10"
    assert parse_number("nil", {"nil": "true"}) is None


def test_parse_xbrl_keeps_context_unit_and_dimensions():
    xml = b"""
    <xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:cl-ci="http://www.cmfchile.cl/cl-ci/2025-01-01"
      xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
      <xbrli:context id="q1">
        <xbrli:entity><xbrli:identifier scheme="urn:cmf">61704000</xbrli:identifier></xbrli:entity>
        <xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period>
        <xbrli:scenario><xbrldi:explicitMember dimension="cl-ci:SegmentAxis">cl-ci:RetailMember</xbrldi:explicitMember></xbrli:scenario>
      </xbrli:context>
      <xbrli:unit id="clp"><xbrli:measure>iso4217:CLP</xbrli:measure></xbrli:unit>
      <cl-ci:Revenue contextRef="q1" unitRef="clp" decimals="-3" scale="3">1,25</cl-ci:Revenue>
    </xbrli:xbrl>
    """

    facts = parse_xbrl(xml, "https://www.cmfchile.cl/source.zip", "61704000", "C")

    assert len(facts) == 1
    assert facts[0]["concept"] == "cl-ci:Revenue"
    assert facts[0]["period_end"] == "2025-03-31"
    assert facts[0]["unit"] == "iso4217:CLP"
    assert facts[0]["value_numeric"] == "1250.00"
    assert facts[0]["dimensions"] == {"cl-ci:SegmentAxis": "cl-ci:RetailMember"}


def test_parse_issuer_catalog_deduplicates_ruts():
    html = b"""
    <table>
      <tr><td><a href="entidad.php?rut=61704000">61.704.000-0</a></td><td><a href="entidad.php?rut=61704000">CENCOSUD S.A.</a></td><td>Vigente</td></tr>
      <tr><td><a href="entidad.php?rut=96509970">96.509.970-K</a></td><td><a href="entidad.php?rut=96509970">ABC S.A.</a></td><td>Vigente</td></tr>
      <tr><td><a href="entidad.php?rut=61704000">61.704.000-0</a></td><td><a href="entidad.php?rut=61704000">Duplicado</a></td><td>Vigente</td></tr>
    </table>
    """

    issuers = parse_issuer_catalog(html)

    assert issuers == [Issuer("61704000", "CENCOSUD S.A.", "Vigente"), Issuer("96509970", "ABC S.A.", "Vigente")]


def test_manifest_store_reuses_document_and_facts(tmp_path):
    store = ManifestStore(tmp_path / "cmf.db")
    document = SourceDocument(
        issuer_rut="61704000",
        period="202503",
        statement_type="C",
        page_url="https://cmf/page",
        source_url="https://cmf/file.zip",
        content_hash="abc123",
        local_path=str(tmp_path / "file.zip"),
        retrieved_at="2026-08-01T00:00:00+00:00",
    )
    document_id = store.save_document(document)
    store.replace_facts(
        document_id,
        [{
            "issuer_rut": "61704000",
            "statement_type": "C",
            "concept": "cl-ci:Revenue",
            "context_id": "q1",
            "period_start": "2025-01-01",
            "period_end": "2025-03-31",
            "instant": None,
            "unit": "iso4217:CLP",
            "decimals": "-3",
            "value_numeric": "1250",
            "value_text": "1.25",
            "dimensions": {},
            "source_url": "https://cmf/file.zip",
        }],
    )

    assert store.existing_document("61704000", "202503", "C")["id"] == document_id
    assert store.connection.execute("select count(*) from xbrl_fact").fetchone()[0] == 1
    store.close()
