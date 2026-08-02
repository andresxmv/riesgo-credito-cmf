# Modelo de datos propuesto

Las tablas usan UUID interno cuando la fuente no garantiza una clave estable y conservan la clave externa de CMF como campo único cuando existe. Las tablas temporales incluyen `source_updated_at`, `ingested_at`, `valid_from` y `source_document_id`.

## Entidades

| Tabla | Propósito | Índices principales |
| --- | --- | --- |
| `issuer` | Identidad, RUT, ticker, ISIN, sector e industria | `rut`, `ticker`, `isin`, `name` |
| `quarter` | Catálogo de períodos y fecha de cierre | `fiscal_year`, `quarter_code`, `period_end` |
| `financial_statement` | Registro del EEFF, formato, moneda y documento | `issuer_id`, `quarter_id`, `statement_type` |
| `income_statement` | Ingresos, EBITDA, EBIT, utilidad y márgenes | `financial_statement_id` |
| `cashflow` | CFO, capex, FCF y dividendos pagados | `financial_statement_id` |
| `ratios` | Ratios normalizados y versionados | `issuer_id`, `quarter_id`, `ratio_name` |
| `credit_rating` | Opinión oficial agregada por agencia | `issuer_id`, `agency_id`, `effective_date` |
| `agency_rating` | Catálogo de agencias | `agency_code` |
| `essential_fact` | Hechos esenciales públicos | `issuer_id`, `published_at`, `fact_type` |
| `management_discussion` | Análisis razonado y texto extraído | `issuer_id`, `quarter_id`, `document_id` |
| `bond_issue` | Emisión, monto, tasa, moneda y estado | `issuer_id`, `issue_code`, `maturity_date` |
| `news` | Eventos derivados y enlaces a fuente | `issuer_id`, `published_at`, `event_type` |
| `sector` / `industry` | Taxonomía de clasificación | `code` |
| `audit` | Auditor, opinión y fecha | `issuer_id`, `financial_statement_id` |

## Reglas de consistencia

- Un emisor puede tener varios registros de rating por agencia, pero solo una opinión vigente por fecha efectiva.
- Un ratio se calcula con un snapshot de inputs y guarda `calculation_version`.
- Las cifras TTM se calculan a partir de cuatro trimestres consecutivos; no se mezclan períodos fiscales incompatibles.
- Una corrección documental genera una nueva versión, no una mutación silenciosa.
