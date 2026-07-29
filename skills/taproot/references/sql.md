# SQL: schema, partitions, relations, templates

## Schema comes from the learning cache, never from DDL queries
For MySQL/TiDB/Postgres, always read the **service-keyed learning cache**. Do not issue raw introspection SQL.
- List tables: `taproot --json learn tables --service <svc>` (or `--datasource <name>`). Add `--match <substr>` to filter.
- One table's columns/indexes/partition: `taproot --json learn ensure-schema --service <svc> | jq '.tables[] | select(.table=="<t>")'`, or `taproot --json learn schema --datasource <name>`.
- Joins and observed query shapes: `taproot --json learn joins --service <svc>`, `learn shapes --datasource <name>`.
- Re-introspect after a migration: `taproot --json learn refresh-schema --service <svc>`. One refresh covers every env and namespace of that service, because the cache is keyed per `<service>|<table>`. Re-running per env is wasted work. `refresh-schema` pre-flights connectors and fails with `CONNECTIVITY: ...; nextCommand: taproot --json doctor --datasource <n> --connect` when VPN, telepresence, or teleport are down; bring those up before retrying.
- Force re-introspection in place: `taproot --json learn ensure-schema --datasource <name> --refresh`. Useful when a migration added columns the cache misses, or to check drift between envs.
- `learn ensure-schema`, `schema`, `tables`, `joins`, and `shapes` default to a **compact projection** (table, columns, primaryKey, indexes, partition). Pass `--detailed` only when you actually need columnStats, sightings, confidence, source, or lastSeenAt. Compact output is roughly 67% smaller, so prefer it.
- `taproot --json learn status` and `taproot --json learn replay --run-id <id>` inspect learning and run state.

Do **not** issue `SHOW CREATE TABLE`, `SHOW (FULL )?COLUMNS FROM`, `SHOW INDEX(ES)? FROM`, `DESCRIBE`, or `DESC`. TapRoot blocks these with `REDUNDANT_INTROSPECTION` once a service has schema cached. `--allow-schema-introspection` (or `TAPROOT_ALLOW_SCHEMA_INTROSPECTION=1`) overrides the gate, and only when the user explicitly needs raw DDL or you suspect drift the cache missed.

Avoid `information_schema.tables`/`columns`/`statistics` for basic discovery, since `learn tables` and `learn ensure-schema` answer the same question off-cache. Reserve `information_schema` for size, row counts, partition stats, and similar non-DDL needs.

Schema discovery is last-resort work. If the user named the table, or TapRoot already has the query shape, skip discovery entirely.

## Partitions and EXPLAIN
- `taproot query --datasource <name> --explain --query "<sql>"` wraps a query in `EXPLAIN` without executing it. Use it before heavy joins or partition-touching queries to confirm partition pruning (look for `partition:p_<name>`), index usage, and join order. `--explain` requires `--query`, so resolve a card, template, or intent to SQL first.
- Keep partition and indexed keys as **bare columns** in `WHERE` and `JOIN` predicates. Wrapping the column in a function (`TO_DAYS(ts)`, `DATE(ts)`, `CAST(ts AS ...)`) defeats pruning and index use, forcing `partition:all`, a full scan, even when the literal looks scoped. Filter with a raw-column range instead (`ts >= '2026-06-24 00:00:00' AND ts < '2026-06-25 00:00:00'`) and confirm with `--explain` that the plan names specific partitions. Connections run in UTC, so write those bounds as UTC instants.

## Cross-service relations
Services share entity keys (a `*_id` owned by one service, referenced by others). Do not rediscover those links per table per datasource. TapRoot tracks them as curated edges in KB `relations.json`.
- **Read at query time (free):** every SQL query auto-injects `meta.schemaContext.relations` for the touched tables, cross-service edges first. Follow these instead of guessing join keys. `--pluck meta.schemaContext.relations` returns just the edges.
- **View per service:** `taproot --json kb related --service <svc>` lists curated edges touching a service; add `--cross-service` for boundary-crossing ones only. Each row carries `from`/`to` as `service.table.column`, plus `relationship`, `cross`, and `notes`. `taproot --json kb relations list [--cross-service]` dumps the whole set.
- **Bulk import:** `taproot kb relations import --file <path.json>` merges a JSON array of `{id, from:{service,table,column}, to:{...}, relationship, notes}` edges into `relations.json`, deduped by `id`. The seed file lives in your KB directory, not this repo.
- **Discover candidates:** `taproot --json learn relations [--service <svc>]` derives candidate cross-service edges from already-learned schema by matching shared id-like columns and scoring them. It only proposes; nothing is written. `--min-confidence 0.7` focuses on strong candidates.
- **Confirm one:** re-run the same filter with `--promote` to write those edges into `relations.json` (marked `source: derived`). Treat promotion like a small KB edit and confirm the edge is real first.
- Intra-service joins stay with `learn joins`. `relations` is specifically the cross-service map.
- **Drift.** Curated relations are static and do not auto-update when a migration renames or drops a column. Three guards: (1) at query time the edge for the queried service is checked against live columns, and a missing near-side column injects with `stale: true` plus `staleReason`, so the intended link still shows but needs reverifying; (2) `taproot --json kb relations validate [--service <svc>] [--stale-only]` audits every endpoint against the learned cache, reporting each side `ok`, `missing_column`, `missing_table`, or `unknown_service` (a service not yet introspected is unverifiable, not stale); (3) `learn refresh-schema` runs that audit for the refreshed service and warns about stale edges. Fix a stale edge by editing `relations.json` or correcting the seed and re-importing. TapRoot never auto-deletes curated edges.

## Cards, templates, cache
- Cards first: `taproot --json card list --datasource <name>`, `card show <id>`, `card validate <path>`. Cards may carry soft requirements in `meta.queryMemory.warnings`; fix the SQL or card usage unless the warning is knowingly irrelevant.
- Templates: `template list`, `template validate --id <id>` to check parameter coverage, `template run --id <id> --param key=value` to render without executing, `template save --id <id> --intent "<intent>" --query "<sql>"` to create one.
- Saved selections: `cache lookup-target --env <env> --service <service> --intent "<intent>"` and `cache resolve-query --service <service> --intent "<intent>"` inspect what already exists. `cache save-target` and `cache save-query` only when the user explicitly wants to pin a reusable target or shape.

## Resolution and routing
- If the datasource is already known, use it directly. Do not start with `doctor` for routine reads.
- `taproot --json kb resolve-connection --service <service> --env <env>` or `taproot --json datasource resolve --env <env> --service <service>` only when resolution is actually needed. On a miss the error lists available envs for the service, or the known-service list; treat that as authoritative and do not re-probe with variants.
- `taproot --json kb list-services` when the service name is uncertain.
- `--env <env>` accepts shorthand like `qa-develop` even though the canonical pair is `--env qa --namespace develop`. The resolver retries with the split on a miss, so either form resolves. Do not nag about which one.
- `taproot kb tables --service <service> --list` gives a flat per-table listing. Add `--match <text>` to filter. Bare `kb tables --service <service>` returns a count-only summary, not names.
- Read `resolved` metadata in the result for source, engine, target, database, and access method.

## Session-backed execution
For datasources reached through `tsh`, cold `tsh proxy db` adds 3 to 10 seconds per call. Run `taproot --json daemon start` and open a session before issuing repeated queries, and treat daemon plus session as the preferred path there.
