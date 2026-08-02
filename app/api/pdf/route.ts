import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Metric = { values?: number[]; periods?: string[]; unit?: string };
type Ratio = { value?: number | null; unit?: string; period?: string | null; available?: boolean };
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
  };
  sourceUrl?: string;
  pdfUrl?: string;
};
type IssuerPayload = {
  name?: string;
  hasXbrl?: boolean;
  metrics?: Record<string, Metric>;
  ratios?: Record<string, Ratio>;
  lineage?: { source?: string; documents?: { period: string; sourceUrl: string; contentHash: string; retrievedAt: string }[] };
  feller?: { profileUrl?: string; reports?: FellerReport[] };
};

function cleanRut(value: string) {
  return value.replace(/\./g, "").split("-", 1)[0].replace(/[^0-9]/g, "");
}

function ascii(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[·•]/g, "-")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[^ -~]/g, "");
}

function escapePdf(value: string) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/D";
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value);
}

function periodLabel(value: string | null | undefined) {
  if (!value) return "N/D";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? value.match(/^(\d{4})(\d{2})$/);
  if (!match) return value;
  const year = match[1];
  const month = Number(match[2]);
  return `${Math.ceil(month / 3)}T${year}`;
}

function periodToken(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{6}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}${match[2]}` : null;
}

function requestedQuarter(value: string | null) {
  return value && /^\d{4}(03|06|09|12)$/.test(value) ? value : null;
}

function selectQuarter(requested: string | null, periods: string[]) {
  const available = [...new Set(periods.map(periodToken).filter((period): period is string => Boolean(period)))].sort();
  if (!available.length) return requested ?? null;
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
  if (!ratio?.available || ratio.value === null || ratio.value === undefined) return null;
  const series = (ratio as Ratio & { series?: { period: string; value: number }[] }).series ?? [];
  if (!quarter || !series.length) return ratio.value;
  const selected = series.filter((point) => {
    const token = periodToken(point.period);
    return token && token <= quarter;
  });
  return selected.at(-1)?.value ?? ratio.value;
}

function fellerReportAt(reports: FellerReport[] | undefined, quarter: string | null) {
  const sorted = [...(reports ?? [])].sort((left, right) => (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""));
  if (!quarter) return sorted.at(-1);
  return sorted.filter((report) => (report.publishedAt ?? "").replace(/-/g, "").slice(0, 6) <= quarter).at(-1) ?? sorted[0];
}

function linesForPage(title: string, subtitle: string, lines: string[]) {
  const output = [
    "CMF CREDITVIEW",
    title,
    subtitle,
    "",
    ...lines,
    "",
    "Fuente: CMF XBRL publico | Read model incremental | No se consulto la CMF desde el navegador",
  ];
  const wrapped: string[] = [];
  for (const line of output) {
    if (!line) {
      wrapped.push("");
      continue;
    }
    let remaining = ascii(line);
    while (remaining.length > 92) {
      const cut = remaining.lastIndexOf(" ", 92);
      const index = cut > 20 ? cut : 92;
      wrapped.push(remaining.slice(0, index));
      remaining = remaining.slice(index).trimStart();
    }
    wrapped.push(remaining);
  }
  return wrapped;
}

function buildPdf(pages: string[][]) {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((lines, index) => {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    const commands = ["BT", "/F1 10 Tf", "50 790 Td"];
    lines.forEach((line, lineIndex) => {
      if (lineIndex === 0) commands.push("/F1 9 Tf", `(${escapePdf(line)}) Tj`, "/F1 18 Tf", "0 -30 Td");
      else if (lineIndex === 1) commands.push(`(${escapePdf(line)}) Tj`, "/F1 11 Tf", "0 -22 Td");
      else if (lineIndex === 2) commands.push(`(${escapePdf(line)}) Tj`, "/F1 9 Tf", "0 -28 Td");
      else commands.push(`(${escapePdf(line)}) Tj`, "0 -16 Td");
    });
    commands.push("ET");
    const stream = commands.join("\n");
    objects[pageObject - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`;
    objects[contentObject - 1] = `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "binary");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

export async function GET(request: NextRequest) {
  const rut = cleanRut(new URL(request.url).searchParams.get("rut") ?? "");
  const requested = requestedQuarter(new URL(request.url).searchParams.get("quarter"));
  if (!rut) return Response.json({ error: "RUT requerido" }, { status: 400 });

  try {
    const raw = await readFile(join(process.cwd(), "public", "data", "cmf-financials.json"), "utf8");
    const dataset = JSON.parse(raw) as { issuers?: Record<string, IssuerPayload> };
    const payload = dataset.issuers?.[rut];
    if (!payload) return Response.json({ error: "Emisor no encontrado", issuer_rut: rut }, { status: 404 });

    const metrics = payload.metrics ?? {};
    const ratios = payload.ratios ?? {};
    const documents = payload.lineage?.documents ?? [];
    const allPeriods = Object.values(metrics).flatMap((metric) => metric.periods ?? []);
    const selectedQuarter = selectQuarter(requested, [...allPeriods, ...documents.map((document) => document.period)]);
    const fellerReport = fellerReportAt(payload.feller?.reports, selectedQuarter);
    const fellerSignals = fellerReport?.technicalSignals;
    const fellerRows = fellerReport?.classificationRows ?? [];
    const fellerTechnicalLines = fellerReport
      ? [
          `Informe Feller Rate: ${fellerReport.publishedAt ?? "fecha no informada"}`,
          `Rating de solvencia: ${fellerReport.rating ?? "N/D"} | Perspectiva: ${fellerReport.outlook ?? "N/D"} | Watch: ${fellerReport.watch ?? "N/D"}`,
          `Instrumentos observados: ${fellerRows.map((row) => `${row.instrument ?? "Instrumento"} ${row.rating ?? "N/D"}`).join("; ") || "N/D"}`,
          `Ejes técnicos: ${fellerSignals?.topics?.join(", ") || "N/D"}`,
          `Escenarios: base ${fellerSignals?.hasBaseScenario ? "sí" : "no"}; baja ${fellerSignals?.hasDownsideScenario ? "sí" : "no"}; alza ${fellerSignals?.hasUpsideScenario ? "sí" : "no"}`,
          `Fuente técnica: ${fellerReport.sourceUrl ?? payload.feller?.profileUrl ?? "N/D"}`,
        ]
      : ["No hay informe Feller público asociado al trimestre seleccionado."];
    const pages = [
      linesForPage("Credit report", `${payload.name ?? "Emisor"} | RUT ${rut}`, [
        "Executive summary",
        payload.hasXbrl ? `EEFF XBRL disponibles: ${documents.length} documentos` : "No hay EEFF XBRL incorporados para este emisor",
        `Trimestre analizado: ${periodLabel(selectedQuarter)}`,
        `Informe Feller utilizado: ${fellerReport?.publishedAt ?? "No disponible"}`,
        `Perspectiva Feller: ${fellerReport?.outlook ?? "N/D"}`,
        "Este documento presenta valores reportados y ratios derivados del read model CMF XBRL.",
        "No reemplaza una opinion de clasificacion de riesgo.",
      ]),
      linesForPage("Feller technical reference", `${payload.name ?? "Emisor"} | Base externa para el análisis`, fellerTechnicalLines),
      linesForPage("Key financials", `${payload.name ?? "Emisor"} | Valores publicados en XBRL`, Object.entries(metrics).map(([key, metric]) => {
        return `${key.padEnd(22)} ${formatNumber(metricAt(metric, selectedQuarter))} ${metric.unit ?? ""} | ${periodLabel(selectedQuarter)}`;
      })),
      linesForPage("Credit ratios", `${payload.name ?? "Emisor"} | Derivados de estados financieros`, Object.entries(ratios).map(([key, ratio]) => {
        const value = ratio.available ? formatNumber(ratioAt(ratio, selectedQuarter)) : "N/D";
        return `${key.padEnd(22)} ${value} ${ratio.unit ?? ""} | ${periodLabel(selectedQuarter)}`;
      })),
      linesForPage("Financial history", `${payload.name ?? "Emisor"} | Ultimos periodos`, [
        ...["revenue", "ebitda", "ebit", "income", "cash", "debt"].flatMap((key) => {
          const metric = metrics[key];
          if (!metric) return [`${key}: N/D`];
          return (metric.periods ?? []).slice(-8).map((period, index) => `${key.padEnd(12)} ${periodLabel(period).padEnd(8)} ${formatNumber(metric.values?.slice(-8)[index])} ${metric.unit ?? ""}`);
        }),
      ]),
      linesForPage("Source appendix", `${payload.name ?? "Emisor"} | Trazabilidad`, documents.slice(0, 30).flatMap((document) => [
        `${periodLabel(document.period)} | SHA-256 ${document.contentHash}`,
        document.sourceUrl,
      ]).concat(fellerReport ? [`Feller Rate | ${fellerReport.sourceUrl ?? "N/D"}`, `PDF fuente | ${fellerReport.pdfUrl ?? "N/D"}`] : [])),
    ];
    const pdf = buildPdf(pages);
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="cmf-creditview-${rut}-${selectedQuarter ?? "latest"}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "No fue posible generar el PDF" }, { status: 500 });
  }
}
