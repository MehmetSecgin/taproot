---
name: taproot
description: Use TapRoot for deterministic datasource queries (MySQL/TiDB, Postgres, Redis/Dragonfly, gRPC unary calls), doctor checks, KB resolution, explicit cache operations, and session-backed connector workflows. Trigger when users ask to run DB/cache/service queries through TapRoot, call gRPC endpoints, diagnose connector or auth issues, resolve env/service to a datasource, reuse learned query or target selections, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB, `redis-cli`, or `grpcurl` scripts.
---

# TapRoot

Use TapRoot as the canonical DB/operator path.

## Hard Rules
- **Schema first.** Before any exploratory table/column SQL, run `taproot --json learn ensure-schema --datasource <name>` or `--env <env> --service <service>`. It returns cached learning when present and runs one introspection pass when missing. Do not rediscover tables/columns with ad-hoc queries. Exception: if a prior query in this session already returned `[schemaContext: N tables cached]` for the same datasource and the referenced tables are in that cache, skip `ensure-schema`.
- **Read schemaContext.** Every `taproot query` response carries `meta.schemaContext` for referenced learned tables (full structure in `--json`, count footer in table render). Read it for partition keys and indexes before writing the next query against the same datasource. Do not re-run `SHOW CREATE` when `schemaContext` already has the table metadata.
- **All DDL inspection goes through the learning cache.** Use `taproot --json learn ensure-schema --service <svc>` (or `--datasource <name>`) to read columns, indexes, primary key, and partition. Never issue `SHOW CREATE TABLE`, `SHOW FULL COLUMNS FROM`, `DESCRIBE`, or `DESC` — TapRoot blocks these with `REDUNDANT_INTROSPECTION` once a service has refreshed schema cached. Never run `mysql -e`, `psql -c`, `tsh db exec`, or `tsh proxy db` directly either. The only path to raw DDL is `--allow-schema-introspection`, and only when the user explicitly asks for it.
- **No silent fallback.** If TapRoot returns `CONNECTIVITY`, `ACCESS_DENIED`, `AUTH_EXPIRED`, `MISCONFIGURED_DATASOURCE`, or any non-`ok` response, surface `error.code`, `error.message`, and `nextActionDetails` and stop. Do not bypass with direct `mysql` / `psql` / `tsh` commands. Direct fallback is only allowed when the user explicitly asks for it.
- **Daemon + session for repeated tsh access.** For datasources accessed via `tsh` (e.g. `tidb-orders-prod`), run `taproot --json daemon start` and open a session before issuing queries. Cold `tsh proxy db` adds 3–10 s per call; reuse a session.
- Prefer `--json` for command execution paths that will be parsed or relayed.
- Prefer `--datasource` when the datasource is already known; use `--env` + `--service` when resolution is part of the task.
- Prefer known-good existing TapRoot state over rediscovery. If datasource, service/env mapping, target, database, or query intent is already known from the user, KB, saved templates, cache, or prior TapRoot output, use it directly instead of rediscovering it.
- Prefer curated query cards, then `--intent` or `--template`, over raw SQL when the task matches an existing query shape. Raw SQL is the fallback, not the default.
- Keep queries read-only unless the user explicitly requests mutation and the datasource policy allows it.
- TapRoot query execution defaults to a 5000ms timeout. Only raise it with `--timeout-ms <ms>` when a slower query is intentional.
- Never inspect TapRoot cache, learning, or credential files directly. Use TapRoot commands only.
- Respect runtime config from `~/.taproot/config/deterministic-config.json`; environment safety and service alias behavior come from config, not hardcoded env names.
- Service names are normalized through `serviceAliases` in runtime config. Always use the canonical service name when known; aliases resolve transparently but should not be stored.
- **Redis classifies commands into three tiers (read / mutate / flush) and self-gates** because the shared SQL safety regex does not understand Redis verbs. `read` (GET/HGETALL/LRANGE/SCAN/INFO/...) runs by default. `mutate` (SET/DEL/EXPIRE/RENAME/HSET/LPUSH/SADD/ZADD/XADD/INCR/...) requires `--allow-mutate` AND `datasource.policy.allowMutate=true` (set via `taproot datasource add ... --allow-mutate`). `flush` (FLUSHDB/FLUSHALL/SWAPDB/MIGRATE) requires `--allow-flush` on top. Unknown commands are rejected. Never bypass with direct `redis-cli`.

