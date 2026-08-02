# CMF CreditView

Superficie profesional de analisis de riesgo de credito para emisores chilenos. La interfaz usa una densidad tipo Bloomberg CreditView: navegacion lateral, buscador global, ficha de emisor, historia trimestral, ratings oficiales separados del modelo interno y trazabilidad de documentos.

## Flujo real implementado

```text
CMF public sources -> ETL incremental Python -> SQLite/PostgreSQL -> FastAPI -> Next.js
```

- El catalogo local contiene 346 emisores vigentes publicados por la CMF.
- El ETL consulta la pagina oficial del emisor y descarga el ZIP `Estados financieros (XBRL)` por RUT, periodo y balance.
- Se conserva el ZIP original, hash SHA-256, URL de origen y timestamp.
- El parser extrae hechos IFRS/XBRL, contextos, periodos, unidades y dimensiones.
- El manifiesto evita volver a descargar un documento ya ingerido.
- FastAPI sirve solo datos persistidos; el navegador nunca consulta directamente la CMF.
- La ficha solicita `/api/issuer/{rut}/financials` al cambiar de emisor.
- Si la API no esta configurada o no existe el periodo, se muestra estado vacio y no valores inventados.

## Ejecutar

Requisitos: Node.js >=22.13.0 y Python 3.12 (Python 3.9 tambien funciona para el ETL actual).

```bash
npm install
npm run dev

python -m pip install -r api/requirements.txt
python -m etl.cmf_xbrl --rut 61704000 --year 2025 --month 3 --balance C --data-dir data/cmf
uvicorn api.main:app --reload --port 8000
```

La primera descarga guarda los hechos en `data/cmf/cmf.db`; la segunda ejecucion del mismo comando devuelve `skipped`. Para todo el catalogo:

```bash
python -m etl.cmf_xbrl --all --from-year 2017 --to-year 2026 --months 3,6,9,12 --data-dir data/cmf
```

## Variables de despliegue

- `CMF_DB_PATH`: ruta del SQLite que lee FastAPI en desarrollo.
- `CMF_API_URL`: URL publica del servicio FastAPI en Render; se configura en Vercel.
- `CMF_ALLOWED_ORIGINS`: origenes permitidos para FastAPI.

La migracion inicial de Supabase esta en `supabase/migrations/20260802000000_cmf_xbrl.sql`. El servicio Render usa `render.yaml` como base de despliegue.

## Pruebas

```bash
python -m pytest etl/tests api/tests -q
npm run build
node --test tests/rendered-html.test.mjs
```

## Documentacion

- `docs/architecture.md`: limites de los servicios.
- `docs/data-model.md`: entidades e indices.
- `docs/etl.md`: estrategia incremental y parser XBRL.
- `docs/api.md`: contratos de FastAPI.
- `docs/deployment.md`: despliegue y gates.
