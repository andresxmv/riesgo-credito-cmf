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

type EstimatedRating = {
  score: number | null;
  rating: string;
  confidence: number;
  outlook: string;
  trend: string;
  riskFlags: string[];
  drivers: string[];
};

type ModelFeature = { label: string; score: number; weight: number };

function tierScore(value: number | null, tiers: [number, number][]) {
  if (value === null || !Number.isFinite(value)) return null;
  for (const [minimum, score] of tiers) if (value >= minimum) return score;
  return tiers.at(-1)?.[1] ?? null;
}

function trendChange(metric: Metric | undefined, quarter: string | null) {
  if (!metric?.values?.length) return null;
  const points = (metric.periods ?? []).map((period, index) => ({ token: periodToken(period), value: metric.values?.[index] ?? null }))
    .filter((point): point is { token: string; value: number } => {
      if (!point.token || point.value === null || !Number.isFinite(point.value)) return false;
      return !quarter || point.token <= quarter;
    });
  if (points.length < 8) return null;
  const recent = points.slice(-4).reduce((sum, point) => sum + point.value, 0) / 4;
  const previous = points.slice(-8, -4).reduce((sum, point) => sum + point.value, 0) / 4;
  if (previous === 0) return null;
  return (recent - previous) / Math.abs(previous);
}

function volatilityScore(metric: Metric | undefined, quarter: string | null) {
  if (!metric?.values?.length) return null;
  const points = (metric.periods ?? []).map((period, index) => ({ token: periodToken(period), value: metric.values?.[index] ?? null }))
    .filter((point): point is { token: string; value: number } => {
      if (!point.token || point.value === null || !Number.isFinite(point.value)) return false;
      return !quarter || point.token <= quarter;
    }).slice(-9);
  if (points.length < 5) return null;
  const changes = points.slice(1).map((point, index) => points[index].value === 0 ? 0 : (point.value - points[index].value) / Math.abs(points[index].value));
  const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  const deviation = Math.sqrt(changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / changes.length);
  if (deviation <= 0.08) return 90;
  if (deviation <= 0.18) return 75;
  if (deviation <= 0.3) return 55;
  return 35;
}

function estimatedGrade(score: number | null) {
  if (score === null) return "N/D";
  if (score >= 90) return "AAA";
  if (score >= 85) return "AA+";
  if (score >= 80) return "AA";
  if (score >= 75) return "AA-";
  if (score >= 70) return "A+";
  if (score >= 65) return "A";
  if (score >= 60) return "A-";
  if (score >= 52) return "BBB";
  if (score >= 42) return "BB";
  if (score >= 30) return "B";
  return "CCC";
}