## Redis / Dragonfly
- Treat `kind: redis` datasources as cache lookups, not SQL queries. There is no learned schema, no `learn ensure-schema`, no card promotion, and no partition checks — Redis bypasses the relational learning paths entirely.
- Pass the raw Redis command as `--query`, e.g. `--query "GET <key>"`, `--query "HGETALL <key>"`, `--query "SCAN 0 COUNT 50"`, `--query "INFO keyspace"`. Quote keys with spaces or special characters; the plugin tokenizes shell-style.
- Result shape: `data.columns = ["value"]`, one row per reply line. Multi-bulk replies (`HGETALL`, `LRANGE`, `SCAN`) produce multiple rows; alternate field/value lines for hashes. Access via `data.rows[i][0]` (positional, `data.rowsForm: "array"`).
- **Protobuf decoding.** Many services store serialized protobuf payloads in Redis/Dragonfly. Pass `--proto <Message> --proto-root <dir>` to decode them; the plugin runs `redis-cli --no-raw`, parses the quoted bytes, and decodes via `protobufjs`. `--proto-root` is loaded recursively — point it at the service's `.proto` source tree (e.g. `~/proto/<service>`). Decoded rows carry the message object as `value` (`order_id`, `status`, etc.). Non-binary replies (`SCAN` keys, `(nil)`, integers, `INFO` blocks) fall through as text via a printable-ASCII heuristic, so the same datasource can be used for both decoded GETs and plain SCANs.
- **Per-datasource proto defaults** via `resolverHints.protoRoot` and `resolverHints.protoMessage`. Set them with `taproot datasource add ... --hint protoRoot=<dir> --hint protoMessage=<Message>` so future queries don't need the flags. Point `protoRoot` at the owning service's `.proto` source tree. To find the right message name, grep the service for its Redis serializer config (e.g. `ProtobufRedisSerializer<...>`).
- Payloads without a configured `--proto` pass through as raw bytes — `redis-cli` is invoked in default mode. If a binary cell appears in the output, you probably want to add `--proto` rather than try to interpret bytes by eye.
- `taproot doctor --datasource <name>` runs `PING -> PONG` plus any wired connectors (typically `openvpn`).
- Discovery (`taproot discover kb|kubectl|teleport`) does **not** yet propose Redis datasources. Register them with `taproot datasource add --kind redis ...` or hand-edit the profile. Wire `--connector openvpn --openvpn-ref vpn:work` for cluster-DNS hosts on QA.
- No-auth Redis: leave the cred ref unset (TapRoot reads an empty cred map fine). For AUTH or ACL set `password` (and optionally `user`) via `taproot creds set --ref <ref>`.
- TLS: set `--ssl true` on the datasource profile to add `--tls` to the `redis-cli` invocation.
- **Writes / flushes.** Default policy on `datasource add` is read-only (`allowMutate=false`). To enable writes on a profile, re-run `taproot datasource add --name <same> ... --allow-mutate`; the same flag flips the policy. At query time the same write needs `--allow-mutate`. For `FLUSHDB/FLUSHALL/SWAPDB/MIGRATE` add `--allow-flush` as well. Default to read-only for unattended/agent workflows; only request mutate/flush when the user explicitly authorizes destructive Redis work and confirms the target env. Production Redis: do not enable mutate on the profile.

