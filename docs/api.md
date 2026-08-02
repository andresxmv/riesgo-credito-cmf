# Contratos iniciales de API

Base URL: `/api/v1`.

| Endpoint | Uso |
| --- | --- |
| `GET /search?q=&cursor=` | Búsqueda paginada por nombre, RUT, ticker, ISIN o bono. |
| `GET /issuer/{issuer_id}` | Identidad, metadatos, rating vigente y resumen de crédito. |
| `GET /issuer/{issuer_id}/history?metric=&from=&to=` | Serie trimestral normalizada. |
| `GET /issuer/{issuer_id}/ratios?period=` | Ratios auditables y inputs. |
| `GET /issuer/{issuer_id}/ratings` | Ratings oficiales por agencia y rating interno separado. |
| `GET /issuer/{issuer_id}/events?cursor=` | Hechos, bonos, dividendos y cambios corporativos. |
| `GET /issuer/{issuer_id}/analysis` | Executive summary, opinión y risk flags versionados. |
| `GET /issuer/{issuer_id}/financials` | Estados financieros normalizados. |
| `GET /issuer/{issuer_id}/documents/{document_id}` | Metadata y descarga autorizada. |
| `POST /compare` | Compara emisores o bonos con un esquema de métricas explícito. |
| `POST /issuer/{issuer_id}/pdf` | Solicita un informe ReportLab y devuelve un job id. |

Todas las respuestas deben incluir `as_of`, `source_lineage` y `calculation_version` cuando corresponda. Los endpoints públicos no aceptan URLs arbitrarias de CMF.
