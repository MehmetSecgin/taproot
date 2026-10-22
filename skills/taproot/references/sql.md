# SQL: schema, partitions, relations

## Schema arrives with the query
The first query against a SQL datasource (mysql, postgres, teleport-mysql) reads `information_schema` columns once, plus indexes and partitions on MySQL/TiDB, and caches the **whole table catalog** per datasource for 24 h (`TAPROOT_CATALOG_TTL_HOURS`). A stale catalog is refreshed in the background. You do not run a schema step first. Every response carries:
- `meta.schemaContext.tables[<table>]` for the tables the query referenced: `database`, `columns`, `primaryKey`, `indexes` (`unique` only when true, `type` only when not BTREE), `partition`.
- `meta.schemaContext.catalog` as `{tables: N, fetchedAt}`, the proof that all N tables of that datasource are cached.

To see one table's columns, indexes, and partition key, pluck the context from a DDL read, which the partition guard never blocks: `taproot query --datasource <name> --sql "SHOW CREATE TABLE <t>" --pluck meta.schemaContext.tables.<t>`.
- List tables: `SHOW TABLES` (or `SHOW TABLES FROM <database>`).
- Full DDL: `SHOW CREATE TABLE <t>` runs like any read when the catalog fields are not enough.
- After a migration adds or changes columns: `taproot cache clear` drops every cached catalog, and the next query re-reads it. `taproot cache show` lists cached catalogs (`datasource`, `fetchedAt`, `tables`).
- Reserve `information_schema` queries for size, row counts, partition stats, and similar needs the catalog does not hold.

If the user named the table, skip discovery and run the real query.

## Partitions and EXPLAIN
- `taproot query --datasource <name> --explain --sql "<sql>"` wraps a query in `EXPLAIN` without executing it. Use it before heavy joins or partition-touching queries to confirm partition pruning (look for `partition:p_<name>`), index usage, and join order. `--explain` requires `--sql`.
- The partition guard reads the catalog: a query on a partitioned table without the partition column in `WHERE`/`JOIN` fails with `MISSING_PARTITION_PREDICATE`. Add the predicate; `--allow-partition-scan` needs explicit authorization.
- Range width is checked on every query against a RANGE/LIST partitioned table. `unbounded_range:<table>.<key>` means the key has a lower bound and no upper bound; `wide_range:<table>.<key>:actual=N:max=M` means the span exceeds `TAPROOT_MAX_RANGE_DAYS` (90 by default); `range_unverified` means the predicate used no date literal. These are warnings in `data.warnings`, not errors. Tighten the bound unless the wide scan is deliberate.
- Keep partition and indexed keys as **bare columns** in `WHERE` and `JOIN` predicates. Wrapping the column in a function (`TO_DAYS(ts)`, `DATE(ts)`, `CAST(ts AS ...)`) defeats pruning and index use, forcing `partition:all`, a full scan, even when the literal looks scoped. Filter with a raw-column range instead (`ts >= '2026-06-24 00:00:00' AND ts < '2026-06-25 00:00:00'`) and confirm with `--explain` that the plan names specific partitions. Connections run in UTC, so write those bounds as UTC instants.

## Cross-service relations
Services share entity keys (a `*_id` owned by one service, referenced by others). TapRoot holds them as curated edges in KB `relations.json`. They are not added to query output; read them on demand.
- **View per service:** `taproot kb related --service <svc>` lists curated edges touching a service; add `--cross-service` for boundary-crossing ones only. Each row carries `from`/`to` as `service.table.column`, plus `relationship`, `cross`, and `notes`. `taproot kb relations list [--cross-service]` dumps the whole set.
- **Bulk import:** `taproot kb relations import --file <path.json>` merges a JSON array of `{id, from:{service,table,column}, to:{...}, relationship, notes}` edges into `relations.json`, deduped by `id`. The seed file lives in your KB directory, not this repo.
- Curated relations are static. Fix a stale edge by editing `relations.json` or correcting the seed and re-importing.

## Resolution and routing
- If the datasource is already known, use it directly. Do not start with `doctor` for routine reads.
- `taproot kb resolve --service <service> --env <env>` (or `--datasource <name>`) or `taproot datasource resolve --env <env> --service <service>` only when resolution is actually needed. On a miss the error lists available envs for the service, or the known-service list; treat that as authoritative and do not re-probe with variants.
- `taproot kb list-services` when the service name is uncertain.
- `--env <env>` accepts shorthand like `qa-develop` even though the canonical pair is `--env qa --namespace develop`. The resolver retries with the split on a miss, so either form resolves. Do not nag about which one.
- `taproot kb tables --service <service> --list` gives a flat per-table listing. Add `--match <text>` to filter. Bare `kb tables --service <service>` returns a count-only summary, not names.
- Read `resolved` metadata in the result for source, engine, target, database, and access method.

## Session-backed execution
For datasources reached through `tsh`, cold `tsh proxy db` adds 3 to 10 seconds per call. Run `taproot daemon start` and open a session before issuing repeated queries, and treat daemon plus session as the preferred path there.
