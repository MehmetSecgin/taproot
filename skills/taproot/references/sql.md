# SQL: schema, partitions, relations

## Schema: which command answers which question
If the user, the code, or the migration files already name the table and columns, run the real query. Otherwise look the name up first: do not guess columns from conventions (`<x>_id`, `name`, `sport`), since a guessed name is the most common cause of `UNKNOWN_COLUMN`.

| Question | Command (MySQL/TiDB) | Notes |
|---|---|---|
| Which tables exist? | `SHOW TABLES` | |
| What columns, indexes and partition key does `<t>` have? | `SHOW CREATE TABLE <t>` with `--pluck meta.schemaContext.tables.<t>` | Compact form from the cached catalog. |
| What are the column types, defaults, nullability? | `SHOW CREATE TABLE <t>` without `--pluck` | The catalog holds column names only. |
| Which table has a column like X? | `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name LIKE '%x%'` | |
| How big is a table? | `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('<t>')` | `table_rows` is an estimate. |
| Why does the schema look like this, or when did it change? | The service repo's migration files | The database shows the current state, not the history. |
| Is the cached catalog current? | `meta.schemaContext.catalog.fetchedAt` on any query | It refreshes after 24 h, or right after an `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` error. |

On `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` the error message ends with `Did you mean: <table>.<column>?` (also `error.details.didYouMean`), taken from the cached catalog. Use it, fix the query, and retry once. The same error also refetches the catalog in the background, so a column added by a recent migration shows up on the next query.

How the catalog works: the first query against a SQL datasource (mysql, teleport-mysql) starts a background read of `information_schema` columns, indexes and partitions, cached per datasource for 24 h (`TAPROOT_CATALOG_TTL_HOURS`). No query waits for it. Once it lands, every response carries `meta.schemaContext.tables[<table>]` for the referenced tables (`database`, `columns`, `primaryKey`, `indexes` with `unique` only when true and `type` only when not BTREE, `partition`) and `meta.schemaContext.catalog` (`{tables: N, fetchedAt}`). Until then, responses carry no schema context and the partition guard cannot check them.

## Partitions and EXPLAIN
- `taproot query --datasource <name> --explain --sql "<sql>"` wraps a query in `EXPLAIN` without executing it. Use it before heavy joins or partition-touching queries to confirm partition pruning (look for `partition:p_<name>`), index usage, and join order. `--explain` requires `--sql`.
- The partition guard reads the catalog: a query on a partitioned table without the partition column in `WHERE`/`JOIN` fails with `MISSING_PARTITION_PREDICATE`. Add the predicate; `--allow-partition-scan` needs explicit authorization.
- Range width is checked on every query against a RANGE/LIST partitioned table. `unbounded_range:<table>.<key>` means the key has a lower bound and no upper bound; `wide_range:<table>.<key>:actual=N:max=M` means the span exceeds `TAPROOT_MAX_RANGE_DAYS` (90 by default); `range_unverified` means the predicate used no date literal. These are warnings in `data.warnings`, not errors. Tighten the bound unless the wide scan is deliberate.
- Keep partition and indexed keys as **bare columns** in `WHERE` and `JOIN` predicates. Wrapping the column in a function (`TO_DAYS(ts)`, `DATE(ts)`, `CAST(ts AS ...)`) defeats pruning and index use, forcing `partition:all`, a full scan, even when the literal looks scoped. Filter with a raw-column range instead (`ts >= '2026-06-24 00:00:00' AND ts < '2026-06-25 00:00:00'`) and confirm with `--explain` that the plan names specific partitions. Connections run in UTC, so write those bounds as UTC instants.

## Cross-service relations
Services share entity keys (a `*_id` owned by one service, referenced by others). TapRoot holds them as curated edges in KB `relations.json`. They are not added to query output; read them on demand.
- **View:** `taproot kb relations list` lists every curated edge; add `--cross-service` for boundary-crossing ones only. Each row carries `from`/`to` as `service.table.column`, plus `relationship`, `cross`, and `notes`.
- **Bulk import:** `taproot kb relations import --file <path.json>` merges a JSON array of `{id, from:{service,table,column}, to:{...}, relationship, notes}` edges into `relations.json`, deduped by `id`. The seed file lives in your KB directory, not this repo.
- Curated relations are static. Fix a stale edge by editing `relations.json` or correcting the seed and re-importing.

## Resolution and routing
- If the datasource is already known, use it directly. Do not start with `doctor` for routine reads.
- `taproot kb resolve --service <service> --env <env>` (or `--datasource <name>`) or `taproot datasource resolve --env <env> --service <service>` only when resolution is actually needed. On a miss the error lists available envs for the service, or the known-service list; treat that as authoritative and do not re-probe with variants.
- `taproot kb list-services` when the service name is uncertain.
- `--env <env>` accepts shorthand like `qa-develop` even though the canonical pair is `--env qa --namespace develop`. The resolver retries with the split on a miss, so either form resolves. Do not nag about which one.
- `taproot kb tables --service <service> --list` gives a flat per-table listing. Add `--match <text>` to filter. Bare `kb tables --service <service>` returns a count-only summary, not names.
- Read `resolved` metadata in the result for source, engine, target, database, and access method.

## Daemon
For datasources reached through `tsh`, a cold `tsh proxy db` adds 3 to 10 seconds. The first query starts `taprootd`, which keeps the tunnel open, so later queries skip that cost.
