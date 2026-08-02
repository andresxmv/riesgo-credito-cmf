import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ rut: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { rut } = await context.params;
  const apiBase = process.env.CMF_API_URL?.replace(/\/$/, "");

  if (!apiBase) {
    return Response.json(
      {
        error: "CMF_API_URL no está configurada en Vercel",
        issuer_rut: rut,
      },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetch(`${apiBase}/api/issuer/${encodeURIComponent(rut)}/financials`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json(
      { error: "No fue posible conectar con la API de CMF CreditView", issuer_rut: rut },
      { status: 502 },
    );
  }
}
