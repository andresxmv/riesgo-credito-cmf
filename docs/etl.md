# ETL incremental CMF

## Job graph

1. `discover_issuers`: actualiza el catalogo de emisores y conserva bajas.
2. `discover_periods`: identifica nuevos trimestres y cierres.
3. `fetch_documents`: descarga solo documentos que no existen en el manifiesto.
4. `parse_xbrl`: normaliza hechos IFRS, contextos, unidades y dimensiones.
5. `parse_documents`: extrae analisis razonados, hechos esenciales y ratings.
6. `derive_financials`: calcula ratios y vistas TTM con reglas versionadas.
7. `derive_credit_model`: versiona score, confidence, outlook, trend y risk flags.
8. `publish_read_models`: actualiza las tablas de lectura y la cache.

## Implementacion actual

`etl/cmf_xbrl.py` implementa el primer job real:

- obtiene el catalogo oficial `consulta.php?Estado=VI&entidad=RVEMI&mercado=V`;
- construye la pagina historica por RUT, ano, trimestre y balance consolidado/individual;
- localiza el enlace oficial `Estados financieros (XBRL)`;
- descarga el ZIP, calcula SHA-256 y guarda el original;
- extrae la instancia `.xbrl`/`.xml`, ignorando taxonomias auxiliares;
- normaliza hechos, contextos, periodos, unidades y dimensiones a SQLite;
- salta documentos ya ingeridos cuando el manifiesto y el ZIP local existen.

La carga operativa solicitada cubre 2020-2026 en marzo, junio, septiembre y diciembre. La clave de idempotencia es `(issuer_rut, period, statement_type)`: un XBRL trimestral no se interpreta como una historia completa del emisor.

Ejemplo:

```bash
python -m etl.cmf_xbrl --rut 61704000 --year 2025 --month 3 --balance C --data-dir data/cmf
```

La verificacion contra la CMF genero 8.168 hechos para `61704000 / 202503 / C`. Una segunda ejecucion devolvio `skipped`. `data/cmf/` esta ignorado por Git porque contiene documentos fuente descargados.

## Publicacion a Supabase

El downloader escribe primero en SQLite para que cada ciclo sea reanudable. `etl/publish_postgres.py` copia el read model a PostgreSQL usando upserts y las mismas claves unicas:

```bash
python -m etl.publish_postgres --sqlite data/cmf/cmf.db
```

El comando usa `DATABASE_URL`, publica catalogo, quarter, documento, hash y hechos, y no elimina datos remotos.

## Catalogo

El snapshot local `app/issuer-catalog.ts` contiene 346 emisores vigentes. El ETL puede obtener el catalogo nuevamente con `--all` y debe publicar esa version en la tabla `issuer` durante el job productivo.

## Idempotencia y fallos

Cada documento usa `(issuer_rut, period, statement_type)` como clave unica y conserva `content_hash`, `source_url`, `local_path` y `retrieved_at`. Las solicitudes HTTP usan backoff exponencial con jitter. Los errores se registran por emisor y periodo para que el proceso pueda reanudarse.

## Modelo interno

El score 0-100 debe combinar CAPIC 2017, Altman Z, Ohlson O, cobertura de intereses, deuda neta/EBITDA, liquidez, rentabilidad, FCF, tendencias y volatilidades. Cada version debe guardar pesos, inputs, missingness y timestamp. La conversion AAA-CCC se aplica despues y se rotula siempre como estimada.
## Feller Rate

`etl/feller_rate.py` recorre el índice público de clasificaciones de Feller Rate Chile, descubre los perfiles de emisores y captura sus comunicados históricos. El proceso es incremental: los informes ya presentes en `data/feller/cache.json` se reutilizan y la salida estructurada queda en `data/feller/feller_rate.json`.

Se conservan campos técnicos, no el texto completo del informe: fecha, rating de solvencia, perspectiva, watch, instrumentos observados, escenarios, ejes de análisis y enlaces públicos al informe y PDF original. `build_public_metrics.py` cruza los perfiles por nombre normalizado con los emisores CMF y los incorpora al read model público.

Ejecutar:

```bash
python etl/feller_rate.py
python etl/build_public_metrics.py
```

El PDF recibe el trimestre como `quarter=YYYYMM`; selecciona el último trimestre CMF disponible no posterior al solicitado y el informe Feller publicado hasta ese corte.
