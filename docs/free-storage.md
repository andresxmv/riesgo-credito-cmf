# Almacenamiento sin costo adicional

## Problema

Los 22.401.009 hechos XBRL normalizados ocupan aproximadamente 23 GB en el
SQLite de trabajo. Supabase Free entra en modo de solo lectura sobre 500 MB de
base de datos, por lo que no es viable usar PostgreSQL como almacén de cada
hecho XBRL.

## Arquitectura gratuita aplicada

```text
CMF XBRL
   ↓
ETL incremental local / worker
   ↓
SQLite completo (fuente de reconstrucción)
   ↓
public/data/cmf-financials.json (2,9 MB)
   ↓
Next.js Route Handler en Vercel

Supabase Free
  ├─ issuer: catálogo de 346 emisores
  ├─ quarter: 26 períodos
  └─ source_document: URL, hash y timestamp de 217 documentos cargados
```

`public/data/cmf-financials.json` se calcula directamente desde `cmf.db` y
contiene las series que consume la pantalla: ingresos, EBITDA, EBIT, utilidad,
caja y deuda. Si un concepto no existe en el XBRL del emisor, la serie queda
vacía; no se imputan ni inventan valores. Cada emisor conserva la URL, el hash
SHA-256 y el timestamp de sus documentos CMF.

La ruta `/api/issuer/{rut}/financials` usa este archivo cuando no existe
`CMF_API_URL`, así que el navegador nunca consulta la CMF. Supabase mantiene
la trazabilidad y el catálogo, no los hechos masivos.

## Operación

Después de cada ciclo incremental:

```bash
python -m etl.build_public_metrics \
  --db data/cmf/cmf.db \
  --output public/data/cmf-financials.json
npm run build
```

La migración `20260802000100_free_mode_compact_xbrl.sql` recrea `xbrl_fact`
vacía y sin los índices pesados. El SQLite local no se elimina y permite
reconstruir el read model o cambiar de proveedor posteriormente.

## Límites conocidos

Este modo optimiza costo y lectura de la aplicación. El archivo público es un
read model de métricas, no un repositorio navegable de los 22 millones de filas
raw. El SQLite completo queda como fuente de respaldo del ETL; para publicar
también cada hecho raw sin pagar base de datos se debe versionar en paquetes
binarios externos (por ejemplo, activos de GitHub Releases menores de 2 GiB por
archivo) y agregar un índice de paquetes al API.
