# CMF CreditView

Superficie profesional de análisis de riesgo de crédito para emisores chilenos. La primera entrega implementa la capa de producto y su lenguaje visual tipo terminal de crédito: navegación lateral, búsqueda global, ficha de emisor, ratings oficiales separados del modelo interno, historia trimestral, memo analítico y timeline de eventos.

> La vista actual utiliza un `reference dataset` explícitamente rotulado. No representa todavía datos productivos ni consulta la CMF desde el navegador.

## Estado de la entrega

### Implementado

- Shell tipo Bloomberg Credit / CreditView, sin patrón de dashboard de tarjetas gigantes.
- Tema oscuro y claro, layout responsive y densidad configurable.
- Navegación de workspace, buscador global con `⌘ K`, seguimiento de emisor y generación visual de informe.
- Ficha de emisor con identidad, sector, industria, ISIN, auditor, market cap y moneda.
- KPIs de crédito: ingresos TTM, EBITDA, leverage, cobertura, liquidez, ROIC, FCF y deuda/activos.
- Historia de 20 trimestres con selector de métrica y ventana 5Y/20Q.
- Tabla de clasificación oficial por agencia, perspectiva, fecha y fuente.
- Clasificación estimada separada: score, confidence, outlook y trend.
- Credit memo con risk flags, catalizadores y trazabilidad de fuente.
- Timeline de ratings, bonos, refinanciamientos y dividendos.
- Build reproducible con `vinext` y salida compatible con Sites.

### Siguiente capa de producción

La conexión CMF → ETL → Supabase → FastAPI → Next.js se debe activar antes de considerar cumplidos los criterios de cobertura de emisores, historia financiera, PDF institucional y pruebas de extremo a extremo. Los contratos y límites están documentados en [`docs/`](docs/).

## Arquitectura objetivo

```text
CMF public sources
        ↓
Incremental ETL (Python · lxml · httpx · tenacity · APScheduler)
        ↓
Supabase PostgreSQL + object storage for source documents
        ↓
FastAPI · validation · rate limit · cached read models
        ↓
Next.js / React · Server Components · TanStack Query
```

El navegador nunca consulta directamente a la CMF. Los documentos y hechos se incorporan con checksum, timestamp, fuente y estado de extracción para que el proceso sea idempotente.

## Desarrollo local

Requisitos: Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
```

## Estructura relevante

- `app/page.tsx`: primera superficie interactiva de CreditView y dataset de referencia aislado.
- `app/globals.css`: sistema visual, densidad, estados, tablas, gráficos y responsive.
- `app/layout.tsx`: metadata y marco global.
- `docs/architecture.md`: límites de los servicios y flujo de datos.
- `docs/data-model.md`: entidades, claves e índices propuestos.
- `docs/etl.md`: estrategia incremental e idempotente.
- `docs/api.md`: contratos iniciales de FastAPI.
- `docs/deployment.md`: despliegue objetivo y gates de aceptación.

## Nota de datos

Los valores visibles en la primera versión están diseñados para probar la jerarquía, densidad y estados de la interfaz. Cuando se conecte el ETL, deben reemplazarse por registros validados de la CMF y conservarse la línea de procedencia en cada respuesta, rating, ratio y documento.