## gRPC
- Treat `kind: grpc` datasources as RPC endpoints, not databases. v1 supports **unary calls only** (server/client/bidi streaming deferred). Card promotion + persistent learning for unary calls deferred.
- Query syntax: `--query "<fully.qualified.package.Service/Method>"` mirroring `grpcurl`. The slash separates service from method; method casing must match the `.proto` rpc declaration.
- Request payload: pass full JSON with `--request-json '{...}'` (takes precedence) or build from `--param key=value` pairs (numeric strings → numbers, `true`/`false` → bool, everything else string). The shape must match the rpc's request message exactly. Use `taproot grpc describe` (below) instead of grepping `.proto` by hand.
- Response: single row, `value` = full decoded message object. Pluck nested fields with `--pluck data.rows.0.0.<field>` (e.g. `.regions`). int64 returned as strings (`longs: String`); oneofs carry a sibling key naming the active branch.
- **Proto introspection.** `taproot grpc describe --datasource <name>` lists every service + rpc and expands request/response messages (fields, types, repeated/optional/oneof, enums) from the datasource's `resolverHints.protoRoot`. Use it before composing `--request-json`. Flags: `--service <fq>` to scope, `--method <name>` to scope expansion further, `--max-depth <n>` to control transitive message expansion (default 4). `taproot grpc list` = compact services+methods table only, no message expansion. Both honor `--proto-root <dir>` if no datasource is registered yet.
- **schemaContext on grpc queries.** Every grpc query result carries `meta.schemaContext.services` (the called service) and `meta.schemaContext.messages` / `meta.schemaContext.enums` (request + response shapes, transitively expanded). Read those instead of re-running `grpc describe` after a successful call.
- `resolverHints.protoRoot` is required — point at a directory containing the service `.proto` and all its transitive imports. If your build emits a bundled proto tree (service proto plus imports), that directory is the easiest single-root path.
- `resolverHints.probeService` (optional) overrides which service `taproot doctor` exercises. Default: the first service in the loaded proto package. Doctor always opens a real grpc channel via `waitForReady` when a proto root is configured.
- Auth: bearer JWT via credential ref (`taproot creds set --ref <ref> --token '<jwt>'`) adds `authorization: Bearer <token>` metadata. Static headers via `--hint metadata.<key>=<value>` on `datasource add`. TLS: `--ssl true` on the profile. Plaintext h2c is the default (matches in-cluster Spring Boot grpc-server-starter).
- Example target: a service-mesh gRPC endpoint registered as `qa-catalog-grpc` (`catalog-grpc.develop:6565`, plaintext h2c, openvpn) with proto package `com.example.catalog.v1`. The pattern repeats for any service-mesh gRPC endpoint reachable via cluster DNS.
- No mutate/flush tier yet — gRPC plugin treats every method as `executeRead`. If you suspect a method writes, gate the datasource itself with `policy.allowMutate=false` (the default).
- Do not bypass with direct `grpcurl` — the plugin handles cluster DNS, openvpn preflight, deadlines, and decoding consistently with everything else in TapRoot.

## Output Mode
- Prefer `--json` for agent workflows. The JSON envelope has been compacted across all surfaces (rows as positional arrays, schema-context indexes stripped of defaults, query-memory deduped, empty arrays omitted). Token cost is now roughly equivalent to the box-drawing table form, with type fidelity and unambiguous parsing on top.
- `data.rows` is emitted as an array of arrays paired with `data.columns`. A `data.rowsForm: "array"` marker confirms the shape. Map values by column index, e.g. `data.rows[i][data.columns.indexOf("id")]`. Pass `--rows-object` only when a downstream consumer requires the legacy object form keyed by column name. This shape is identical whether the query is daemon-routed or runs in direct fallback mode.
- JSON-typed columns are returned as native values when the engine surfaces them as JSON; otherwise as strings. Datetime cells render ISO-8601 by default. Global `--datetime-format iso|js|epoch` (default `iso`). Pass `js` only when a downstream parser needs the legacy `Date.toString()` form; `epoch` for ms-since-epoch numerics.
- Schema info on the envelope: `meta.schemaContext.tables[<table>]` carries `columns`, `primaryKey`, `indexes` (defaults `unique:false` and `type:BTREE` are stripped), and `partition`. Read it before issuing follow-up queries. Empty `meta.queryMemory`, empty `warnings`, and empty `meta.schemaContext.tables` are omitted entirely.
- `meta.schemaContext.relations` is auto-injected when a query touches a table that has curated KB relations (cross-service edges first). Each edge is `{ from: "service.table.column", to: "service.table.column", relationship, crossService, notes }`. Read it to follow an entity across services WITHOUT re-introspecting — e.g. a query on a table whose `*_id` column is owned by another service surfaces that link so you can pivot directly. Curated edges live in KB `relations.json`; see the cross-service section below.
- Table render (no `--json`) emits `[schemaContext: N tables cached, M relations — pass --json for full detail]` as a footer for SQL kinds, or `[schemaContext: N services, M messages — pass --json for full detail]` for grpc kinds. Treat it as cache-state signal: if N covers the tables/services you need, do not call `learn ensure-schema` or `grpc describe` again this session.
- `>32 KB` results are persisted to a tool-results file with table formatting preserved; awk/sed on the file is brittle. For precise extraction switch to `--json | jq` instead.
- `--pluck <dot.path>` returns only the requested subtree of the JSON envelope. Cuts token cost dramatically when you only need a slice. Array indexing supported (`data.rows[0]`). Available on `query`, `learn ensure-schema`, `learn schema`, `learn tables`, `learn joins`, `learn shapes`, `learn relations`, `datasource list`, `datasource show`, `kb tables`, `kb list-services`, `kb related`, `doctor`, and `run show`. Pluck is in-process; avoid `--json ... | jq` for fields TapRoot can pluck directly.
- Pluck path shapes differ per command. Common targets:
  - `taproot query ... --pluck data.rows` (rows only), `--pluck data.columns`, `--pluck meta.schemaContext.tables.<t>.indexes`, `--pluck error.details.nextAction`.
  - `taproot learn ensure-schema ... --pluck tables` (NOT `meta.schemaContext.tables` — that nested shape exists only on `query` responses). Use `--pluck "tables[0]"` for first table or `--pluck "tables[0].indexes"` for its indexes.
  - `taproot learn tables ... --pluck rows`, `learn joins ... --pluck rows`.
  - `taproot datasource list --pluck "[0].name"` for first datasource name; `--pluck "length"` is not supported (jq still needed for aggregates).