function buildEstimatedRating(metrics: Record<string, Metric>, ratios: Record<string, Ratio>, documents: DocumentLineage[], quarter: string | null): EstimatedRating {
  const features: ModelFeature[] = [];
  const add = (label: string, score: number | null, weight = 1) => {
    if (score !== null && Number.isFinite(score)) features.push({ label, score, weight });
  };
  const current = ratioValue(ratios, "currentRatio", quarter);
  const quick = ratioValue(ratios, "quickRatio", quarter);
  const cash = ratioValue(ratios, "cashRatio", quarter);
  const debtAssets = ratioValue(ratios, "debtAssets", quarter);
  const debtEquity = ratioValue(ratios, "debtEquity", quarter);
  const netDebtEbitda = ratioValue(ratios, "netDebtEbitda", quarter);
  const coverage = ratioValue(ratios, "interestCoverage", quarter);
  const roa = ratioValue(ratios, "roa", quarter);
  const roe = ratioValue(ratios, "roe", quarter);
  const roic = ratioValue(ratios, "roic", quarter);
  const fcf = ratioValue(ratios, "fcf", quarter);
  const revenueTrend = trendChange(metrics.revenue, quarter);
  const ebitdaTrend = trendChange(metrics.ebitda, quarter);

  add("Liquidez corriente", tierScore(current, [[2, 95], [1.5, 85], [1.2, 72], [1, 55], [0, 30]]), 1.15);
  add("Liquidez acida", tierScore(quick, [[1.5, 95], [1.1, 82], [0.8, 68], [0.6, 50], [0, 30]]), 1.05);
  add("Liquidez inmediata", tierScore(cash, [[0.75, 95], [0.5, 82], [0.25, 65], [0.1, 48], [0, 30]]), 0.8);
  add("Deuda neta / EBITDA", netDebtEbitda === null ? null : netDebtEbitda <= 0 ? 95 : netDebtEbitda <= 1 ? 85 : netDebtEbitda <= 2 ? 72 : netDebtEbitda <= 3 ? 57 : netDebtEbitda <= 4 ? 40 : 25, 1.25);
  add("Deuda / activos", debtAssets === null ? null : debtAssets <= 0.2 ? 95 : debtAssets <= 0.35 ? 82 : debtAssets <= 0.5 ? 65 : debtAssets <= 0.65 ? 45 : 25, 1.1);
  add("Deuda / patrimonio", debtEquity === null ? null : debtEquity <= 0.35 ? 92 : debtEquity <= 0.7 ? 78 : debtEquity <= 1 ? 62 : debtEquity <= 1.5 ? 42 : 25, 0.7);
  add("Cobertura de intereses", tierScore(coverage, [[8, 95], [5, 85], [3, 72], [2, 55], [1, 35], [0, 20]]), 1.25);
  add("ROA", tierScore(roa, [[10, 92], [5, 80], [2, 68], [0, 55], [-100, 30]]), 0.65);
  add("ROE", tierScore(roe, [[15, 90], [8, 80], [0, 60], [-100, 30]]), 0.55);
  add("ROIC", tierScore(roic, [[15, 92], [10, 84], [5, 70], [0, 55], [-100, 30]]), 0.8);
  add("Flujo de caja libre", fcf === null ? null : fcf > 0 ? 82 : 32, 0.9);
  add("Tendencia de ingresos", tierScore(revenueTrend, [[0.1, 90], [0.03, 76], [-0.03, 60], [-0.1, 44], [-100, 28]]), 0.8);
  add("Tendencia de EBITDA", tierScore(ebitdaTrend, [[0.1, 90], [0.03, 76], [-0.03, 60], [-0.1, 44], [-100, 28]]), 1);
  add("Volatilidad EBITDA", volatilityScore(metrics.ebitda, quarter), 0.45);
  add("Volatilidad de ingresos", volatilityScore(metrics.revenue, quarter), 0.35);

  const totalWeight = features.reduce((sum, feature) => sum + feature.weight, 0);
  const score = features.length ? Math.max(0, Math.min(100, Math.round(features.reduce((sum, feature) => sum + feature.score * feature.weight, 0) / totalWeight))) : null;
  const grade = estimatedGrade(score);
  const trendDelta = [revenueTrend, ebitdaTrend].filter((value): value is number => value !== null).reduce((sum, value, _, values) => sum + value / values.length, 0);
  const riskFlags = [
    current !== null && current < 1 ? "Liquidez corriente bajo 1,0x" : null,
    quick !== null && quick < 1 ? "Liquidez acida bajo 1,0x" : null,
    netDebtEbitda !== null && netDebtEbitda > 3 ? "Apalancamiento neto elevado" : null,
    coverage !== null && coverage < 2 ? "Cobertura de intereses reducida" : null,
    fcf !== null && fcf < 0 ? "Flujo de caja libre negativo" : null,
    roic !== null && roic < 0 ? "ROIC negativo" : null,
  ].filter((value): value is string => Boolean(value));
  const outlook = score === null ? "N/D" : riskFlags.length >= 3 || trendDelta < -0.1 || score < 42 ? "Negativa" : trendDelta > 0.08 && riskFlags.length <= 1 && score >= 60 ? "Positiva" : "Estable";
  const trend = score === null ? "N/D" : trendDelta > 0.05 ? "Mejorando" : trendDelta < -0.05 ? "Deteriorando" : "Estable";
  const confidence = Math.min(95, Math.max(45, 42 + features.length * 3 + Math.min(documents.length, 15)));
  const drivers = [...features].sort((left, right) => right.score - left.score).slice(0, 3).map((feature) => `${feature.label}: ${formatNumber(feature.score, 0)}/100`);
  return { score, rating: grade, confidence, outlook, trend, riskFlags, drivers };
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

function buildNarrative(name: string, metrics: Record<string, Metric>, ratios: Record<string, Ratio>, documents: DocumentLineage[], quarter: string | null, estimate: EstimatedRating, fellerReport?: FellerReport, fellerRatedReport?: FellerReport) {
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
  return {
    overview: `Este informe presenta una lectura tecnica del perfil de credito de ${name} al ${periodLabel(quarter)}. La conclusion se construye a partir de los estados financieros reportados en XBRL, los ratios derivados y una metodologia interna versionada. La referencia externa identificada es ${ratingText}. La clasificacion estimada CMF CreditView es ${estimate.rating}${estimate.score === null ? "" : ` (${estimate.score}/100)`}, con perspectiva estimada ${estimate.outlook}.`,
    operating: revenue !== null || ebitda !== null
      ? `En una base movil de cuatro trimestres, los ingresos alcanzan ${formatMoney(revenue)} y el EBITDA ${formatMoney(ebitda)}${ebitda !== null && revenue ? `, equivalente a un margen EBITDA de ${formatNumber((ebitda / revenue) * 100, 1)}%` : ""}. El ultimo dato de ingresos muestra ${trendWord(revenueChange)} y el EBITDA registra ${trendWord(ebitdaChange)}. La utilidad neta TTM se ubica en ${formatMoney(income)}; la lectura debe complementarse con el analisis de segmentos y de riesgos operacionales, que no se infieren cuando no estan presentes en XBRL.`
      : "No hay una serie XBRL suficiente para construir una lectura operativa en el trimestre seleccionado. El informe conserva esa limitacion de evidencia y no sustituye los valores faltantes.",
    financial: `La posicion financiera al corte registra caja de ${formatMoney(cash)} y deuda financiera de ${formatMoney(debt)}. El endeudamiento neto es ${formatMoney(netDebt)}, con una razon deuda neta a EBITDA de ${formatRatio(netDebtEbitda)}. La liquidez corriente es ${formatRatio(current)} y la liquidez acida ${formatRatio(quick)}. La cobertura de intereses alcanza ${formatRatio(coverage)}, mientras que el flujo operacional es ${formatMoney(ocf)} y el flujo de caja libre ${formatMoney(fcf)}. Estos indicadores describen capacidad financiera observada; no incorporan supuestos de refinanciamiento futuros no documentados.`,
    opinion: `Con la informacion disponible, el perfil se caracteriza por ${strengths.length ? strengths.join(", ") : "fortalezas cuantitativas aun no concluyentes"}. Los principales puntos de atencion son ${weaknesses.length ? weaknesses.join(", ") : "la sensibilidad de los resultados a la evolucion de ingresos, margen y liquidez"}. CMF CreditView estima una clasificacion ${estimate.rating}${estimate.score === null ? "" : ` (${estimate.score}/100)`}, confianza ${estimate.confidence}/100, perspectiva ${estimate.outlook} y tendencia ${estimate.trend}. La perspectiva oficial de una agencia, cuando existe, se presenta separadamente y no altera esta estimacion interna.`,
    strengths: strengths.length ? strengths.map((item) => `La evidencia cuantitativa muestra ${item}.`) : ["No se identifican fortalezas concluyentes con la informacion cuantitativa disponible al corte."],
    weaknesses: weaknesses.length ? weaknesses.map((item) => `Debe monitorearse ${item}.`) : ["La ausencia de ciertos datos operativos o de mercado limita la profundidad de la opinion."],
    catalysts: [
      estimate.outlook === "Positiva" ? "La mejora observada en los indicadores y la tendencia estimada favorecen una reevaluacion al alza si se mantienen durante los siguientes trimestres." : "Una mejora sostenida de ingresos y EBITDA durante los siguientes trimestres seria un catalizador de credito.",
      fcf !== null && fcf > 0 ? "La continuidad del flujo de caja libre positivo permitiria sostener liquidez y reducir necesidades de financiamiento." : "La normalizacion del flujo de caja libre seria relevante para fortalecer la flexibilidad financiera.",
    ],
    risks: [
      ...(estimate.riskFlags.length ? estimate.riskFlags.map((item) => `Riesgo cuantitativo: ${item}.`) : ["No se activaron señales cuantitativas de riesgo en el corte seleccionado."]),
      ...(weaknesses.length ? weaknesses.map((item) => `Debe monitorearse: ${item}.`) : ["La ausencia de ciertos datos operativos o de mercado limita la profundidad de la opinion."]),
    ],
  };
}

async function buildPdf(payload: IssuerPayload, rut: string, selectedQuarter: string | null) {
  const metrics = payload.metrics ?? {};
  const ratios = payload.ratios ?? {};
  const documents = payload.lineage?.documents ?? [];
  const fellerReport = fellerReportAt(payload.feller?.reports, selectedQuarter);
  const fellerRatedReport = fellerRatedReportAt(payload.feller?.reports, selectedQuarter);
  const estimate = buildEstimatedRating(metrics, ratios, documents, selectedQuarter);
  const narrative = buildNarrative(payload.name ?? "Emisor", metrics, ratios, documents, selectedQuarter, estimate, fellerReport, fellerRatedReport);
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
    page.drawRectangle({ x: MARGIN + 18, y: 204, width: PAGE_WIDTH - 2 * MARGIN - 36, height: 176, color: COLORS.navy2, borderColor: rgb(0.24, 0.31, 0.37), borderWidth: 0.8 });
    drawLabel(page, "CORTE DEL INFORME", MARGIN + 35, 350, fonts, COLORS.gold);
    drawText(page, periodLabel(selectedQuarter), MARGIN + 35, 315, fonts.bold, 24, COLORS.white);
    drawText(page, `Estados financieros XBRL: ${documents.length} documentos`, MARGIN + 35, 288, fonts.regular, 9.5, rgb(0.78, 0.82, 0.86));
    drawText(page, `Referencia Feller Rate: ${fellerRatedReport?.rating ?? "N/D"}  |  Perspectiva: ${fellerRatedReport?.outlook || "N/D"}`, MARGIN + 35, 270, fonts.regular, 9.5, rgb(0.78, 0.82, 0.86));
    drawText(page, `Clasificacion estimada CMF CreditView: ${estimate.rating}`, MARGIN + 35, 249, fonts.bold, 10.5, COLORS.gold);
    drawText(page, `Score ${estimate.score === null ? "N/D" : `${estimate.score}/100`}  |  Confianza ${estimate.confidence}/100`, MARGIN + 35, 232, fonts.regular, 9.5, COLORS.white);
    drawText(page, `Perspectiva estimada: ${estimate.outlook}  |  Tendencia: ${estimate.trend}`, MARGIN + 35, 217, fonts.regular, 9.5, COLORS.white);
    drawText(page, "Documento informativo basado exclusivamente en fuentes publicas.", MARGIN + 18, 88, fonts.italic, 8.5, rgb(0.68, 0.73, 0.78));
    drawText(page, "CMF CreditView  |  01", PAGE_WIDTH - MARGIN - 82, 40, fonts.regular, 8, rgb(0.68, 0.73, 0.78));
  }

  // Resumen ejecutivo
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Resumen ejecutivo", `${payload.name ?? "Emisor"}  |  ${periodLabel(selectedQuarter)}`, pageNumber);
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

  // Estimated classification
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Clasificacion y perspectiva", `${payload.name ?? "Emisor"}  |  Estimacion CMF CreditView`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    drawCallout(page, "Resultado estimado", `La clasificacion estimada se obtiene de liquidez, apalancamiento, cobertura, rentabilidad, flujo de caja, tendencia y volatilidad de los estados financieros. Resultado: ${estimate.rating}${estimate.score === null ? "" : ` (${estimate.score}/100)`}. Confianza: ${estimate.confidence}/100.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, 78, fonts, COLORS.paleGold);
    y -= 108;
    y = drawSectionTitle(page, "Clasificacion estimada CMF CreditView", MARGIN, y, fonts);
    drawText(page, estimate.rating, MARGIN, y - 31, fonts.bold, 32, COLORS.navy);
    drawText(page, `Score ${estimate.score === null ? "N/D" : `${estimate.score}/100`}`, MARGIN + 96, y - 20, fonts.bold, 12, COLORS.gold);
    drawText(page, `Confianza ${estimate.confidence}/100`, MARGIN + 96, y - 40, fonts.regular, 8.5, COLORS.muted);
    drawText(page, `Perspectiva estimada: ${estimate.outlook}`, MARGIN + 240, y - 20, fonts.bold, 11, COLORS.teal);
    drawText(page, `Tendencia: ${estimate.trend}`, MARGIN + 240, y - 40, fonts.regular, 8.5, COLORS.muted);
    y -= 82;
    y = drawSectionTitle(page, "Factores determinantes", MARGIN, y, fonts);
    const driverRows = estimate.drivers.length ? estimate.drivers.map((driver) => {
      const parts = driver.split(": ");
      return [parts[0], parts.slice(1).join(": ")];
    }) : [["Cobertura de datos", "Insuficiente para emitir una estimacion"]];
    y = drawTable(page, ["Factor", "Resultado del modelo"], driverRows, MARGIN, y, [205, 324], fonts, 25) - 28;
    y = drawSectionTitle(page, "Perspectiva estimada", MARGIN, y, fonts);
    y = drawParagraph(page, estimate.outlook === "N/D" ? "No existe evidencia suficiente para estimar una perspectiva en el trimestre seleccionado." : `La perspectiva estimada es ${estimate.outlook} y la tendencia ${estimate.trend}. Esta salida se deriva exclusivamente de la trayectoria cuantitativa observada; no copia ni reemplaza la perspectiva publicada por una agencia.`, MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 9.3, 14);
    y = drawSectionTitle(page, "Referencia oficial separada", MARGIN, y, fonts);
    const ratingRows = fellerReport || fellerRatedReport
      ? (fellerReport?.classificationRows?.length ? fellerReport.classificationRows : [{ instrument: "Solvencia", date: fellerRatedReport?.publishedAt ?? "N/D", rating: fellerRatedReport?.rating ?? "N/D", outlook: fellerRatedReport?.outlook ?? "N/D" }]).slice(0, 4).map((row) => [row.instrument ?? "Instrumento", row.rating ?? "N/D", row.outlook || "N/D", row.date ?? fellerReport?.publishedAt ?? "N/D"])
      : [["Solvencia", "N/D", "N/D", "Sin referencia"]];
    y = drawTable(page, ["Instrumento", "Clasificacion", "Perspectiva", "Fecha"], ratingRows, MARGIN, y, [170, 90, 150, 119], fonts, 24) - 18;
    drawParagraph(page, fellerRatedReport?.rating && fellerRatedReport.rating !== estimate.rating ? `La referencia oficial ${fellerRatedReport.rating} de Feller Rate difiere de la estimacion ${estimate.rating} de CMF CreditView. La diferencia responde a que el modelo interno pondera ratios y tendencias observadas al corte, mientras que la agencia incorpora su propia metodologia, escenarios y juicio cualitativo.` : "La referencia oficial y la estimacion interna se mantienen separadas; no se interpreta la ausencia de una referencia como una clasificacion.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.5, 12, COLORS.muted);
  }

  // Opinion crediticia
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Opinion crediticia", `${payload.name ?? "Emisor"}  |  Fortalezas, riesgos y escenarios`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Fortalezas crediticias", MARGIN, y, fonts);
    for (const item of narrative.strengths) y = drawParagraph(page, `+  ${item}`, MARGIN + 8, y, PAGE_WIDTH - 2 * MARGIN - 8, fonts, 9.3, 14, COLORS.green);
    y -= 3;
    y = drawSectionTitle(page, "Debilidades y riesgos", MARGIN, y, fonts);
    for (const item of narrative.weaknesses) y = drawParagraph(page, `-  ${item}`, MARGIN + 8, y, PAGE_WIDTH - 2 * MARGIN - 8, fonts, 9.3, 14, COLORS.red);
    y -= 4;
    const half = (PAGE_WIDTH - 2 * MARGIN - 14) / 2;
    drawCallout(page, "Catalizadores", narrative.catalysts.join(" "), MARGIN, y, half, 98, fonts, COLORS.pale);
    drawCallout(page, "Riesgos clave", narrative.risks.slice(0, 2).join(" "), MARGIN + half + 14, y, half, 98, fonts, COLORS.paleGold);
    y -= 132;
    y = drawSectionTitle(page, "Evaluacion por dimensiones", MARGIN, y, fonts);
    const current = ratioValue(ratios, "currentRatio", selectedQuarter);
    const coverage = ratioValue(ratios, "interestCoverage", selectedQuarter);
    const debtAssets = ratioValue(ratios, "debtAssets", selectedQuarter);
    const liquidityText = current === null ? "No concluyente por falta de ratio" : current >= 1.2 ? "Adecuada en la lectura corriente" : "Presionada en la lectura corriente";
    const financialText = coverage === null || debtAssets === null ? "No concluyente por variables faltantes" : coverage >= 3 && debtAssets < 0.5 ? "Capacidad financiera favorable" : "Requiere seguimiento de cobertura y endeudamiento";
    drawTable(page, ["Dimension", "Evaluacion", "Evidencia al corte"], [
      ["Liquidez", liquidityText, `Liquidez corriente ${formatRatio(current)}; liquidez acida ${formatRatio(ratioValue(ratios, "quickRatio", selectedQuarter))}`],
      ["Riesgo financiero", financialText, `Cobertura ${formatRatio(coverage)}; deuda/activos ${formatRatio(debtAssets)}`],
      ["Generacion de caja", fcfText(ratioValue(ratios, "fcf", selectedQuarter)), `Flujo libre ${formatMoney(ratioValue(ratios, "fcf", selectedQuarter))}; flujo operacional ${formatMoney(ratioValue(ratios, "operatingCashFlow", selectedQuarter))}`],
    ], MARGIN, y - 5, [120, 190, 189], fonts, 31);
  }

  // Financial profile
  pageNumber += 1;
  {
    const page = addPage(pdf, fonts, "Perfil financiero", `${payload.name ?? "Emisor"}  |  Flujo y posicion financiera`, pageNumber);
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
    const page = addPage(pdf, fonts, "Indicadores de credito", `${payload.name ?? "Emisor"}  |  Ratios derivados`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Ratios de credito", MARGIN, y, fonts);
    y = drawParagraph(page, "Los indicadores se calculan sobre conceptos identificados en los estados financieros XBRL. Un valor N/D significa que el concepto requerido no fue reportado o no pudo validarse para el corte; no se reemplaza por un supuesto.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.9, 13, COLORS.muted);
    const liquidityRows = [
      ["Liquidez corriente", formatRatio(ratioValue(ratios, "currentRatio", selectedQuarter)), "Activo corriente / pasivo corriente"],
      ["Liquidez acida", formatRatio(ratioValue(ratios, "quickRatio", selectedQuarter)), "Liquidez sin inventarios"],
      ["Liquidez inmediata", formatRatio(ratioValue(ratios, "cashRatio", selectedQuarter)), "Caja / pasivo corriente"],
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
    const page = addPage(pdf, fonts, "Historial financiero", `${payload.name ?? "Emisor"}  |  Tendencia trimestral`, pageNumber);
    let y = PAGE_HEIGHT - 112;
    y = drawSectionTitle(page, "Evolucion de ingresos y EBITDA", MARGIN, y, fonts);
    y = drawParagraph(page, "La historia se muestra en base trimestral para conservar la señal de tendencia. El grafico compara magnitudes relativas; las tablas del resto del informe contienen los valores numericos.", MARGIN, y, PAGE_WIDTH - 2 * MARGIN, fonts, 8.8, 13, COLORS.muted);
    const history = (metrics.revenue?.periods ?? []).map((period, index) => ({ period, token: periodToken(period), revenue: metrics.revenue?.values?.[index] ?? null, ebitda: metrics.ebitda?.values?.[index] ?? null }))
      .filter((point): point is { period: string; token: string; revenue: number; ebitda: number } => {
        if (!point.token || point.revenue === null || point.ebitda === null || !Number.isFinite(point.revenue) || !Number.isFinite(point.ebitda)) return false;
        return !selectedQuarter || point.token <= selectedQuarter;
      }).slice(-12);
    drawBars(page, history.map((point) => point.revenue), history.map((point) => periodLabel(point.period)), MARGIN, y - 10, PAGE_WIDTH - 2 * MARGIN, 96, fonts, COLORS.gold);
    drawText(page, "Ingresos", MARGIN, y - 119, fonts.bold, 7.5, COLORS.gold);
    drawBars(page, history.map((point) => point.ebitda), history.map((point) => periodLabel(point.period)), MARGIN, y - 143, PAGE_WIDTH - 2 * MARGIN, 96, fonts, COLORS.teal);
    drawText(page, "EBITDA", MARGIN, y - 252, fonts.bold, 7.5, COLORS.teal);
    y -= 278;
    y = drawSectionTitle(page, "Ultimos trimestres", MARGIN, y, fonts);
    const historyRows = history.slice(-8).map((point) => [periodLabel(point.period), formatMoney(point.revenue), formatMoney(point.ebitda), point.revenue ? `${formatNumber((point.ebitda / point.revenue) * 100, 1)}%` : "N/D"]);
    drawTable(page, ["Periodo", "Ingresos", "EBITDA", "Margen"], historyRows, MARGIN, y, [100, 150, 150, 99], fonts, 25);
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
