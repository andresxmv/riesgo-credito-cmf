import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ rut: string }> };

function cleanRut(value: string) {
  const normalized = value.replace(/\./g, "").toUpperCase();
  return normalized.split("-", 1)[0].replace(/[^0-9]/g, "");
}

async function readFreeDataset(rut: string) {
  try {
    const raw = await readFile(join(process.cwd(), "public", "data", "cmf-financials.json"), "utf8");
    const dataset = JSON.parse(raw) as {
      issuers?: Record<string, Record<string, unknown>>;
    };
    const normalized = cleanRut(rut);
    const payload = dataset.issuers?.[normalized];
    if (!payload) return null;
    return { issuer_rut: normalized, ...payload };
  } catch {
    return null;
  }
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { rut } = await context.params;
  const apiBase = process.env.CMF_API_URL?.replace(/\/$/, "");

  if (!apiBase) {
    const localPayload = await readFreeDataset(rut);
    if (localPayload) return Response.json(localPayload, { headers: { "cache-control": "public, max-age=300" } });
    return Response.json(
      { error: "No hay read model CMF XBRL publicado para este emisor", issuer_rut: rut },
      { status: 404 },
    );
  }

  try {
    const upstream = await fetch(`${apiBase}/api/issuer/${encodeURIComponent(rut)}/financials`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    const localPayload = await readFreeDataset(rut);
    if (localPayload) return Response.json(localPayload, { headers: { "cache-control": "public, max-age=300" } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    const localPayload = await readFreeDataset(rut);
    if (localPayload) return Response.json(localPayload, { headers: { "cache-control": "public, max-age=300" } });
    return Response.json(
      { error: "No fue posible conectar con la API de CMF CreditView", issuer_rut: rut },
      { status: 502 },
    );
  }
}