- Full result is always persisted to `~/.taproot/runs/<runId>/summary.json`. If a later step needs a different slice from a prior run, fetch with `taproot --json run show --run-id <id> --pluck <path>` instead of re-running the query. Use `taproot --json run list --limit <n> [--datasource <name>]` to discover recent run IDs.
- `data.rows` defaults to a compact positional array form paired with `data.columns`; a `data.rowsForm: "array"` marker confirms the shape. Index by column name via `data.columns.indexOf("<col>")`. Opt out only when a downstream consumer requires object form (`--rows-object`).
- `taproot query` JSON envelopes expose the phase split at `meta.phases` (`resolveMs`, `connectMs`, `executeMs`, `totalMs`) and overall `meta.timings.durationMs` — identical for daemon-routed and direct queries. Use these to attribute slow queries to resolution vs connector preflight vs raw execution before adjusting timeouts. Verbose human mode (`--verbose`) prints the per-phase split inline with `query complete`.

## Porcelain vs Plumbing
- Every command has a stable plumbing form (`--json` envelope) and a porcelain form (human output). For agent workflows always use plumbing — porcelain layout is not version-stable.
- Stable envelope shape: `{ ok, data, meta, error }`. `meta.requestId` on daemon-routed commands; `meta.runId` and `meta.sessionId` when applicable.
- `--pluck <dot-path>` is the preferred token-efficient projection. Use it before piping to `jq`.
- Full matrix and stability rules: `references/porcelain-plumbing-contract.md`.

## Benchmarking
- Use `taproot --json bench --datasource <name> --query "<sql>" --iterations <n>` for quick single-scenario latency benchmarks. Reports p50/p95/avg per phase (resolve/connect/execute) and aggregate totals.
- Use `taproot --json bench --scenario <file>` for reproducible multi-scenario sweeps. Scenario file shape: `{ "iterations": <default>, "scenarios": [{ "name", "datasource"|"env"+"service", "query"|"template"|"intent", "iterations"? }, ...] }`.
- Bench routes through the daemon — start it first with `taproot --json daemon start`.
- Non-zero exit when any iteration fails; errors aggregated per error code in `data.scenarios[].errors`.

