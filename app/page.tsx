"use client";

import { useEffect, useMemo, useState } from "react";

type MetricKey = "revenue" | "ebitda" | "ebit" | "income" | "cash" | "debt";

const quarters = [
  "1T21",
  "2T21",
  "3T21",
  "4T21",
  "1T22",
  "2T22",
  "3T22",
  "4T22",
  "1T23",
  "2T23",
  "3T23",
  "4T23",
  "1T24",
  "2T24",
  "3T24",
  "4T24",
  "1T25",
  "2T25",
  "3T25",
  "4T25",
];

const metricData: Record<
  MetricKey,
  { label: string; unit: string; values: number[]; change: string; tone: string }
> = {
  revenue: {
    label: "Ingresos",
    unit: "CLP mm",
    values: [1690, 1840, 1960, 2150, 1810, 1970, 2140, 2310, 1900, 2070, 2260, 2470, 2040, 2190, 2390, 2620, 2160, 2310, 2520, 2780],
    change: "+9,4%",
    tone: "gold",
  },
  ebitda: {
    label: "EBITDA",
    unit: "CLP mm",
    values: [214, 238, 257, 301, 226, 251, 279, 328, 241, 274, 304, 351, 254, 291, 321, 372, 269, 302, 338, 394],
    change: "+11,8%",
    tone: "mint",
  },
  ebit: {
    label: "EBIT",
    unit: "CLP mm",
    values: [119, 141, 154, 181, 123, 146, 164, 198, 137, 159, 180, 214, 147, 174, 193, 231, 159, 186, 211, 249],
    change: "+7,9%",
    tone: "blue",
  },
  income: {
    label: "Utilidad neta",
    unit: "CLP mm",
    values: [51, 63, 70, 86, 45, 60, 72, 92, 57, 66, 81, 103, 62, 73, 88, 116, 68, 79, 97, 129],
    change: "+12,1%",
    tone: "violet",
  },
  cash: {
    label: "Caja y equivalentes",
    unit: "CLP mm",
    values: [612, 580, 645, 711, 698, 670, 742, 790, 748, 719, 776, 834, 809, 776, 842, 906, 868, 831, 904, 972],
    change: "+7,3%",
    tone: "mint",
  },
  debt: {
    label: "Deuda financiera",
    unit: "CLP mm",
    values: [5230, 5180, 5310, 5480, 5520, 5450, 5380, 5260, 5330, 5270, 5190, 5120, 5050, 4970, 4890, 4810, 4780, 4690, 4610, 4520],
    change: "-5,2%",
    tone: "rose",
  },
};

const navGroups = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", icon: "◈" },
      { label: "Credit view", icon: "◌" },
      { label: "Financials", icon: "▤" },
      { label: "Ratings", icon: "✦" },
      { label: "Events", icon: "◷" },
      { label: "Compare", icon: "⇄" },
    ],
  },
  {
    label: "Data room",
    items: [
      { label: "Issuers", icon: "⌘" },
      { label: "Bonds", icon: "═" },
      { label: "Documents", icon: "□" },
    ],
  },
];

const searchItems = [
  { name: "Cencosud S.A.", detail: "CENCOSUD · Retail · RUT 93.834.000-5" },
  { name: "Banco de Chile", detail: "CHILE · Bancos · RUT 97.004.000-5" },
  { name: "Enel Chile S.A.", detail: "ENELCHILE · Energía · RUT 76.536.353-7" },
  { name: "Aguas Andinas S.A.", detail: "AGUAS-A · Utilities · RUT 61.808.000-5" },
];

const ratingRows = [
  { agency: "Feller Rate", rating: "AA-", outlook: "Estable", date: "18 jun 2026", source: "Informe emisor" },
  { agency: "ICR", rating: "AA-", outlook: "Estable", date: "04 may 2026", source: "Clasificación pública" },
  { agency: "Fitch", rating: "BBB", outlook: "Positiva", date: "22 abr 2026", source: "Issuer report" },
  { agency: "Moody's", rating: "Baa2", outlook: "Estable", date: "11 mar 2026", source: "Credit opinion" },
  { agency: "S&P", rating: "BBB", outlook: "Estable", date: "07 feb 2026", source: "Research update" },
];

const events = [
  { date: "18 JUN 26", type: "Rating", title: "Feller Rate confirma AA-", detail: "Perspectiva estable · sin cambios en la tendencia", tone: "gold" },
  { date: "02 JUN 26", type: "Bono", title: "Serie K — amortización programada", detail: "CLP 18.000 mm · próximo vencimiento 2030", tone: "blue" },
  { date: "14 MAY 26", type: "Hecho esencial", title: "Acuerdo de refinanciamiento", detail: "Extensión de vencimientos por CLP 280.000 mm", tone: "violet" },
  { date: "28 MAR 26", type: "Dividendo", title: "Dividendo definitivo aprobado", detail: "CLP 14,2 por acción · pago 30 abril 2026", tone: "mint" },
];

