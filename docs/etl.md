# ETL incremental CMF

## Job graph

1. `discover_issuers`: actualiza catálogo de emisores y conserva bajas.
2. `discover_periods`: identifica nuevos trimestres y cierres.
3. `fetch_documents`: descarga solo URLs nuevas o con ETag/Last-Modified cambiado.
4. `parse_xbrl`: normaliza hechos IFRS y unidades.
5. `parse_documents`: extrae análisis razonados, hechos esenciales y ratings.
6. `derive_financials`: calcula ratios y vistas TTM.
7. `derive_credit_model`: versiona score, confidence, outlook, trend y risk flags.
8. `publish_read_models`: actualiza materializaciones y cache Redis.

## Catálogo inicial

La primera entrega incluye el snapshot local `app/issuer-catalog.ts` con los 346 emisores vigentes del listado de Emisores de valores de la CMF. Es una semilla de lectura para que el buscador funcione sin consultar la CMF desde el navegador. En producción, `discover_issuers` debe reemplazarlo mediante un job incremental, conservar bajas y registrar `source`, `retrieved_at` y el hash del archivo descargado.

## Idempotencia

Cada elemento de descarga debe tener una clave de deduplicación compuesta por `source`, `canonical_url`, `content_hash`, `issuer_id` y período. Antes de descargar se consulta el estado de la fuente. Si el hash no cambia, se registra un check de freshness y no se vuelve a procesar el documento.

## Manejo de fallos

- Backoff exponencial con jitter y máximo de intentos.
- Dead-letter table para documentos no parseables.
- Parseo parcial permitido solo cuando queda marcado el campo faltante.
- Job resumible por emisor y período.
- Alertas cuando la frescura por tipo de documento supera el SLA.

## Modelo interno

El score 0–100 combina CAPIC 2017, Altman Z, Ohlson O, cobertura de intereses, deuda neta/EBITDA, liquidez, rentabilidad, FCF, tendencias y volatilidades. Cada versión guarda pesos, inputs, missingness y timestamp. La conversión a AAA–CCC se aplica después de calcular el score y se rotula siempre como estimada.