## Setup & Credentials
- Use `taproot --json init` at the start of a new machine or repo setup to create starter runtime state and get the current readiness summary.
- Use `taproot --json self-check --agent` for machine-readable readiness, and prefer targeted runs with `--datasource <name>` or `--env <env> --service <service>` when checking a real query path.
- Use `taproot --json init datasource --env <env> --service <service>` as the explicit KB-backed create/repair path for datasource profiles.
- Read `nextActionDetails` for remediation in `init --json`, `self-check --agent --json`, and `doctor --json`. Each entry has `command`, `priority`, `reasons`, `checks`, `codes`. The legacy `nextActions` string array is no longer emitted; iterate `nextActionDetails[].command` if you need a flat command list. `nextCommand` is still emitted as a hint to the highest-priority action.
- Use `taproot --json creds set --ref <ref> --user <u> --password <p>` to store credentials, or add connector-specific keys such as `--status-command`, `--connect-command`, `--disconnect-command`, and `--login-command`.
- Use `taproot creds list` to enumerate every saved credential ref (with source + key set, secrets redacted). Run before guessing a ref name or registering a duplicate.
- Use `taproot --json creds show --ref <ref>` to verify a credential ref. Sensitive values are redacted.
- Use `taproot --json creds unset --ref <ref>` only when the user explicitly wants to remove a saved credential ref.
- Use `taproot --json creds migrate-to-fallback` to move every keychain-stored credential into the encrypted fallback file, then delete the keychain copy. Stops macOS keychain ACL prompts on rebuilt binaries. Set `TAPROOT_NO_KEYCHAIN=1` after migration to keep new creds out of keychain too.
- When registering a new datasource, prefer `taproot --json datasource add --probe ...`. `--probe` runs a connect probe against the host/port/credential combo and rolls back the saved profile on failure (`PROBE_FAILED: profile rolled back. <reason>`). Probe-on-save catches host/port/cred typos at registration time instead of on first query.
- Use `taproot --json connector setup --datasource <name> --connector <name> --ref <ref>` to wire a connector to a datasource.
- Use `taproot --json connector status --datasource <name>` to check connector health.
- Add `--connector <name>` to filter connector checks to a single connector.
- Add `--all` or `--verbose-detail` when the user needs the full connector check table or expanded details.

## Workflow
1. Resolve the target path.
- If the datasource is already known, use it directly. Do not start with `doctor` for routine reads.
- Use `taproot --json kb resolve-connection --service <service> --env <env>` or `taproot --json datasource resolve --env <env> --service <service>` only when env/service resolution is actually needed. On miss, the error includes available envs for the service (or the known-service list) — treat that hint as authoritative, do not re-probe with variants.
- Use `taproot --json kb list-services` when the service name is uncertain.
- `--env <env>` accepts shorthand like `qa-develop` even though the canonical pair is `--env qa --namespace develop`. The resolver retries with the split on miss. When the user types either form, the same datasource resolves; do not nag about which form.
- Use `taproot kb tables --service <service> --list` for a flat per-table listing (one row per table). Add `--match <text>` to filter table names by substring. The bare `taproot kb tables --service <service>` returns a count-only summary, not the table names.
- If a targeted path may not be ready, run `taproot --json self-check --agent --datasource <name>` or `taproot --json self-check --agent --env <env> --service <service>` before deeper diagnosis.
- Do not re-run discovery or resolution steps just to reconfirm information already provided by the user or already present in TapRoot state.

2. Preflight connectors and auth.
- Run `taproot --json doctor --datasource <name> --connect` only when connector or auth state is the task, or when the previous query attempt failed for connectivity/auth reasons.
- If readiness or doctor returns failures, stop and surface `checks` + `nextActionDetails`. `ok`-status checks omit the `detail` field; only `warn`/`fail` checks carry it.
- If TapRoot is blocked by routing, proxy, or learning gaps, stop and report the issue instead of using direct shell DB tools.

3. Execute the query path.
- Query selection order:
  - First: `taproot --json query --datasource <name> --card <id> --param key=value`
  - Second: `taproot --json query --datasource <name> --intent "<intent>" --param key=value`
  - Third: `taproot --json query --datasource <name> --template <id> --param key=value`
  - Fourth: `taproot --json query --datasource <name> --query "<sql>"`
