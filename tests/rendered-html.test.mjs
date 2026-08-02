import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CreditView issuer surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CMF CreditView/i);
  assert.match(html, /Cencosud S\.A\./i);
  assert.match(html, /346(?:<!-- -->)?\s*emisores vigentes/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("does not retain the disposable starter skeleton", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /creditview-shell/);
  assert.match(page, /issuerCatalog/);
  assert.match(page, /MAESTRO DE EMISORES CMF/);
  assert.match(page, /Deuda neta \/ EBITDA/);
  assert.match(page, /Cobertura de intereses/);
  assert.match(page, /Liquidez corriente/);
  assert.match(page, /Clasificaciones oficiales/);
  assert.doesNotMatch(page, /SkeletonPreview|_sites-preview/);
  assert.match(layout, /title:\s*"CMF CreditView/);
  assert.match(layout, /Inteligencia crediticia para Chile/);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
});
