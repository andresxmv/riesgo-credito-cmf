import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Metric = { label?: string; values?: number[]; periods?: string[]; unit?: string };
type RatioPoint = { period: string; value: number };
type Ratio = { label?: string; value?: number | null; unit?: string; period?: string | null; available?: boolean; series?: RatioPoint[] };
type FellerRow = { instrument?: string; date?: string; rating?: string; outlook?: string };
type FellerReport = {
  publishedAt?: string | null;
  title?: string;
  rating?: string | null;
  outlook?: string | null;
  watch?: string | null;
  classificationRows?: FellerRow[];
  technicalSignals?: {
    topics?: string[];
    hasBaseScenario?: boolean;
    hasDownsideScenario?: boolean;
    hasUpsideScenario?: boolean;
    hasAnalystTeam?: boolean;
  };
  sourceUrl?: string;
  pdfUrl?: string;
  contentHash?: string;
  retrievedAt?: string;
};
type DocumentLineage = { period: string; sourceUrl: string; contentHash: string; retrievedAt: string };
type IssuerPayload = {
  name?: string;
  status?: string;
  source?: string;
  retrievedAt?: string;
  hasXbrl?: boolean;
  metrics?: Record<string, Metric>;
  ratios?: Record<string, Ratio>;
  lineage?: { source?: string; documents?: DocumentLineage[] };
  feller?: { profileUrl?: string; reports?: FellerReport[] };
};

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };
type Color = ReturnType<typeof rgb>;

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const COLORS = {
  navy: rgb(0.055, 0.09, 0.13),
  navy2: rgb(0.09, 0.15, 0.21),
  ink: rgb(0.1, 0.13, 0.17),
  muted: rgb(0.38, 0.43, 0.48),
  lightMuted: rgb(0.56, 0.6, 0.64),
  line: rgb(0.86, 0.88, 0.9),
  pale: rgb(0.965, 0.972, 0.98),
  paleGold: rgb(0.985, 0.97, 0.925),
  gold: rgb(0.76, 0.59, 0.3),
  teal: rgb(0.06, 0.42, 0.38),
  green: rgb(0.08, 0.42, 0.28),
  red: rgb(0.63, 0.2, 0.19),
  blue: rgb(0.16, 0.35, 0.58),
  white: rgb(1, 1, 1),
};

function cleanRut(value: string) {
  return value.replace(/\./g, "").split("-", 1)[0].replace(/[^0-9]/g, "");
}

function ascii(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Â·â€¢]/g, "-")
    .replace(/[â€“â€”]/g, "-")
    .replace(/[â€œâ€]/g, '"')
    .replace(/[^ -~]/g, "");
}