- Use `taproot --json cache resolve-query --service <service> --intent "<intent>"` when you suspect an intent/query mapping already exists and need to inspect it before writing SQL.
- Use `taproot --json card list --datasource <name>` and `taproot --json card show <id>` to inspect curated, repo-reviewable query cards before inventing SQL.
- When env/service is the entrypoint, use `taproot --json query --env <env> --service <service> ...`.
- Use `--timeout-ms <ms>` only when the user explicitly needs more than the default 5000ms budget.
- Add `--allow-discovery` only as a last resort when deterministic routing is missing and the user has explicitly authorized discovery.
- Use `taproot query --datasource <name> --explain --query "<sql>"` to wrap a query in `EXPLAIN` without executing it. Use before heavy joins or partition-touching queries to confirm partition pruning (look for `partition:p_<name>` in the plan), index usage, and join order. `--explain` requires `--query` (raw SQL); resolve `--card`/`--template`/`--intent` first if you started there.
- Read `resolved` metadata in the result to understand source, engine, target, database, and access method.
- For MySQL/TiDB schema discovery, always read from the **service-keyed learning cache**. Do not issue raw introspection SQL:
  - List tables: `taproot --json learn tables --service <svc>` (or `--datasource <name>`). Add `--match <substr>` to filter.
  - Inspect one table's columns/indexes/partition: `taproot --json learn ensure-schema --service <svc> | jq '.tables[] | select(.table=="<t>")'` or `taproot --json learn schema --datasource <name>`.
  - Inspect joins / observed query shapes: `taproot --json learn joins --service <svc>` / `learn shapes --datasource <name>`.
  - `learn ensure-schema`/`schema`/`tables`/`joins` default to a **compact projection** (table, columns, primaryKey, indexes, partition). Pass `--detailed` only when you actually need columnStats, sightings, confidence, source, or lastSeenAt. Compact output is ~67% smaller — prefer it.
  - Re-introspect after a migration: `taproot --json learn refresh-schema --service <svc>` (or `--datasource <name>`). One refresh covers all envs/namespaces of that service because the cache is service-keyed. `refresh-schema` pre-flights the datasource's connectors and fails with `CONNECTIVITY: ...; nextCommand: taproot --json doctor --datasource <n> --connect` if VPN / telepresence / teleport are down; bring those up before retrying.
  - Force re-introspection without leaving `ensure-schema`: `taproot --json learn ensure-schema --datasource <name> --refresh`. Useful when a recent migration added columns the cache still misses, or to verify drift between envs.
- Do **not** issue `SHOW CREATE TABLE`, `SHOW (FULL )?COLUMNS FROM`, `SHOW INDEX(ES)? FROM`, `DESCRIBE`, or `DESC` as a query. TapRoot blocks these with `REDUNDANT_INTROSPECTION` when the service schema is already cached. The cache already has columns, indexes, primary key, and partition metadata — read it.
- `--allow-schema-introspection` (or env `TAPROOT_ALLOW_SCHEMA_INTROSPECTION=1`) overrides the gate. Only use when the user explicitly needs raw DDL output or you suspect schema drift the cache hasn't caught.
- Avoid `information_schema.tables`/`columns`/`statistics` for basic discovery — `learn tables`/`learn ensure-schema` answer the same question off-cache. Reserve `information_schema` for size, row-count, partition-stats, and similar non-DDL needs.
- Schema discovery is last-resort work. If the user already named the table or TapRoot already has the query shape, skip discovery entirely.

### Cross-service relations
Services often share entity keys (a `*_id` owned by one service, referenced by others). Don't rediscover those links per table per datasource — TapRoot tracks them as curated edges in KB `relations.json`.
- **Read at query time (free):** every SQL query auto-injects `meta.schemaContext.relations` for the touched tables, cross-service edges first. Follow these instead of guessing join keys. `--pluck meta.schemaContext.relations` to get just the edges.
- **View per service:** `taproot --json kb related --service <svc>` lists curated edges touching a service; add `--cross-service` for only the boundary-crossing ones. Each row carries `from`/`to` as `service.table.column`, `relationship`, `cross`, and `notes`. `taproot --json kb relations list [--cross-service]` dumps the whole curated set.
- **Bulk import a map:** `taproot kb relations import --file <path.json>` merges a JSON array of `{id, from:{service,table,column}, to:{...}, relationship, notes}` edges into `relations.json` (dedup by `id`). Use when seeding from a team DB map (the seed file lives in your KB directory, not this repo).
- **Discover new ones:** `taproot --json learn relations [--service <svc>]` derives *candidate* cross-service edges from the schema you've already learned (matches shared id-like columns; scores them). It only proposes — nothing is written. Pass `--min-confidence 0.7` to focus on strong candidates.
- **Confirm a candidate:** re-run the same `learn relations` filter with `--promote` to write the listed edges into `relations.json` (marked `source: derived`). Curated/confirmed edges then auto-inject on future queries and show in `kb related`. Treat promotion like a small KB edit — confirm the edge is real before promoting.
- Intra-service joins (same service both sides) are still covered by `learn joins`; `relations` is specifically the cross-service map.
- **Drift / staleness.** Curated relations are static and do NOT auto-update when a migration renames/drops a column. Guards: (1) at query time the edge for the queried service is checked against live columns — a missing near-side column injects with `stale: true` + `staleReason` (the edge still shows, so you know the intended link, but reverify before using). (2) `taproot --json kb relations validate [--service <svc>] [--stale-only]` audits every endpoint against the learned cache → each side reported `ok` / `missing_column` / `missing_table` / `unknown_service` (service not yet introspected = unverifiable, not stale). (3) `learn refresh-schema` auto-runs this audit for the refreshed service and warns about stale edges. Fix a stale edge by editing `relations.json` (or correcting the seed and re-importing) — TapRoot never auto-deletes curated edges.

