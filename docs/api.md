# Contratos iniciales de API

Base URL de FastAPI: `/`. El proxy de Next.js expone al navegador solamente las rutas necesarias.

| Endpoint | Uso |
| --- | --- |
| `GET /health` | Health check del servicio y de la base local. |
| `GET /api/issuer/{rut}` | Identidad de datos, metricas, ratings, eventos y lineage. |
| `GET /api/issuer/{rut}/financials` | Series financieras normalizadas desde XBRL. |
| `GET /api/issuer/{rut}/history?metric=` | Serie historica de una metrica. |
| `GET /search?q=&cursor=` | Busqueda paginada por nombre, RUT, ticker, ISIN o bono. |
| `GET /issuer/{issuer_id}/ratios?period=` | Ratios auditables y sus inputs. |
| `GET /issuer/{issuer_id}/ratings` | Ratings oficiales por agencia y rating interno separado. |
| `GET /issuer/{issuer_id}/events?cursor=` | Hechos, bonos, dividendos y cambios corporativos. |
| `GET /issuer/{issuer_id}/analysis` | Executive summary, opinion y risk flags versionados. |
| `POST /compare` | Compara emisores o bonos con un esquema explicito de metricas. |
| `POST /issuer/{issuer_id}/pdf` | Solicita un informe ReportLab y devuelve un job id. |

## Estado

Implementado en este vertical slice: `/health`, `/api/issuer/{rut}`, `/api/issuer/{rut}/financials` y `/api/issuer/{rut}/history`.

Las rutas de ratings, eventos, ratios derivados, analisis y PDF son contratos pendientes de sus respectivos parsers y reglas versionadas. No deben responder con datos de ejemplo.

Las respuestas financieras incluyen `hasXbrl`, `metrics`, `lineage.documents[].sourceUrl`, `contentHash` y `retrievedAt`. La unidad se conserva desde la instancia XBRL; la API no convierte automaticamente USD, EUR o CLP.
