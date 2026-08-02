# Deployment y gates de aceptación

## Target

- Frontend: Vercel/Sites con build reproducible.
- API: FastAPI en Render.
- Base de datos: Supabase PostgreSQL.
- Cache: Redis administrado.
- Jobs: worker Python separado con scheduler.
- CI: GitHub Actions para lint, tipos, pytest, Vitest, Playwright y build.

## Gates

1. El build del frontend debe pasar sin consultar fuentes externas en runtime.
2. `pytest` debe cubrir parsing, deduplicación, ratios y modelo interno.
3. `Vitest` debe cubrir transformaciones de view model y estados de rating.
4. `Playwright` debe validar búsqueda, cambio de métrica, tema y generación de PDF.
5. El pipeline debe fallar si falta trazabilidad de fuente o si el score interno aparece sin el rótulo de estimado.
6. Un smoke test debe verificar que un emisor nuevo aparece en búsqueda después de un ciclo ETL.

## Estado actual

La entrega visual está lista y el build del sitio pasa. ETL, FastAPI, Supabase, Redis, ReportLab y las suites de cobertura >90% permanecen como la siguiente fase de implementación; el contrato ya está separado para que la conexión no obligue a rediseñar la superficie.