4. Template management.
- Use `taproot --json card list`, `card show <id>`, and `card validate <path>` for curated query-card inspection. Cards may carry soft requirements in `meta.queryMemory.warnings`; fix the SQL/card usage unless the warning is knowingly irrelevant.
- Use `taproot --json template list` to see available templates.
- Use `taproot --json template validate --id <id>` to check parameter coverage before relying on a template.
- Use `taproot --json template run --id <id> --param key=value` to render a template without executing it.
- Use `taproot --json template save --id <id> --intent "<intent>" --query "<sql>"` to create a reusable template.

5. Reuse and inspection.
- Use `taproot --json cache lookup-target --env <env> --service <service> --intent "<intent>"` to inspect saved target selections.
- Use `taproot --json cache resolve-query --service <service> --intent "<intent>"` to inspect saved query templates.
- Use `taproot --json cache save-target ...` or `taproot --json cache save-query ...` only when the user explicitly wants to pin a reusable target or query shape.
- Use `taproot --json learn status` or `taproot --json learn replay --run-id <id>` for learning/run inspection.
- Schema cache is **service-keyed**: one entry per `<service>|<table>` shared across env/namespace/datasource. Refresh once with `learn refresh-schema --service <svc>` (or `--datasource <name>`) and all four envs (qa-develop, qa-test, stg, prod) reuse the same cache.
- `learn ensure-schema`/`learn schema`/`learn tables`/`learn joins`/`learn shapes` default to a **compact projection** (columns, primaryKey, indexes, partition). Pass `--detailed` only when you need columnStats, sightings, confidence, source, or lastSeenAt. Compact output is ~67% smaller — prefer it.

6. Prefer session-backed execution for repeated Teleport-style access.
- Use `taproot --json daemon start` and `taproot --json session open ...` when repeated queries are expected and the datasource uses session-backed access.
- Treat daemon/session mode as the preferred efficiency path for repeated Teleport DB queries.

## Operations
- Use `taproot --json init` for first-run bootstrap and a top-level readiness summary.
- Use `taproot --json self-check` to validate the runtime environment before debugging higher-level failures.
- Use `taproot --json self-check --agent --datasource <name>` or `--env <env> --service <service>` when you need a machine-readable answer about whether a specific query path is ready.
- Read `nextActionDetails` first from `init --json` and `self-check --agent --json`; `nextCommand` should match the highest-priority action.
- Use `taproot --json sanitize check-repo` before committing or sharing the repo to scan tracked files for leaked secrets.
- Use `taproot completion zsh` or `taproot completion bash` / `fish` to inspect or install shell completion output.

## Error Handling

Each code below has one allowed recovery action. Do not loop. Return error + `nextActionDetails` to the user if the single recovery does not resolve it.

