"use client";

import { useEffect, useMemo, useState } from "react";
import { issuerCatalog, issuerCatalogAsOf, issuerCatalogSource } from "./issuer-catalog";

type MetricKey = "revenue" | "ebitda" | "ebit" | "income" | "cash" | "debt";

type MetricData = {
  label: string;
  unit: string;
  values: number[];
  change: string | null;
  tone: string;
};

type RatingRow = {
  agency: string;
  rating: string;
  outlook: string;
  date: string;
  source: string;
};

type EventRow = {
  date: string;
  type: string;
  title: string;
  detail: string;
  tone: string;
};

type IssuerViewData = {
  metrics: Record<MetricKey, MetricData>;
  ratings: RatingRow[];
  events: EventRow[];
  riskFlags: { label: string; value: string; tone: string }[];
  hasXbrl: boolean;
};

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

const metricDefinitions: Record<MetricKey, Pick<MetricData, "label" | "unit" | "tone">> = {
  revenue: {
    label: "Ingresos",
    unit: "CLP mm",
    tone: "gold",
  },
  ebitda: {
    label: "EBITDA",
    unit: "CLP mm",
    tone: "mint",
  },
  ebit: {
    label: "EBIT",
    unit: "CLP mm",
    tone: "blue",
  },
  income: {
    label: "Utilidad neta",
    unit: "CLP mm",
    tone: "violet",
  },
  cash: {
    label: "Caja y equivalentes",
    unit: "CLP mm",
    tone: "mint",
  },
  debt: {
    label: "Deuda financiera",
    unit: "CLP mm",
    tone: "rose",
  },
};

const emptyMetricData = Object.fromEntries(
  Object.entries(metricDefinitions).map(([key, definition]) => [key, { ...definition, values: [], change: null }]),
) as Record<MetricKey, MetricData>;

const emptyIssuerView: IssuerViewData = {
  metrics: emptyMetricData,
  ratings: [],
  events: [],
  riskFlags: [],
  hasXbrl: false,
};

// La vista se indexa por RUT para que el ETL pueda inyectar cada emisor sin
// compartir accidentalmente métricas, ratings o eventos entre compañías.
// Hasta que exista una fila XBRL validada, devolvemos estado vacío y explícito.
const issuerViewDataByRut: Record<string, IssuerViewData> = {};

function getIssuerViewData(rut: string): IssuerViewData {
  return issuerViewDataByRut[rut] ?? emptyIssuerView;
}

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

