from etl.feller_rate import parse_profile_links, parse_report


def test_discovers_profile_link_and_cleans_info_label():
    source = '<html><body><a href="/clasificacion-riesgo/14279/salfacorp-sa">Salfacorp S.A. (CL)<span>info</span></a></body></html>'
    profiles = parse_profile_links(source)
    assert profiles["14279"]["name"] == "Salfacorp S.A."


def test_extracts_feller_rating_outlook_and_scenarios():
    source = """
    <html><body><div class="minheight60">
      <span>COMUNICADO DE PRENSA</span>
      <h2>Feller Rate sube a &quot;A-&quot; las clasificaciones de Salfacorp. Las perspectivas son &quot;Estables&quot;.</h2>
      20 MARCH 2026 - SANTIAGO, CHILE
      <p>La clasificación considera un perfil de negocio diversificado y una mejora en la posición financiera.</p>
      <h3>PERSPECTIVAS: Estables</h3>
      <p>ESCENARIO BASE: continuidad operacional.</p>
      <p>ESCENARIO DE BAJA: mayor deuda financiera.</p>
      <p>ESCENARIO DE ALZA: mejora de cobertura.</p>
    </div></body></html>
    """
    report = parse_report("https://www.feller-rate.cl/clasificacion-cp/14279/19759/salfacorp-sa", source)
    assert report["publishedAt"] == "2026-03-20"
    assert report["rating"] == "A-"
    assert report["outlook"] == "Estables"
    assert report["technicalSignals"]["hasBaseScenario"] is True
    assert report["technicalSignals"]["hasDownsideScenario"] is True
    assert report["technicalSignals"]["hasUpsideScenario"] is True