function periodToken(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{6}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}${match[2]}` : null;
}

function periodLabel(value: string | null | undefined) {
  if (!value) return "N/D";
  const token = periodToken(value);
  if (!token) return value;
  return `${Math.ceil(Number(token.slice(4)) / 3)}T${token.slice(0, 4)}`;
}

function requestedQuarter(value: string | null) {
  return value && /^\d{4}(03|06|09|12)$/.test(value) ? value : null;
}

function selectQuarter(requested: string | null, periods: string[]) {
  const available = [...new Set(periods.map(periodToken).filter((period): period is string => Boolean(period)))].sort();
  if (!available.length) return requested;
  if (!requested) return available.at(-1) ?? null;
  return available.filter((period) => period <= requested).at(-1) ?? available[0];
}

function metricAt(metric: Metric | undefined, quarter: string | null) {
  if (!metric?.values?.length) return null;
  const periods = metric.periods ?? [];
  let index = metric.values.length - 1;
  if (quarter) {
    const candidate = periods.reduce((current, period, position) => {
      const token = periodToken(period);
      return token && token <= quarter ? position : current;
    }, -1);
    if (candidate >= 0) index = candidate;
  }
  return metric.values[index] ?? null;
}

function ratioAt(ratio: Ratio | undefined, quarter: string | null) {
  if (!ratio?.available || ratio.value === null || ratio.value === undefined) {
    const series = ratio?.series ?? [];
    const fallback = series.filter((point) => !quarter || (periodToken(point.period) ?? "") <= quarter).at(-1);
    return fallback?.value ?? null;
  }
  const series = ratio.series ?? [];
  if (!quarter || !series.length) return ratio.value;
  return series.filter((point) => (periodToken(point.period) ?? "") <= quarter).at(-1)?.value ?? ratio.value;
}

function flowAt(metric: Metric | undefined, quarter: string | null) {
  if (!metric?.values?.length) return null;
  const points = (metric.periods ?? []).map((period, index) => ({ token: periodToken(period), value: metric.values?.[index] ?? null }))
    .filter((point): point is { token: string; value: number } => {
      if (!point.token || point.value === null || !Number.isFinite(point.value)) return false;
      return !quarter || point.token <= quarter;
    });
  if (points.length < 4) return metricAt(metric, quarter);
  return points.slice(-4).reduce((sum, point) => sum + point.value, 0);
}

function fellerReportAt(reports: FellerReport[] | undefined, quarter: string | null) {
  const sorted = [...(reports ?? [])].sort((left, right) => (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""));
  if (!quarter) return sorted.at(-1);
  return sorted.filter((report) => (periodToken(report.publishedAt) ?? "") <= quarter).at(-1) ?? sorted[0];
}

function fellerRatedReportAt(reports: FellerReport[] | undefined, quarter: string | null) {
  const sorted = [...(reports ?? [])]
    .filter((report) => report.rating || report.outlook)
    .sort((left, right) => (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""));
  if (!quarter) return sorted.at(-1);
  return sorted.filter((report) => (periodToken(report.publishedAt) ?? "") <= quarter).at(-1) ?? sorted[0];
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/D";
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/D";
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 1_000_000_000_000) return `${sign}${formatNumber(absolute / 1_000_000_000_000)} bn CLP`;
  if (absolute >= 1_000_000_000) return `${sign}${formatNumber(absolute / 1_000_000_000)} bn CLP`;
  if (absolute >= 1_000_000) return `${sign}${formatNumber(absolute / 1_000_000)} mm CLP`;
  return `${sign}${formatNumber(absolute)} CLP`;
}

function formatRatio(value: number | null | undefined, unit = "x") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/D";
  return `${formatNumber(value)}${unit === "%" ? "%" : unit === "x" ? "x" : ""}`;
}

function cleanUnit(unit: string | undefined) {
  return ascii(unit ?? "").replace(/CLP\s*-\s*XBRL/i, "CLP").replace(/M[uU]ltiples unidades XBRL/i, "XBRL");
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number) {
  const normalized = ascii(text).replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of normalized.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, color: Color = COLORS.ink) {
  page.drawText(ascii(text), { x, y, font, size, color });
}

function drawParagraph(page: PDFPage, text: string, x: number, y: number, width: number, fonts: Fonts, size = 9.5, leading = 14, color: Color = COLORS.ink) {
  const lines = wrapText(text, fonts.regular, size, width);
  lines.forEach((line, index) => drawText(page, line, x, y - index * leading, fonts.regular, size, color));
  return y - lines.length * leading - 8;
}

function drawLabel(page: PDFPage, text: string, x: number, y: number, fonts: Fonts, color: Color = COLORS.gold) {
  drawText(page, text.toUpperCase(), x, y, fonts.bold, 7.5, color);
}

function drawRule(page: PDFPage, x: number, y: number, width: number, color = COLORS.line) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.7, color });
}

function addPage(doc: PDFDocument, fonts: Fonts, title: string, subtitle: string, number: number) {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 32, width: PAGE_WIDTH, height: 32, color: COLORS.navy });
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 35, width: PAGE_WIDTH, height: 3, color: COLORS.gold });
  drawText(page, "CMF CREDITVIEW", MARGIN, PAGE_HEIGHT - 21, fonts.bold, 8, COLORS.white);
  drawText(page, `INFORME DE CREDITO  /  ${title}`, PAGE_WIDTH - MARGIN - 250, PAGE_HEIGHT - 21, fonts.regular, 7.5, COLORS.white);
  drawText(page, subtitle, MARGIN, PAGE_HEIGHT - 66, fonts.bold, 19, COLORS.navy);
  drawRule(page, MARGIN, PAGE_HEIGHT - 80, PAGE_WIDTH - 2 * MARGIN, COLORS.gold);
  drawText(page, "CMF CreditView  |  Analisis basado en informacion publica", MARGIN, 25, fonts.regular, 7.5, COLORS.muted);
  drawText(page, String(number).padStart(2, "0"), PAGE_WIDTH - MARGIN - 12, 25, fonts.bold, 7.5, COLORS.muted);
  return page;
}

function drawSectionTitle(page: PDFPage, text: string, x: number, y: number, fonts: Fonts) {
  drawLabel(page, text, x, y, fonts, COLORS.blue);
  drawRule(page, x, y - 7, 56, COLORS.blue);
  return y - 25;
}

function drawCallout(page: PDFPage, title: string, body: string, x: number, y: number, width: number, height: number, fonts: Fonts, fill = COLORS.pale) {
  page.drawRectangle({ x, y: y - height, width, height, color: fill, borderColor: COLORS.line, borderWidth: 0.7 });
  page.drawRectangle({ x, y: y - height, width: 4, height, color: COLORS.gold });
  drawText(page, title, x + 15, y - 20, fonts.bold, 10, COLORS.navy);
  drawParagraph(page, body, x + 15, y - 39, width - 30, fonts, 8.8, 12, COLORS.ink);
}

function drawKpi(page: PDFPage, label: string, value: string, sub: string, x: number, y: number, width: number, fonts: Fonts, accent: Color) {
  page.drawRectangle({ x, y: y - 78, width, height: 78, color: COLORS.pale, borderColor: COLORS.line, borderWidth: 0.7 });
  page.drawRectangle({ x, y: y - 78, width: 3, height: 78, color: accent });
  drawLabel(page, label, x + 13, y - 17, fonts, COLORS.muted);
  drawText(page, value, x + 13, y - 43, fonts.bold, 15, accent);
  drawText(page, sub, x + 13, y - 63, fonts.regular, 7.4, COLORS.muted);
}

function drawTable(page: PDFPage, headers: string[], rows: string[][], x: number, y: number, widths: number[], fonts: Fonts, rowHeight = 23) {
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  page.drawRectangle({ x, y: y - rowHeight, width: totalWidth, height: rowHeight, color: COLORS.navy2 });
  let columnX = x;
  headers.forEach((header, index) => {
    drawText(page, header, columnX + 7, y - 15, fonts.bold, 7.5, COLORS.white);
    columnX += widths[index];
  });
  let rowY = y - rowHeight;
  rows.forEach((row, rowIndex) => {
    rowY -= rowHeight;
    page.drawRectangle({ x, y: rowY, width: totalWidth, height: rowHeight, color: rowIndex % 2 === 0 ? COLORS.white : COLORS.pale });
    drawRule(page, x, rowY, totalWidth, COLORS.line);
    let cellX = x;
    row.forEach((cell, index) => {
      const lines = wrapText(cell, fonts.regular, 7.7, widths[index] - 14).slice(0, 2);
      lines.forEach((line, lineIndex) => drawText(page, line, cellX + 7, rowY + rowHeight - 13 - lineIndex * 9, fonts.regular, 7.7, COLORS.ink));
      cellX += widths[index];
    });
  });
  return rowY;
}

function drawBars(page: PDFPage, values: number[], labels: string[], x: number, y: number, width: number, height: number, fonts: Fonts, color: Color) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return;
  const max = Math.max(...finite.map((value) => Math.abs(value)), 1);
  const barWidth = Math.max(10, (width - 12) / values.length - 5);
  const baseline = y + 18;
  drawRule(page, x, baseline, width, COLORS.line);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const barHeight = (Math.abs(value) / max) * (height - 42);
    const barColor = value >= 0 ? color : COLORS.red;
    page.drawRectangle({ x: x + index * (barWidth + 5), y: value >= 0 ? baseline : baseline - barHeight, width: barWidth, height: barHeight, color: barColor, opacity: 0.78 });
    if (index % Math.max(1, Math.ceil(labels.length / 6)) === 0) drawText(page, labels[index], x + index * (barWidth + 5), y + 2, fonts.regular, 6.5, COLORS.muted);
  });
}

function metricValue(metrics: Record<string, Metric>, key: string, quarter: string | null, flow = false) {
  return flow ? flowAt(metrics[key], quarter) : metricAt(metrics[key], quarter);
}

function ratioValue(ratios: Record<string, Ratio>, key: string, quarter: string | null) {
  return ratioAt(ratios[key], quarter);
}

function changeFromPrevious(metric: Metric | undefined, quarter: string | null) {
  if (!metric?.values?.length) return null;
  const points = (metric.periods ?? []).map((period, index) => ({ token: periodToken(period), value: metric.values?.[index] ?? null }))
    .filter((point): point is { token: string; value: number } => {
      if (!point.token || point.value === null || !Number.isFinite(point.value)) return false;
      return !quarter || point.token <= quarter;
    });
  if (points.length < 2 || points.at(-2)?.value === 0) return null;
  return (points.at(-1)!.value - points.at(-2)!.value) / Math.abs(points.at(-2)!.value);
}

function trendWord(change: number | null) {
  if (change === null) return "sin variacion comparable disponible";
  if (change > 0.05) return `aumento de ${formatNumber(change * 100, 1)}% intertrimestral`;
  if (change < -0.05) return `disminucion de ${formatNumber(Math.abs(change) * 100, 1)}% intertrimestral`;
  return "variacion acotada frente al trimestre anterior";
}

function sourceSentence(documents: DocumentLineage[], fellerReport?: FellerReport) {
  const feller = fellerReport?.sourceUrl ? " y una referencia tecnica publica de Feller Rate" : "";
  return `La informacion cuantitativa procede de ${documents.length} documento${documents.length === 1 ? "" : "s"} de estados financieros CMF XBRL incorporados al read model${feller}. Las cifras faltantes se mantienen como N/D y no se completan con estimaciones no observadas.`;
}

function buildNarrative(name: string, metrics: Record<string, Metric>, ratios: Record<string, Ratio>, documents: DocumentLineage[], quarter: string | null, fellerReport?: FellerReport, fellerRatedReport?: FellerReport) {
  const revenue = metricValue(metrics, "revenue", quarter, true);
  const ebitda = metricValue(metrics, "ebitda", quarter, true);
  const ebit = metricValue(metrics, "ebit", quarter, true);
  const income = metricValue(metrics, "income", quarter, true);
  const cash = metricValue(metrics, "cash", quarter);
  const debt = metricValue(metrics, "debt", quarter);
  const current = ratioValue(ratios, "currentRatio", quarter);
  const quick = ratioValue(ratios, "quickRatio", quarter);
  const coverage = ratioValue(ratios, "interestCoverage", quarter);
  const netDebt = ratioValue(ratios, "netDebt", quarter);
  const netDebtEbitda = ratioValue(ratios, "netDebtEbitda", quarter);
  const debtAssets = ratioValue(ratios, "debtAssets", quarter);
  const fcf = ratioValue(ratios, "fcf", quarter);
  const ocf = ratioValue(ratios, "operatingCashFlow", quarter);
  const ebitdaChange = changeFromPrevious(metrics.ebitda, quarter);
  const revenueChange = changeFromPrevious(metrics.revenue, quarter);
  const ratingText = fellerRatedReport?.rating ? `${fellerRatedReport.rating}${fellerRatedReport.outlook ? ` / ${fellerRatedReport.outlook}` : ""}` : "sin rating Feller Rate extraible al corte";
  const strengths = [
    current !== null && current >= 1.2 ? `liquidez corriente de ${formatRatio(current)}` : null,
    coverage !== null && coverage >= 3 ? `cobertura de intereses de ${formatRatio(coverage)}` : null,
    netDebt !== null && netDebt < 0 ? "posicion de caja neta positiva" : null,
    fcf !== null && fcf > 0 ? "flujo de caja libre positivo" : null,
  ].filter((value): value is string => Boolean(value));
  const weaknesses = [
    quick !== null && quick < 1 ? `quick ratio inferior a 1,0x (${formatRatio(quick)})` : null,
    coverage !== null && coverage < 2 ? `cobertura de intereses ajustada (${formatRatio(coverage)})` : null,
    debtAssets !== null && debtAssets > 0.5 ? `apalancamiento sobre activos elevado (${formatRatio(debtAssets)})` : null,
    fcf !== null && fcf < 0 ? "flujo de caja libre negativo en el periodo observado" : null,
  ].filter((value): value is string => Boolean(value));
  const topics = fellerReport?.technicalSignals?.topics ?? [];
  return {
    overview: `Este informe presenta una lectura tecnica del perfil de credito de ${name} al ${periodLabel(quarter)}. La conclusion se construye a partir de los estados financieros reportados en XBRL, los ratios derivados y la referencia publica de agencia disponible. La referencia externa identificada es ${ratingText}. Esta lectura no es una clasificacion oficial ni reemplaza el proceso de una agencia registrada.`,
    operating: revenue !== null || ebitda !== null
      ? `En una base movil de cuatro trimestres, los ingresos alcanzan ${formatMoney(revenue)} y el EBITDA ${formatMoney(ebitda)}${ebitda !== null && revenue ? `, equivalente a un margen EBITDA de ${formatNumber((ebitda / revenue) * 100, 1)}%` : ""}. El ultimo dato de ingresos muestra ${trendWord(revenueChange)} y el EBITDA registra ${trendWord(ebitdaChange)}. La utilidad neta TTM se ubica en ${formatMoney(income)}; la lectura debe complementarse con el analisis de segmentos y de riesgos operacionales, que no se infieren cuando no estan presentes en XBRL.`
      : "No hay una serie XBRL suficiente para construir una lectura operativa en el trimestre seleccionado. El informe conserva esa limitacion de evidencia y no sustituye los valores faltantes.",
    financial: `La posicion financiera al corte registra caja de ${formatMoney(cash)} y deuda financiera de ${formatMoney(debt)}. El endeudamiento neto es ${formatMoney(netDebt)}, con una razon deuda neta a EBITDA de ${formatRatio(netDebtEbitda)}. La liquidez corriente es ${formatRatio(current)} y la liquidez acida ${formatRatio(quick)}. La cobertura de intereses alcanza ${formatRatio(coverage)}, mientras que el flujo operacional es ${formatMoney(ocf)} y el flujo de caja libre ${formatMoney(fcf)}. Estos indicadores describen capacidad financiera observada; no incorporan supuestos de refinanciamiento futuros no documentados.`,
    opinion: `Con la informacion disponible, el perfil se caracteriza por ${strengths.length ? strengths.join(", ") : "fortalezas cuantitativas aun no concluyentes"}. Los principales puntos de atencion son ${weaknesses.length ? weaknesses.join(", ") : "la sensibilidad de los resultados a la evolucion de ingresos, margen y liquidez"}. La perspectiva de agencia, cuando existe, se presenta separadamente: ${fellerReport?.outlook || "N/D"}. El modelo interno CMF CreditView permanece identificado como no emitido hasta completar su calibracion y validacion historica.`,
    strengths: strengths.length ? strengths.map((item) => `La evidencia cuantitativa muestra ${item}.`) : ["No se identifican fortalezas concluyentes con la informacion cuantitativa disponible al corte."],
    weaknesses: weaknesses.length ? weaknesses.map((item) => `Debe monitorearse ${item}.`) : ["La ausencia de ciertos datos operativos o de mercado limita la profundidad de la opinion."],
    catalysts: [
      fellerReport?.outlook?.toLowerCase().includes("posit") ? "Una perspectiva positiva de Feller Rate constituye un factor de seguimiento favorable, sujeto a la fuente original." : "Una mejora sostenida de ingresos y EBITDA durante los siguientes trimestres seria un catalizador de credito.",
      fcf !== null && fcf > 0 ? "La continuidad del flujo de caja libre positivo permitiria sostener liquidez y reducir necesidades de financiamiento." : "La normalizacion del flujo de caja libre seria relevante para fortalecer la flexibilidad financiera.",
    ],
    risks: [
      ...topics.map((topic) => `La referencia Feller identifica el eje tecnico de ${topic.replace(/_/g, " ")}; se incluye como tema de seguimiento y no como texto copiado del informe fuente.`),
      ...(weaknesses.length ? weaknesses.map((item) => `Riesgo cuantitativo: ${item}.`) : ["Riesgo de informacion: algunas variables requeridas para una opinion integral no estan disponibles en el read model."]),
    ],
  };
}

async function buildPdf(payload: IssuerPayload, rut: string, selectedQuarter: string | null) {
  const metrics = payload.metrics ?? {};
  const ratios = payload.ratios ?? {};
  const documents = payload.lineage?.documents ?? [];
  const fellerReport = fellerReportAt(payload.feller?.reports, selectedQuarter);
  const fellerRatedReport = fellerRatedReportAt(payload.feller?.reports, selectedQuarter);
  const narrative = buildNarrative(payload.name ?? "Emisor", metrics, ratios, documents, selectedQuarter, fellerReport, fellerRatedReport);
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  let pageNumber = 1;

  // Cover
  {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: COLORS.navy });
    page.drawRectangle({ x: 0, y: 0, width: 9, height: PAGE_HEIGHT, color: COLORS.gold });
    drawText(page, "CMF CREDITVIEW", MARGIN + 18, PAGE_HEIGHT - 68, fonts.bold, 11, COLORS.gold);
    drawText(page, "INFORME DE", MARGIN + 18, PAGE_HEIGHT - 205, fonts.regular, 18, COLORS.white);
    drawText(page, "ANALISIS DE CREDITO", MARGIN + 18, PAGE_HEIGHT - 242, fonts.bold, 26, COLORS.white);
    drawRule(page, MARGIN + 18, PAGE_HEIGHT - 267, 170, COLORS.gold);
    drawText(page, payload.name ?? "Emisor", MARGIN + 18, PAGE_HEIGHT - 325, fonts.bold, 23, COLORS.white);
    drawText(page, `RUT ${rut}`, MARGIN + 18, PAGE_HEIGHT - 348, fonts.regular, 11, rgb(0.78, 0.82, 0.86));
    page.drawRectangle({ x: MARGIN + 18, y: 226, width: PAGE_WIDTH - 2 * MARGIN - 36, height: 154, color: COLORS.navy2, borderColor: rgb(0.24, 0.31, 0.37), borderWidth: 0.8 });
    drawLabel(page, "CORTE DEL INFORME", MARGIN + 35, 350, fonts, COLORS.gold);
    drawText(page, periodLabel(selectedQuarter), MARGIN + 35, 315, fonts.bold, 24, COLORS.white);
    drawText(page, `Estados financieros XBRL: ${documents.length} documentos`, MARGIN + 35, 288, fonts.regular, 9.5, rgb(0.78, 0.82, 0.86));
    drawText(page, `Referencia Feller Rate: ${fellerRatedReport?.rating ?? "N/D"}  |  Perspectiva: ${fellerRatedReport?.outlook || "N/D"}`, MARGIN + 35, 270, fonts.regular, 9.5, rgb(0.78, 0.82, 0.86));
    drawText(page, "Modelo interno: no emitido", MARGIN + 35, 252, fonts.regular, 9.5, COLORS.gold);
    drawText(page, "Documento informativo basado exclusivamente en fuentes publicas.", MARGIN + 18, 88, fonts.italic, 8.5, rgb(0.68, 0.73, 0.78));
    drawText(page, "CMF CreditView  |  01", PAGE_WIDTH - MARGIN - 82, 40, fonts.regular, 8, rgb(0.68, 0.73, 0.78));
  }

  // Executive summary
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Executive summary", `${payload.name ?? "Emisor"}  |  ${periodLabel(selectedQuarter)}`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    drawCallout(page, "Lectura de credito", narrative.overview, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 86, fonts, COLORS.paleGold);
    y -= 112;
    y = drawSectionTitle(page, "Opinion ejecutiva", MARGIN, y, fonts);
    y = drawParagraph(page, narrative.operating, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.5, 14);
    y = drawParagraph(page, narrative.financial, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.5, 14);
    y = drawParagraph(page, narrative.opinion, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.5, 14);
    y -= 4;
    drawSectionTitle(page, "Indicadores destacados", MARGIN, y, fonts);
    const kpiY = y - 14;
    const kpiWidth = (PAGE_WIDTH - 2 * MARGIN - 12) / 2;
    drawKpi(page, "Ingresos TTM", formatMoney(flowAt(metrics.revenue, selectedQuarter)), `Corte ${periodLabel(selectedQuarter)}`, MARGIN, kpiY, kpiWidth, fonts, COLORS.gold);
    drawKpi(page, "EBITDA TTM", formatMoney(flowAt(metrics.ebitda, selectedQuarter)), "Flujo operativo derivado de XBRL", MARGIN + kpiWidth + 12, kpiY, kpiWidth, fonts, COLORS.teal);
    drawKpi(page, "Deuda neta / EBITDA", formatRatio(ratioValue(ratios, "netDebtEbitda", selectedQuarter)), "Apalancamiento neto", MARGIN, kpiY - 88, kpiWidth, fonts, COLORS.blue);
    drawKpi(page, "Cobertura de intereses", formatRatio(ratioValue(ratios, "interestCoverage", selectedQuarter)), "EBIT / gasto financiero", MARGIN + kpiWidth + 12, kpiY - 88, kpiWidth, fonts, COLORS.green);
  }

  // Rating page
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Clasificaciones y perspectiva", `${payload.name ?? "Emisor"}  |  Agencia externa`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    drawCallout(page, "Separacion metodologica", "La opinion oficial de una agencia y la lectura cuantitativa de CMF CreditView son objetos distintos. Este informe no mezcla ratings oficiales con una clasificacion propia; cualquier resultado interno se identifica como no emitido hasta concluir su validacion.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 78, fonts, COLORS.paleGold);
    y -= 108;
    y = drawSectionTitle(page, "Referencia Feller Rate", MARGIN, y, fonts);
    drawText(page, fellerRatedReport?.rating ?? "N/D", MARGIN, y - 25, fonts.bold, 30, COLORS.navy);
    drawText(page, `Perspectiva ${fellerRatedReport?.outlook || "N/D"}`, MARGIN + 88, y - 18, fonts.bold, 11, COLORS.gold);
    drawText(page, `Fecha de rating: ${fellerRatedReport?.publishedAt ?? "N/D"}`, MARGIN + 88, y - 37, fonts.regular, 8.5, COLORS.muted);
    drawText(page, `Ultimo comunicado identificado: ${fellerReport?.publishedAt ?? "N/D"}`, MARGIN + 88, y - 51, fonts.regular, 8.5, COLORS.muted);
    y -= 78;
    const ratingRows = fellerReport || fellerRatedReport
      ? (fellerReport?.classificationRows?.length ? fellerReport.classificationRows : [{ instrument: "Solvencia", date: fellerRatedReport?.publishedAt ?? "N/D", rating: fellerRatedReport?.rating ?? "N/D", outlook: fellerRatedReport?.outlook ?? "N/D" }]).slice(0, 8).map((row) => [row.instrument ?? "Instrumento", row.rating ?? "N/D", row.outlook || "N/D", row.date ?? fellerReport?.publishedAt ?? "N/D"])
      : [["Solvencia", "N/D", "N/D", "Sin referencia"]];
    y = drawTable(page, ["Instrumento", "Rating", "Outlook", "Fecha"], ratingRows, MARGIN, y, [190, 85, 135, 89], fonts, 25) - 30;
    y = drawSectionTitle(page, "Lectura de perspectiva", MARGIN, y, fonts);
    y = drawParagraph(page, fellerReport?.outlook ? `La perspectiva publicada para la referencia seleccionada es ${fellerReport.outlook}. Se muestra como dato de agencia y debe leerse junto con la fecha del comunicado, el instrumento clasificado y las condiciones descritas por la fuente original.` : "No se encontro una perspectiva explicita en el registro publico asociado al trimestre. La ausencia de outlook no se interpreta como estable ni como negativa.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.3, 14);
    y = drawParagraph(page, `Fuente: ${fellerReport?.sourceUrl ?? payload.feller?.profileUrl ?? "No disponible"}`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 7.5, 11, COLORS.muted);
    drawSectionTitle(page, "Clasificacion CMF CreditView", MARGIN, y, fonts);
    drawText(page, "N/D  |  No emitida", MARGIN, y - 28, fonts.bold, 18, COLORS.navy);
    drawParagraph(page, "El modelo hibrido aun no se presenta como una opinion de riesgo. La plataforma conserva la distincion entre datos observados, ratios calculados y una futura salida de modelo versionada.", MARGIN + 145, y - 22, PAGE_WIDTH - MARGIN - (MARGIN + 145), fonts, 8.5, 12, COLORS.muted);
  }

  // Credit opinion
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Credit opinion", `${payload.name ?? "Emisor"}  |  Fortalezas, riesgos y escenarios`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Fortalezas crediticias", MARGIN, y, fonts);
    for (const item of narrative.strengths) y = drawParagraph(page, `+  ${item}`, MARGIN + 8, y, PAGE_WIDTH - 2 * MARGIN - 8, fonts, 9.3, 14, COLORS.green);
    y -= 3;
    y = drawSectionTitle(page, "Debilidades y riesgos", MARGIN, y, fonts);
    for (const item of narrative.weaknesses) y = drawParagraph(page, `-  ${item}`, MARGIN + 8, y, PAGE_WIDTH - 2 * MARGIN - 8, fonts, 9.3, 14, COLORS.red);
    y -= 4;
    const half = (PAGE_WIDTH - 2 * MARGIN - 14) / 2;
    drawCallout(page, "Catalizadores", narrative.catalysts.join(" "), MARGIN, y, half, 98, fonts, COLORS.pale);
    drawCallout(page, "Key risks", narrative.risks.slice(0, 2).join(" "), MARGIN + half + 14, y, half, 98, fonts, COLORS.paleGold);
    y -= 132;
    y = drawSectionTitle(page, "Evaluacion por dimensiones", MARGIN, y, fonts);
    const current = ratioValue(ratios, "currentRatio", selectedQuarter);
    const coverage = ratioValue(ratios, "interestCoverage", selectedQuarter);
    const debtAssets = ratioValue(ratios, "debtAssets", selectedQuarter);
    const liquidityText = current === null ? "No concluyente por falta de ratio" : current >= 1.2 ? "Adecuada en la lectura corriente" : "Presionada en la lectura corriente";
    const financialText = coverage === null || debtAssets === null ? "No concluyente por variables faltantes" : coverage >= 3 && debtAssets < 0.5 ? "Capacidad financiera favorable" : "Requiere seguimiento de cobertura y endeudamiento";
    drawTable(page, ["Dimension", "Evaluacion", "Evidencia al corte"], [
      ["Liquidez", liquidityText, `Current ratio ${formatRatio(current)}; quick ratio ${formatRatio(ratioValue(ratios, "quickRatio", selectedQuarter))}`],
      ["Riesgo financiero", financialText, `Cobertura ${formatRatio(coverage)}; deuda/activos ${formatRatio(debtAssets)}`],
      ["Generacion de caja", fcfText(ratioValue(ratios, "fcf", selectedQuarter)), `FCF ${formatMoney(ratioValue(ratios, "fcf", selectedQuarter))}; OCF ${formatMoney(ratioValue(ratios, "operatingCashFlow", selectedQuarter))}`],
    ], MARGIN, y - 5, [120, 190, 189], fonts, 31);
  }

  // Feller technical reference
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Perspectiva y referencia tecnica", `${payload.name ?? "Emisor"}  |  Documento publico de agencia`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    const signals = fellerReport?.technicalSignals;
    y = drawSectionTitle(page, "Referencia tecnica estructurada", MARGIN, y, fonts);
    y = drawParagraph(page, fellerReport ? `El comunicado publico de Feller Rate del ${fellerReport.publishedAt ?? "fecha no informada"} se incorpora como referencia externa. CMF CreditView utiliza sus metadatos, fecha, clasificaciones, perspectiva y ejes tecnicos para contextualizar la lectura, sin reproducir el cuerpo protegido del informe fuente.` : "No hay un comunicado publico de Feller Rate asociado al trimestre seleccionado. La seccion mantiene la ausencia de informacion como un dato de cobertura.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.3, 14);
    y = drawTable(page, ["Campo", "Registro"], [
      ["Emisor / perfil", payload.feller?.profileUrl ?? "N/D"],
      ["Comunicado", fellerReport?.title ?? "N/D"],
      ["Clasificacion", fellerReport?.rating ?? fellerRatedReport?.rating ?? "N/D"],
      ["Perspectiva", fellerReport?.outlook || fellerRatedReport?.outlook || "N/D"],
      ["Watch", fellerReport?.watch || "N/D"],
      ["Escenarios", `Base ${signals?.hasBaseScenario ? "si" : "no"} | Baja ${signals?.hasDownsideScenario ? "si" : "no"} | Alza ${signals?.hasUpsideScenario ? "si" : "no"}`],
    ], MARGIN, y, [135, 364], fonts, 29) - 28;
    y = drawSectionTitle(page, "Ejes de seguimiento", MARGIN, y, fonts);
    const topics = signals?.topics ?? [];
    if (topics.length) {
      const topicRows = topics.map((topic) => [topic.replace(/_/g, " "), "Tema identificado en metadatos publicos de Feller Rate", "Monitorear"]);
      y = drawTable(page, ["Eje", "Lectura", "Estado"], topicRows, MARGIN, y, [125, 285, 89], fonts, 25) - 25;
    } else {
      y = drawParagraph(page, "No se identificaron ejes tecnicos estructurados en la fuente publica disponible.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.3, 14);
    }
    drawCallout(page, "Nota de uso", "La perspectiva y los escenarios pertenecen a la agencia citada. El texto analitico de este informe es generado por CMF CreditView a partir de datos observados y no constituye una transcripcion ni una opinion de Feller Rate.", MARGIN, y - 2, PAGE_WIDTH - 2 * MARGIN, 76, fonts, COLORS.paleGold);
  }

  // Financial profile
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Financial profile", `${payload.name ?? "Emisor"}  |  Flujo y posicion financiera`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Estados financieros seleccionados", MARGIN, y, fonts);
    y = drawParagraph(page, `Los flujos se presentan como suma de los cuatro trimestres disponibles hasta ${periodLabel(selectedQuarter)} cuando existe una serie trimestral suficiente. Las partidas de balance se muestran al ultimo cierre disponible igual o anterior al trimestre elegido. Unidad monetaria: ${cleanUnit(metrics.revenue?.unit) || "XBRL reportado"}.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.8, 13, COLORS.muted);
    const financialRows = [
      ["Ingresos", formatMoney(flowAt(metrics.revenue, selectedQuarter)), "TTM"],
      ["EBITDA", formatMoney(flowAt(metrics.ebitda, selectedQuarter)), "TTM"],
      ["EBIT", formatMoney(flowAt(metrics.ebit, selectedQuarter)), "TTM"],
      ["Utilidad neta", formatMoney(flowAt(metrics.income, selectedQuarter)), "TTM"],
      ["Caja y equivalentes", formatMoney(metricAt(metrics.cash, selectedQuarter)), periodLabel(selectedQuarter)],
      ["Deuda financiera", formatMoney(metricAt(metrics.debt, selectedQuarter)), periodLabel(selectedQuarter)],
      ["Flujo operacional", formatMoney(ratioValue(ratios, "operatingCashFlow", selectedQuarter)), periodLabel(selectedQuarter)],
      ["Capex", formatMoney(ratioValue(ratios, "capex", selectedQuarter)), periodLabel(selectedQuarter)],
      ["Flujo de caja libre", formatMoney(ratioValue(ratios, "fcf", selectedQuarter)), periodLabel(selectedQuarter)],
    ];
    y = drawTable(page, ["Partida", "Valor", "Base"], financialRows, MARGIN, y, [210, 190, 99], fonts, 28) - 30;
    y = drawSectionTitle(page, "Rentabilidad", MARGIN, y, fonts);
    drawKpi(page, "Margen EBITDA", margin(metrics, "ebitda", selectedQuarter), "EBITDA / ingresos TTM", MARGIN, y - 5, 154, fonts, COLORS.teal);
    drawKpi(page, "Margen EBIT", margin(metrics, "ebit", selectedQuarter), "EBIT / ingresos TTM", MARGIN + 166, y - 5, 154, fonts, COLORS.blue);
    drawKpi(page, "ROA", formatRatio(ratioValue(ratios, "roa", selectedQuarter), "%"), "Retorno sobre activos", MARGIN + 332, y - 5, 167, fonts, COLORS.gold);
    drawKpi(page, "ROE", formatRatio(ratioValue(ratios, "roe", selectedQuarter), "%"), "Retorno sobre patrimonio", MARGIN, y - 92, 154, fonts, COLORS.blue);
    drawKpi(page, "ROIC", formatRatio(ratioValue(ratios, "roic", selectedQuarter), "%"), "Retorno sobre capital", MARGIN + 166, y - 92, 154, fonts, COLORS.green);
  }

  // Ratios
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Credit ratios", `${payload.name ?? "Emisor"}  |  Indicadores derivados`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Ratios de credito", MARGIN, y, fonts);
    y = drawParagraph(page, "Los indicadores se calculan sobre conceptos identificados en los estados financieros XBRL. Un valor N/D significa que el concepto requerido no fue reportado o no pudo validarse para el corte; no se reemplaza por un supuesto.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.9, 13, COLORS.muted);
    const liquidityRows = [
      ["Current ratio", formatRatio(ratioValue(ratios, "currentRatio", selectedQuarter)), "Activo corriente / pasivo corriente"],
      ["Quick ratio", formatRatio(ratioValue(ratios, "quickRatio", selectedQuarter)), "Liquidez sin inventarios"],
      ["Cash ratio", formatRatio(ratioValue(ratios, "cashRatio", selectedQuarter)), "Caja / pasivo corriente"],
      ["Deuda / patrimonio", formatRatio(ratioValue(ratios, "debtEquity", selectedQuarter)), "Apalancamiento contable"],
      ["Deuda / activos", formatRatio(ratioValue(ratios, "debtAssets", selectedQuarter)), "Deuda financiera / activos"],
      ["Deuda neta / EBITDA", formatRatio(ratioValue(ratios, "netDebtEbitda", selectedQuarter)), "Apalancamiento neto"],
      ["Cobertura de intereses", formatRatio(ratioValue(ratios, "interestCoverage", selectedQuarter)), "EBIT / intereses"],
      ["ROA", formatRatio(ratioValue(ratios, "roa", selectedQuarter), "%"), "Utilidad / activos"],
      ["ROE", formatRatio(ratioValue(ratios, "roe", selectedQuarter), "%"), "Utilidad / patrimonio"],
      ["ROIC", formatRatio(ratioValue(ratios, "roic", selectedQuarter), "%"), "Retorno sobre capital invertido"],
    ];
    y = drawTable(page, ["Indicador", "Valor", "Definicion de referencia"], liquidityRows, MARGIN, y, [165, 105, 229], fonts, 28) - 30;
    drawCallout(page, "Interpretacion del corte", narrative.financial, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 108, fonts, COLORS.paleGold);
  }

  // History
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Financial history", `${payload.name ?? "Emisor"}  |  Tendencia trimestral`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Evolucion de ingresos y EBITDA", MARGIN, y, fonts);
    y = drawParagraph(page, "La historia se muestra en base trimestral para conservar la señal de tendencia. El grafico compara magnitudes relativas; las tablas del resto del informe contienen los valores numericos.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.8, 13, COLORS.muted);
    const history = (metrics.revenue?.periods ?? []).map((period, index) => ({ period, token: periodToken(period), revenue: metrics.revenue?.values?.[index] ?? null, ebitda: metrics.ebitda?.values?.[index] ?? null }))
      .filter((point): point is { period: string; token: string; revenue: number; ebitda: number } => {
        if (!point.token || point.revenue === null || point.ebitda === null || !Number.isFinite(point.revenue) || !Number.isFinite(point.ebitda)) return false;
        return !selectedQuarter || point.token <= selectedQuarter;
      }).slice(-12);
    drawBars(page, history.map((point) => point.revenue), history.map((point) => periodLabel(point.period)), MARGIN, y - 12, PAGE_WIDTH - 2 * MARGIN, 150, fonts, COLORS.gold);
    drawText(page, "Ingresos", MARGIN, y - 182, fonts.bold, 7.5, COLORS.gold);
    drawBars(page, history.map((point) => point.ebitda), history.map((point) => periodLabel(point.period)), MARGIN, y - 208, PAGE_WIDTH - 2 * MARGIN, 150, fonts, COLORS.teal);
    drawText(page, "EBITDA", MARGIN, y - 378, fonts.bold, 7.5, COLORS.teal);
    y -= 405;
    y = drawSectionTitle(page, "Ultimos trimestres", MARGIN, y, fonts);
    const historyRows = history.slice(-8).map((point) => [periodLabel(point.period), formatMoney(point.revenue), formatMoney(point.ebitda), point.revenue ? `${formatNumber((point.ebitda / point.revenue) * 100, 1)}%` : "N/D"]);
    drawTable(page, ["Periodo", "Ingresos", "EBITDA", "Margen"], historyRows, MARGIN, y, [100, 150, 150, 99], fonts, 25);
  }

  // Methodology
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Metodologia", `${payload.name ?? "Emisor"}  |  Como leer este documento`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Base de informacion", MARGIN, y, fonts);
    y = drawParagraph(page, sourceSentence(documents, fellerReport), MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.2, 14);
    y = drawParagraph(page, "El flujo de datos sigue la arquitectura CMF -> ETL incremental -> Supabase/read model -> API -> interfaz y PDF. El navegador no consulta directamente la CMF. Cada documento incorporado mantiene URL, periodo, timestamp de recuperacion y huella SHA-256.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.2, 14);
    y = drawSectionTitle(page, "Reglas de calculo", MARGIN, y + 8, fonts);
    const rules = [
      ["Ingresos, EBITDA, EBIT y utilidad", "Suma de los cuatro cierres trimestrales disponibles hasta el periodo seleccionado para aproximar TTM."],
      ["Caja y deuda", "Ultimo estado de situacion disponible igual o anterior al corte; no se suman periodos."],
      ["Liquidez", "Activo corriente, quick assets y caja divididos por pasivo corriente, con conceptos XBRL identificados."],
      ["Apalancamiento", "Deuda financiera y deuda neta contrastadas contra activos, patrimonio y EBITDA."],
      ["Cobertura", "Resultado operativo dividido por gasto financiero cuando ambos conceptos se encuentran disponibles."],
      ["Clasificacion", "Feller Rate se presenta como rating oficial de tercero. El modelo interno CMF CreditView permanece como N/D hasta validacion."],
    ];
    y = drawTable(page, ["Componente", "Tratamiento"], rules, MARGIN, y, [190, 339], fonts, 37) - 28;
    drawCallout(page, "Limitacion de uso", "Este documento es una herramienta de analisis y seguimiento. No es una oferta de valores, no constituye asesoramiento financiero y no reemplaza la revision de estados financieros completos, contratos de deuda, covenants, hechos esenciales ni la opinion de una clasificadora registrada.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 92, fonts, COLORS.paleGold);
  }

  // Source appendix
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Data lineage", `${payload.name ?? "Emisor"}  |  Fuentes y trazabilidad`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Documentos CMF XBRL incorporados", MARGIN, y, fonts);
    y = drawParagraph(page, `Se identifican ${documents.length} documentos para el emisor. La siguiente tabla muestra el periodo, timestamp de recuperacion y hash de contenido. Las URL son las fuentes publicas utilizadas por el ETL.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.8, 13, COLORS.muted);
    const documentRows = documents.slice(0, 18).map((document) => [periodLabel(document.period), document.retrievedAt.replace("T", " ").slice(0, 19), document.contentHash.slice(0, 16), document.sourceUrl]);
    y = drawTable(page, ["Periodo", "Recuperado", "SHA-256", "Fuente CMF"], documentRows.length ? documentRows : [["N/D", "N/D", "N/D", "No disponible"]], MARGIN, y, [73, 120, 100, 236], fonts, 25) - 28;
    y = drawSectionTitle(page, "Referencia Feller Rate", MARGIN, y, fonts);
    y = drawParagraph(page, `Comunicado utilizado: ${fellerReport?.sourceUrl ?? "N/D"}. PDF de fuente: ${fellerReport?.pdfUrl ?? "N/D"}. Hash de registro: ${fellerReport?.contentHash ?? "N/D"}. Recuperado: ${fellerReport?.retrievedAt ?? "N/D"}.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.4, 12, COLORS.muted);
    y = drawSectionTitle(page, "Cierre", MARGIN, y + 8, fonts);
    drawParagraph(page, `Informe generado para ${payload.name ?? "el emisor"}, RUT ${rut}, con corte ${periodLabel(selectedQuarter)}. Fuente principal: CMF XBRL publico. La informacion se conserva con timestamp y no se completa con datos inventados.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.2, 14);
  }

  return Buffer.from(await pdf.save());
}

function margin(metrics: Record<string, Metric>, key: string, quarter: string | null) {
  const revenue = flowAt(metrics.revenue, quarter);
  const value = flowAt(metrics[key], quarter);
  return revenue && value !== null ? `${formatNumber((value / revenue) * 100, 1)}%` : "N/D";
}

function fcfText(value: number | null) {
  if (value === null) return "No concluyente";
  return value >= 0 ? "Generacion positiva" : "Generacion negativa";
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const rut = cleanRut(url.searchParams.get("rut") ?? "");
  const requested = requestedQuarter(url.searchParams.get("quarter"));
  if (!rut) return Response.json({ error: "RUT requerido" }, { status: 400 });
  try {
    const raw = await readFile(join(process.cwd(), "public", "data", "cmf-financials.json"), "utf8");
    const dataset = JSON.parse(raw) as { issuers?: Record<string, IssuerPayload> };
    const payload = dataset.issuers?.[rut];
    if (!payload) return Response.json({ error: "Emisor no encontrado", issuer_rut: rut }, { status: 404 });
    const metrics = payload.metrics ?? {};
    const documents = payload.lineage?.documents ?? [];
    const allPeriods = Object.values(metrics).flatMap((metric) => metric.periods ?? []);
    const selectedQuarter = selectQuarter(requested, [...allPeriods, ...documents.map((document) => document.period)]);
    const pdf = await buildPdf(payload, rut, selectedQuarter);
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="cmf-creditview-${rut}-${selectedQuarter ?? "latest"}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("PDF generation failed", error);
    return Response.json({ error: "No fue posible generar el PDF" }, { status: 500 });
  }
}
