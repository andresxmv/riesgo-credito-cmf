# Deployment y gates de aceptacion

## Target

- Frontend: Vercel.
- API: FastAPI en Render.
- Base de datos: Supabase PostgreSQL.
- Cache: Redis administrado.
- Jobs: worker Python separado con scheduler.
- CI: GitHub Actions.

## Flujo operativo actual

1. Ejecutar el ETL desde un worker o GitHub Actions con `--all`; el manifiesto evita volver a descargar periodos ya procesados.
2. En desarrollo, FastAPI lee `CMF_DB_PATH`. En produccion, aplicar `supabase/migrations/20260802000000_cmf_xbrl.sql`, configurar `DATABASE_URL` y publicar el read model en PostgreSQL/Supabase.
3. Desplegar FastAPI en Render usando `render.yaml` y comprobar `/health`.
4. Configurar `CMF_API_URL` en Vercel. Next.js llamara al proxy interno, nunca a la CMF.
5. Verificar que un RUT con datos muestra `sourceUrl`, hash y timestamp y que un RUT sin datos muestra estado vacio.

La migracion Supabase fue escrita manualmente porque el CLI no esta instalado en este entorno; debe aplicarse con la herramienta de migraciones del proyecto antes del despliegue productivo.

## Gates

1. El build del frontend debe pasar sin consultar fuentes externas en runtime.
2. Pytest debe cubrir parsing, deduplicacion, unidades y contrato de API.
3. El pipeline debe fallar si falta trazabilidad de fuente.
4. Un smoke test debe verificar que un emisor nuevo aparece en la busqueda despues de un ciclo ETL.
5. El score interno nunca debe aparecer sin rotulo de estimado ni inputs versionados.