function BarChart({ data, period }: { data: MetricData; period: "5Y" | "20Q" }) {
  if (!data.values.length) {
    return <div className="chart-empty">Sin estados financieros XBRL ingeridos para este emisor.</div>;
  }

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
  const [selectedIssuer, setSelectedIssuer] = useState(() => issuerCatalog.find((item) => item.name === "CENCOSUD S.A.") ?? issuerCatalog[0]);

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
    const matches = query
      ? issuerCatalog.filter((item) => `${item.name} ${item.rut}`.toLowerCase().includes(query))
      : issuerCatalog;
    return matches.slice(0, 8);
  }, [search]);

  const issuerData = useMemo(() => getIssuerViewData(selectedIssuer.rut), [selectedIssuer.rut]);
  const selectedData = issuerData.metrics[selectedMetric];
  const hasFinancials = issuerData.hasXbrl && selectedData.values.length > 0;
  const issuerInitials = selectedIssuer.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const currentRating = issuerData.ratings[0];
  const notAvailable = "No disponible";

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
            <div className="health-top"><span className="status-dot" /> <span>CMF data room</span><span className="health-live">CATALOG</span></div>
            <div className="health-meta">Última actualización · snapshot {issuerCatalogAsOf}</div>
            <div className="health-progress"><span /></div>
            <div className="health-meta health-meta-row"><span>{formatNumber(issuerCatalog.length)} emisores</span><span>catálogo</span></div>
          </div>
          <button className="sidebar-link"><span>⚙</span> Workspace settings</button>
          <div className="profile-row"><div className="profile-avatar">AR</div><div><strong>Andes Research</strong><span>Analyst workspace</span></div><span className="profile-more">···</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span className="crumb-muted">CreditView</span><span>/</span><span>{activeNav}</span><span>/</span><strong>{selectedIssuer.name}</strong></div>
          <div className="topbar-actions">
            <div className={`search-box ${searchOpen ? "search-focus" : ""}`}>
              <span className="search-icon">⌕</span>
              <input id="global-search" aria-label="Buscar emisor" value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="Buscar emisor, RUT, ISIN o bono..." />
              <kbd>⌘ K</kbd>
              {searchOpen && (
                <div className="search-popover">
                  <div className="search-popover-label">EMISORES CMF · {formatNumber(issuerCatalog.length)}</div>
                  {filteredSearchItems.length ? filteredSearchItems.map((item) => (
                    <button className="search-result" key={item.rut} onMouseDown={(event) => event.preventDefault()} onClick={() => { setSelectedIssuer(item); setSearch(item.name); setSearchOpen(false); }}>
                      <span className="result-icon">↗</span><span><strong>{item.name}</strong><small>{item.rut} · Emisor vigente</small></span><span className="result-arrow">↵</span>
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
          <div className="demo-banner"><span className="banner-pulse" /> <strong>CMF issuer master</strong><span>{formatNumber(issuerCatalog.length)} emisores vigentes · snapshot {issuerCatalogAsOf} · {issuerCatalogSource}; estados financieros XBRL pendientes de ingestión.</span><button>Ver arquitectura →</button></div>

          <div className="issuer-heading">
            <div className="issuer-title-wrap">
              <div className="issuer-avatar">{issuerInitials || "CMF"}</div>
              <div>
                <div className="eyebrow-row"><span className="eyebrow">ISSUER / CREDIT VIEW</span><span className="live-tag">PUBLIC ISSUER</span></div>
                <h1>{selectedIssuer.name} <span>↗</span></h1>
                <div className="issuer-subtitle"><span className="ticker">CMF / EMISOR</span><span>·</span><span>RUT {selectedIssuer.rut}</span><span>·</span><span>Emisor vigente</span></div>
              </div>
            </div>
            <div className="issuer-actions"><button className={`watch-button ${isWatched ? "watched" : ""}`} onClick={() => setIsWatched((value) => !value)}><span>{isWatched ? "★" : "☆"}</span>{isWatched ? "En seguimiento" : "Seguir emisor"}</button><button className="report-button">Informe PDF <span>↗</span></button></div>
          </div>

          <div className="issuer-meta-grid">
            <div><span>Sector</span><strong>{notAvailable}</strong></div><div><span>Industria</span><strong>{notAvailable}</strong></div><div><span>ISIN</span><strong>{notAvailable}</strong></div><div><span>Auditor</span><strong>{notAvailable}</strong></div><div><span>Market cap</span><strong>{notAvailable}</strong></div><div><span>Moneda</span><strong>CLP · IFRS</strong></div>
          </div>

          <div className="rating-strip">
            <div className="rating-summary official-summary"><div className="strip-label">CLASIFICACIÓN OFICIAL</div><div className="rating-main"><RatingBadge rating={currentRating?.rating ?? "N/D"} /><div><strong>{currentRating?.agency ?? notAvailable}</strong><span>{currentRating ? `${currentRating.outlook} · ${currentRating.date}` : "Sin rating CMF ingerido"}</span></div></div></div>
            <div className="rating-summary model-summary"><div className="strip-label">MODELO INTERNO · HYBRID SCORE</div><div className="rating-main"><RatingBadge rating="N/D" /><div><strong>— <small>/ 100</small></strong><span>Sin inputs XBRL validados</span></div></div></div>
            <div className="strip-factors"><div><span>Trend</span><strong>— Sin datos</strong></div><div><span>Watch</span><strong>— Sin datos</strong></div><div><span>Data as of</span><strong>CMF · pendiente de ingestión</strong></div></div>
          </div>

          <div className="content-tabs"><button className="active">Summary</button><button>Financials</button><button>Ratings <span>5</span></button><button>Events <span>12</span></button><button>Documents</button><div className="tab-spacer" /><button className="density-button">▦ Dense view</button></div>

          <section className="section-block">
            <div className="section-heading"><div><span className="eyebrow">KEY CREDIT METRICS</span><h2>Credit snapshot</h2></div><div className="as-of">Consolidated · TTM <span>ⓘ</span></div></div>
            <div className="metrics-grid">
              <MetricCell label="Ingresos TTM" value={hasFinancials ? `${formatNumber(selectedData.values.slice(-4).reduce((sum, value) => sum + value, 0))} mm` : notAvailable} detail={hasFinancials ? "CMF XBRL · TTM" : "Sin EEFF XBRL cargados"} tone="gold" />
              <MetricCell label="EBITDA TTM" value={notAvailable} detail="Sin EEFF XBRL cargados" tone="mint" />
              <MetricCell label="Net debt / EBITDA" value={notAvailable} detail="Se calcula después de validar XBRL" tone="blue" />
              <MetricCell label="Interest coverage" value={notAvailable} detail="Se calcula después de validar XBRL" tone="mint" />
              <MetricCell label="Current ratio" value={notAvailable} detail="Se calcula después de validar XBRL" />
              <MetricCell label="ROIC" value={notAvailable} detail="Se calcula después de validar XBRL" tone="violet" />
              <MetricCell label="FCF TTM" value={notAvailable} detail="Sin flujo de caja XBRL cargado" tone="gold" />
              <MetricCell label="Deuda / activos" value={notAvailable} detail="Se calcula después de validar XBRL" tone="blue" />
            </div>
          </section>

          <div className="main-grid">
            <section className="panel performance-panel">
              <div className="panel-header"><div><span className="eyebrow">FINANCIAL HISTORY</span><h2>Operating performance</h2></div><div className="panel-controls"><div className="segmented-control">{(["5Y", "20Q"] as const).map((item) => <button className={period === item ? "active" : ""} key={item} onClick={() => setPeriod(item)}>{item}</button>)}</div><button className="export-button">Exportar ↗</button></div></div>
              <div className="metric-tabs">{(Object.keys(metricDefinitions) as MetricKey[]).map((key) => <button className={`${selectedMetric === key ? "active" : ""} ${metricDefinitions[key].tone}`} key={key} onClick={() => setSelectedMetric(key)}>{metricDefinitions[key].label}</button>)}</div>
              <div className="chart-summary"><div><strong>{hasFinancials ? formatNumber(selectedData.values[selectedData.values.length - 1]) : "—"}</strong><span>{selectedData.unit} · {hasFinancials ? "último período" : "sin datos XBRL"}</span></div><div className="chart-change">{selectedData.change ?? "—"} <span>{hasFinancials ? "vs período anterior" : "pendiente de ingestión CMF"}</span></div></div>
              <BarChart data={selectedData} period={period} />
              <div className="chart-footnote"><span>Fuente: EEFF consolidados · IFRS</span><span>Último período: 31 dic 2025</span></div>
            </section>

            <aside className="panel memo-panel">
              <div className="panel-header"><div><span className="eyebrow">ANALYST LENS</span><h2>Credit memo</h2></div><button className="more-button">···</button></div>
              <div className="memo-lede">No hay una opinión crediticia calculable para este emisor porque todavía no existen estados financieros XBRL validados en la capa de datos.</div>
              <div className="memo-section"><div className="memo-section-title">RISK FLAGS <span>{issuerData.riskFlags.length} abiertas</span></div>{issuerData.riskFlags.length ? issuerData.riskFlags.map((flag) => <div className="risk-row" key={flag.label}><span className={`risk-indicator ${flag.tone}`} /><span>{flag.label}</span><strong>{flag.value}</strong><span className="risk-arrow">›</span></div>) : <div className="empty-inline">Sin flags: faltan inputs CMF.</div>}</div>
              <div className="memo-section"><div className="memo-section-title">KEY CATALYSTS</div><div className="empty-inline">Se habilitarán cuando exista historia financiera CMF validada.</div></div>
              <div className="memo-footer"><span>Model version <strong>Hybrid v0.9</strong></span><button>Ver metodología →</button></div>
            </aside>
          </div>

          <div className="lower-grid">
            <section className="panel ratings-panel"><div className="panel-header"><div><span className="eyebrow">EXTERNAL CREDIT OPINIONS</span><h2>Official ratings</h2></div><button className="text-button">Ver historial completo →</button></div><div className="table-wrap"><table><thead><tr><th>Agencia</th><th>Rating</th><th>Outlook</th><th>Fecha</th><th>Fuente</th><th /></tr></thead><tbody>{issuerData.ratings.length ? issuerData.ratings.map((row) => <tr key={row.agency}><td><span className="agency-mark">{row.agency.slice(0, 1)}</span><strong>{row.agency}</strong></td><td><RatingBadge rating={row.rating} subtle /></td><td><span className="outlook-dot" />{row.outlook}</td><td className="muted-cell">{row.date}</td><td className="muted-cell">{row.source}</td><td><button className="row-arrow">↗</button></td></tr>) : <tr><td colSpan={6} className="empty-table">Sin clasificaciones oficiales ingeridas desde CMF.</td></tr>}</tbody></table></div></section>
            <section className="panel events-panel"><div className="panel-header"><div><span className="eyebrow">PUBLIC DISCLOSURES</span><h2>Recent events</h2></div><button className="text-button">Timeline completa →</button></div><div className="event-list">{issuerData.events.length ? issuerData.events.map((event) => <div className="event-row" key={`${event.date}-${event.title}`}><div className="event-date">{event.date}</div><div className={`event-type ${event.tone}`}>{event.type}</div><div className="event-copy"><strong>{event.title}</strong><span>{event.detail}</span></div><span className="event-arrow">↗</span></div>) : <div className="empty-inline">Sin hechos esenciales, bonos o eventos CMF ingeridos.</div>}</div></section>
          </div>

          <div className="bottom-note"><span className="status-dot" /> <span>All figures in CLP millions unless otherwise stated.</span><span>·</span><span>Source lineage: CMF public filings → ETL → Supabase → FastAPI</span><button>Open data lineage ↗</button></div>
        </div>
      </section>
    </main>
  );
}