- `CONNECTIVITY` / connector failures: rerun `doctor --datasource <n> --connect` ONCE. If still failing, return `checks` + `nextActionDetails` and stop.
- `REDUNDANT_INTROSPECTION`: service schema is already cached. Do NOT retry with `SHOW CREATE`/`DESCRIBE`/`SHOW COLUMNS`. Read the cache via the `nextCommand` in `error.details` (`taproot --json learn ensure-schema --service <svc>`). Pass `--allow-schema-introspection` only when the user explicitly authorized re-introspection.
- `ACCESS_DENIED` / `AUTH_EXPIRED`: fail fast. Tell the user to run `tsh login` or `taproot creds set` themselves. Never spawn an interactive `tsh login` from inside the agent.
- `BAD_INPUT`: invalid CLI arguments or missing required params. Re-read the command signature; do not retry blindly.
- `MISSING_PARTITION_PREDICATE`: table is RANGE/LIST-partitioned. Add the partition column(s) to WHERE or JOIN predicates and retry through TapRoot. Do not bypass with direct `tsh db exec`; `--allow-partition-scan` requires explicit user authorization.
- `UNKNOWN_TARGET`: datasource or target not found. Verify the datasource name first, then rerun resolution.
- `OVERLOADED`: daemon query queue is full. Wait and retry once, or use direct CLI mode with `TAPROOT_FORCE_DIRECT=1`.
- `SESSION_BUSY`: per-session concurrent-lease cap exceeded. Wait for in-flight queries to finish or open a new session.
- `DETERMINISTIC_REQUIRED`: require a deterministic path from datasource profile or KB, or a config/CLI setting that explicitly enables discovery for that environment.
- `DISCOVERY_UNAVAILABLE`: populate deterministic routing through datasource profiles, KB, or prior TapRoot learning before retrying.
- `MISCONFIGURED_DATASOURCE`: repair with `taproot --json init datasource --env <env> --service <service>` before query execution.

## Troubleshooting

Map symptoms to TapRoot commands. Do not bypass.

- **Hangs ~10 s, then `CONNECTIVITY: teleport proxy path unavailable`** — `tsh proxy db` is exiting before TCP-ready (expired cert, bad db user, missing target). Run `taproot --json doctor --datasource <n> --connect --verbose-detail`. Verify `tsh status` outside TapRoot only to diagnose; do not switch to direct `tsh db exec` for the actual query.
- **`REDUNDANT_INTROSPECTION` error on `SHOW CREATE TABLE` / `DESCRIBE` / `SHOW COLUMNS`** — service schema is already cached. Read it with `taproot --json learn ensure-schema --service <svc>` (or `learn schema --datasource <name>`). The cache holds columns, indexes, primary key, and partition. The error's `details.nextCommand` points at the exact read. Pass `--allow-schema-introspection` only when the user explicitly asks for raw DDL output or when you suspect drift the cache missed.
- **Same service across env/namespace** — schema cache is service-keyed. One `learn refresh-schema --service <svc>` covers qa-develop, qa-test, stg, prod for that service. Re-running per-env is wasted work.
- **`taproot doctor` slow (>15 s)** — likely OpenVPN connect (up to 20 s) or cold `tsh proxy db`. Drop `--connect` if you only need status. Confirm the daemon is started so subsequent queries reuse the session.
- **Query timeout fires immediately** — connector preflight ran before the query timeout was applied. Pass `--timeout-ms` large enough to cover preflight + query.
- **First query against a prod tsh datasource is always slow** — start the daemon and open a session, then run queries. Cold-spawn `tsh proxy db` is the cost.

## First Successful Query — Prod TSH Smoke Test

Verify TapRoot is healthy against a known prod datasource (cache read only — no SHOW CREATE, no DDL on the wire):

```bash
taproot --json daemon start
taproot --json learn ensure-schema --env prod --service order-processor
taproot --json learn ensure-schema --env prod --service order-processor | jq '.tables[] | select(.table=="order_items")'
```

## First Successful Query (Happy Path)
```bash
taproot --json init
taproot --json init datasource --env qa --service orders
taproot --json creds set --ref qa:orders --user reader --password <password>
taproot --json doctor --datasource qa-orders --connect
taproot --json query --datasource qa-orders --query "SELECT 1 AS ok"
# data.rows is positional: data.rows[i][data.columns.indexOf("ok")] === 1
```

## References
- For command patterns and decision points, read `references/workflows.md`.
- For the full porcelain vs plumbing matrix and stability rules, read `references/porcelain-plumbing-contract.md` (project repo).
- For the frozen JSON envelope shape, read `references/json-envelope-contract.md` (project repo).