const riskFlags = [
  { label: "Apalancamiento", value: "Moderado", tone: "amber" },
  { label: "Cobertura de intereses", value: "Adecuada", tone: "mint" },
  { label: "FX exposure", value: "Monitorear", tone: "rose" },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CL").format(value);
}

function RatingBadge({ rating, subtle = false }: { rating: string; subtle?: boolean }) {
  return <span className={`rating-badge ${subtle ? "rating-badge-subtle" : ""}`}>{rating}</span>;
}

function MetricCell({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <div className="metric-cell">
      <div className="metric-label">{label}</div>
      <div className={`metric-value metric-${tone}`}>{value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  );
}

function BarChart({ metric, period }: { metric: MetricKey; period: "5Y" | "20Q" }) {
  const data = metricData[metric];
  const visibleValues = period === "5Y" ? data.values.slice(-12) : data.values;
  const visibleQuarters = period === "5Y" ? quarters.slice(-12) : quarters;
  const max = Math.max(...visibleValues);
  const min = Math.min(...visibleValues);
  const range = Math.max(max - min, 1);

  return (
    <div className="chart-wrap" aria-label={`${data.label} histórico trimestral`}>
      <div className="chart-y-axis" aria-hidden="true">
        <span>{formatNumber(max)}</span>
        <span>{formatNumber(Math.round((max + min) / 2))}</span>
        <span>{formatNumber(min)}</span>
      </div>
      <div className="bar-chart">
        <div className="chart-gridline grid-top" />
        <div className="chart-gridline grid-middle" />
        <div className="chart-gridline grid-bottom" />
        <div className="bars" role="img" aria-label={`${data.label}: ${visibleValues.map((value, index) => `${visibleQuarters[index]} ${formatNumber(value)}`).join(", ")}`}>
          {visibleValues.map((value, index) => {
            const height = 22 + ((value - min) / range) * 68;
            const isLatest = index === visibleValues.length - 1;
            return (
              <div className="bar-column" key={`${visibleQuarters[index]}-${value}`}>
                <div className={`bar-tooltip ${isLatest ? "bar-tooltip-visible" : ""}`}>{formatNumber(value)}</div>
                <div className={`bar ${data.tone} ${isLatest ? "bar-latest" : ""}`} style={{ height: `${height}%` }} />
                <span>{visibleQuarters[index]}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [activeNav, setActiveNav] = useState("Credit view");
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>("revenue");
  const [period, setPeriod] = useState<"5Y" | "20Q">("20Q");
  const [isDark, setIsDark] = useState(true);
  const [isWatched, setIsWatched] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        document.getElementById("global-search")?.focus();
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const filteredSearchItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return searchItems;
    return searchItems.filter((item) => `${item.name} ${item.detail}`.toLowerCase().includes(query));
  }, [search]);

  const selectedData = metricData[selectedMetric];
  const ttmRevenue = metricData.revenue.values.slice(-4).reduce((sum, value) => sum + value, 0);
  const ttmEbitda = metricData.ebitda.values.slice(-4).reduce((sum, value) => sum + value, 0);

  return (
    <main className={`creditview-shell ${isDark ? "theme-dark" : "theme-light"}`}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">CV</div>
          <div>
            <div className="brand-name">CMF CreditView</div>
            <div className="brand-caption">Chile · Credit intelligence</div>
          </div>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-icon">C</div>
          <div className="workspace-copy"><span>Workspace</span><strong>Andes Research</strong></div>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav className="sidebar-nav" aria-label="Navegación principal">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <button className={`nav-item ${activeNav === item.label ? "active" : ""}`} key={item.label} onClick={() => setActiveNav(item.label)}>
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.label === "Ratings" && <span className="nav-count">5</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="data-health">
            <div className="health-top"><span className="status-dot" /> <span>CMF data room</span><span className="health-live">LIVE</span></div>
            <div className="health-meta">Última actualización · 08:42 CLT</div>
            <div className="health-progress"><span /></div>
            <div className="health-meta health-meta-row"><span>2.481 emisores</span><span>99,4%</span></div>
          </div>
          <button className="sidebar-link"><span>⚙</span> Workspace settings</button>
          <div className="profile-row"><div className="profile-avatar">AR</div><div><strong>Andes Research</strong><span>Analyst workspace</span></div><span className="profile-more">···</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span className="crumb-muted">CreditView</span><span>/</span><span>{activeNav}</span><span>/</span><strong>Cencosud S.A.</strong></div>
          <div className="topbar-actions">
            <div className={`search-box ${searchOpen ? "search-focus" : ""}`}>
              <span className="search-icon">⌕</span>
              <input id="global-search" aria-label="Buscar emisor" value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="Buscar emisor, RUT, ISIN o bono..." />
              <kbd>⌘ K</kbd>
              {searchOpen && (
                <div className="search-popover">
                  <div className="search-popover-label">EMISORES RECIENTES</div>
                  {filteredSearchItems.length ? filteredSearchItems.map((item) => (
                    <button className="search-result" key={item.name} onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearch(item.name); setSearchOpen(false); }}>
                      <span className="result-icon">↗</span><span><strong>{item.name}</strong><small>{item.detail}</small></span><span className="result-arrow">↵</span>
                    </button>
                  )) : <div className="empty-search">Sin coincidencias en la base local.</div>}
                  <div className="search-footer"><span>↑↓ navegar</span><span>↵ seleccionar</span></div>
                </div>
              )}
            </div>
            <button className="topbar-icon" aria-label="Notificaciones">♢<span className="notification-dot" /></button>
            <button className="theme-toggle" aria-label="Cambiar tema" onClick={() => setIsDark((value) => !value)}><span className={isDark ? "toggle-active" : ""}>☾</span><span className={!isDark ? "toggle-active" : ""}>☼</span></button>
            <button className="help-button">?</button>
          </div>
        </header>

        <div className="page-content">
          <div className="demo-banner"><span className="banner-pulse" /> <strong>Reference dataset</strong><span>Vista de producto con datos de referencia · el ETL histórico CMF se conectará a esta superficie.</span><button>Ver arquitectura →</button></div>

          <div className="issuer-heading">
            <div className="issuer-title-wrap">
              <div className="issuer-avatar">CS</div>
              <div>
                <div className="eyebrow-row"><span className="eyebrow">ISSUER / CREDIT VIEW</span><span className="live-tag">PUBLIC ISSUER</span></div>
                <h1>Cencosud S.A. <span>↗</span></h1>
                <div className="issuer-subtitle"><span className="ticker">CENCOSUD</span><span>·</span><span>RUT 93.834.000-5</span><span>·</span><span>Retail &amp; Consumer</span></div>
              </div>
            </div>
            <div className="issuer-actions"><button className={`watch-button ${isWatched ? "watched" : ""}`} onClick={() => setIsWatched((value) => !value)}><span>{isWatched ? "★" : "☆"}</span>{isWatched ? "En seguimiento" : "Seguir emisor"}</button><button className="report-button">Informe PDF <span>↗</span></button></div>
          </div>

          <div className="issuer-meta-grid">
            <div><span>Sector</span><strong>Retail</strong></div><div><span>Industria</span><strong>Supermercados</strong></div><div><span>ISIN</span><strong>CL0000000423</strong></div><div><span>Auditor</span><strong>EY Chile</strong></div><div><span>Market cap</span><strong>CLP 3,8 tn</strong></div><div><span>Moneda</span><strong>CLP · IFRS</strong></div>
          </div>

          <div className="rating-strip">
            <div className="rating-summary official-summary"><div className="strip-label">CLASIFICACIÓN OFICIAL</div><div className="rating-main"><RatingBadge rating="AA-" /><div><strong>Feller Rate</strong><span>Perspectiva estable · 18 jun 2026</span></div></div></div>
            <div className="rating-summary model-summary"><div className="strip-label">MODELO INTERNO · HYBRID SCORE</div><div className="rating-main"><RatingBadge rating="A+" /><div><strong>84 <small>/ 100</small></strong><span>Confidence 89% · Outlook positivo</span></div></div></div>
            <div className="strip-factors"><div><span>Trend</span><strong className="positive-text">↗ Mejorando</strong></div><div><span>Watch</span><strong>Sin watch</strong></div><div><span>Data as of</span><strong>4T25 · 31 dic 2025</strong></div></div>
          </div>

          <div className="content-tabs"><button className="active">Summary</button><button>Financials</button><button>Ratings <span>5</span></button><button>Events <span>12</span></button><button>Documents</button><div className="tab-spacer" /><button className="density-button">▦ Dense view</button></div>

          <section className="section-block">
            <div className="section-heading"><div><span className="eyebrow">KEY CREDIT METRICS</span><h2>Credit snapshot</h2></div><div className="as-of">Consolidated · TTM <span>ⓘ</span></div></div>
            <div className="metrics-grid">
              <MetricCell label="Ingresos TTM" value={`${formatNumber(ttmRevenue)} mm`} detail="CLP · +9,4% YoY" tone="gold" />
              <MetricCell label="EBITDA TTM" value={`${formatNumber(ttmEbitda)} mm`} detail="Margen 13,6% · +11,8%" tone="mint" />
              <MetricCell label="Net debt / EBITDA" value="3,4x" detail="↓ 0,3x vs 4T24" tone="blue" />
              <MetricCell label="Interest coverage" value="3,8x" detail="↑ 0,4x vs 4T24" tone="mint" />
              <MetricCell label="Current ratio" value="1,12x" detail="Estable · umbral 1,0x" />
              <MetricCell label="ROIC" value="8,7%" detail="↑ 90 bps YoY" tone="violet" />
              <MetricCell label="FCF TTM" value="CLP 208 mm" detail="Conversión 52% EBITDA" tone="gold" />
              <MetricCell label="Deuda / activos" value="48,2%" detail="↓ 120 bps YoY" tone="blue" />
            </div>
          </section>

          <div className="main-grid">
            <section className="panel performance-panel">
              <div className="panel-header"><div><span className="eyebrow">FINANCIAL HISTORY</span><h2>Operating performance</h2></div><div className="panel-controls"><div className="segmented-control">{(["5Y", "20Q"] as const).map((item) => <button className={period === item ? "active" : ""} key={item} onClick={() => setPeriod(item)}>{item}</button>)}</div><button className="export-button">Exportar ↗</button></div></div>
              <div className="metric-tabs">{(Object.keys(metricData) as MetricKey[]).map((key) => <button className={`${selectedMetric === key ? "active" : ""} ${metricData[key].tone}`} key={key} onClick={() => setSelectedMetric(key)}>{metricData[key].label}</button>)}</div>
              <div className="chart-summary"><div><strong>{formatNumber(selectedData.values[selectedData.values.length - 1])}</strong><span>{selectedData.unit} · 4T25</span></div><div className="chart-change positive-text">{selectedData.change} <span>vs 4T24</span></div></div>
              <BarChart metric={selectedMetric} period={period} />
              <div className="chart-footnote"><span>Fuente: EEFF consolidados · IFRS</span><span>Último período: 31 dic 2025</span></div>
            </section>

            <aside className="panel memo-panel">
              <div className="panel-header"><div><span className="eyebrow">ANALYST LENS</span><h2>Credit memo</h2></div><button className="more-button">···</button></div>
              <div className="memo-lede">La posición crediticia se mantiene <strong>adecuada</strong>, apoyada por crecimiento de ingresos, mejora de márgenes y una trayectoria descendente de deuda neta.</div>
              <div className="memo-section"><div className="memo-section-title">RISK FLAGS <span>3 abiertas</span></div>{riskFlags.map((flag) => <div className="risk-row" key={flag.label}><span className={`risk-indicator ${flag.tone}`} /><span>{flag.label}</span><strong>{flag.value}</strong><span className="risk-arrow">›</span></div>)}</div>
              <div className="memo-section"><div className="memo-section-title">KEY CATALYSTS</div><ul className="catalyst-list"><li>Desapalancamiento orgánico sostenido</li><li>Refinanciamiento con extensión de duration</li><li>Expansión de margen en negocios digitales</li></ul></div>
              <div className="memo-footer"><span>Model version <strong>Hybrid v0.9</strong></span><button>Ver metodología →</button></div>
            </aside>
          </div>

          <div className="lower-grid">
            <section className="panel ratings-panel"><div className="panel-header"><div><span className="eyebrow">EXTERNAL CREDIT OPINIONS</span><h2>Official ratings</h2></div><button className="text-button">Ver historial completo →</button></div><div className="table-wrap"><table><thead><tr><th>Agencia</th><th>Rating</th><th>Outlook</th><th>Fecha</th><th>Fuente</th><th /></tr></thead><tbody>{ratingRows.map((row) => <tr key={row.agency}><td><span className="agency-mark">{row.agency.slice(0, 1)}</span><strong>{row.agency}</strong></td><td><RatingBadge rating={row.rating} subtle /></td><td><span className="outlook-dot" />{row.outlook}</td><td className="muted-cell">{row.date}</td><td className="muted-cell">{row.source}</td><td><button className="row-arrow">↗</button></td></tr>)}</tbody></table></div></section>
            <section className="panel events-panel"><div className="panel-header"><div><span className="eyebrow">PUBLIC DISCLOSURES</span><h2>Recent events</h2></div><button className="text-button">Timeline completa →</button></div><div className="event-list">{events.map((event) => <div className="event-row" key={`${event.date}-${event.title}`}><div className="event-date">{event.date}</div><div className={`event-type ${event.tone}`}>{event.type}</div><div className="event-copy"><strong>{event.title}</strong><span>{event.detail}</span></div><span className="event-arrow">↗</span></div>)}</div></section>
          </div>

          <div className="bottom-note"><span className="status-dot" /> <span>All figures in CLP millions unless otherwise stated.</span><span>·</span><span>Source lineage: CMF public filings → ETL → Supabase → FastAPI</span><button>Open data lineage ↗</button></div>
        </div>
      </section>
    </main>
  );
}
