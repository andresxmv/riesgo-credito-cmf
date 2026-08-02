# Arquitectura de CMF CreditView

## Principios

1. La CMF es una fuente de ingestión, no una dependencia de runtime del navegador.
2. Cada documento se identifica por URL canónica, checksum, período, emisor y fecha de captura.
3. Las cifras normalizadas conservan el valor reportado, la unidad, la moneda, el período y el origen XBRL/IFRS.
4. Ratings de agencias y rating interno son dominios distintos y nunca se presentan como equivalentes.
5. Toda salida analítica debe poder regresar a un registro financiero o documento fuente.

## Capas

### Ingestión

Workers Python descargan listados de emisores, EEFF trimestrales, XBRL, análisis razonados, hechos esenciales, ratings, bonos y series. `httpx` y `tenacity` manejan timeouts, backoff y reintentos. El scheduler ejecuta jobs incrementales y persiste el estado de cada fuente.

### Persistencia

Supabase PostgreSQL guarda entidades normalizadas, series trimestrales y materializaciones para lectura. Redis conserva búsquedas, ratios recientes y respuestas de baja volatilidad. Los documentos originales deben almacenarse con metadatos de contenido y hash.

### API

FastAPI expone contratos versionados para búsqueda, emisor, historia, ratios, ratings, eventos, comparación y documentos. El acceso a la CMF queda fuera de la API pública; la API sirve únicamente datos incorporados y validados.

### Producto web

Next.js renderiza la primera carga y las vistas de lectura en servidor. Interacciones locales —métrica, período, watchlist y tema— permanecen en el cliente. La futura capa de datos reemplazará el reference dataset por hooks de TanStack Query sin cambiar la jerarquía visual.

## Flujos de lectura

```text
/api/search ─────────────┐
/api/issuer ─────────────┼─→ issuer view model ─→ ficha del emisor
/api/financials ─────────┤
/api/rating ─────────────┤
/api/events ─────────────┘

/api/analysis ─────────────→ credit memo + risk flags + outlook interno
/api/pdf ──────────────────→ ReportLab report package
```

## Controles operativos

- Correlation ID por request y job de ETL.
- Logs estructurados en JSON.
- Rate limit para búsqueda y generación de PDF.
- Timeouts separados para CMF, base de datos, Redis y ReportLab.
- Métricas de freshness por emisor, período y dataset.
