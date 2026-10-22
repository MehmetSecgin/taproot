---
name: taproot
description: Use TapRoot for deterministic datasource queries (MySQL/TiDB, Redis/Dragonfly, gRPC unary and streaming calls), doctor checks, KB resolution, and connector-backed access through Teleport or kubectl port-forwards. Trigger when users ask to run DB/cache/service queries through TapRoot, call gRPC endpoints, diagnose connector or auth issues, resolve env/service to a datasource, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB, `redis-cli`, or `grpcurl` scripts.
---

# TapRoot

TapRoot is the canonical path for DB, cache, and RPC access. Read the reference file for the kind you are working with; this page holds only the rules that apply everywhere.

## Read next
| Task | File |
| --- | --- |
| New machine, init, credentials, connectors, first call | `references/setup.md` |
| gRPC endpoints (offline introspection, unary and streaming calls) | `references/grpc.md` |
| Redis / Dragonfly (command tiers, protobuf payloads) | `references/redis.md` |
| SQL schema catalog, partitions, relations | `references/sql.md` |
| JSON envelope, `--pluck`, rows shape | `references/output.md` |
| Symptom-to-command map | `references/troubleshooting.md` |
| Command patterns and decision points | `references/workflows.md` |

## Hard Rules
- **Never guess column or table names.** If the user, the code, or the migration files do not name them, look them up with the question-to-command table in `references/sql.md` (`SHOW TABLES`, `SHOW CREATE TABLE <t> --pluck meta.schemaContext.tables.<t>`, `information_schema.columns ... LIKE`). There is no separate schema step: the catalog caches itself in the background on the first query. A response without `meta.schemaContext.catalog` means it is not cached yet, so the partition guard did not check that query: keep the partition column in `WHERE` yourself.
- **Never probe with `SELECT 1`.** Run the real query. A dead connector returns `CONNECTIVITY`; a pre-flight ping only costs a round trip and tells you nothing the first query would not.
- **Never run `mysql -e`, `psql -c`, `tsh db exec`, `tsh proxy db`, `redis-cli`, or `grpcurl` directly.** Every query goes through `taproot query`.
- **Never retry identical failing SQL.** Change the cause first.
- **No silent fallback.** On `CONNECTIVITY`, `ACCESS_DENIED`, `AUTH_EXPIRED`, `MISCONFIGURED_DATASOURCE`, or any non-`ok` response, surface `error.code` and `error.message`, then stop. Direct shell fallback needs an explicit user request.
- **Read-only by default.** Keep queries read-only unless the user explicitly asks for mutation and the datasource policy allows it. Redis mutate and flush tiers are gated separately (see `references/redis.md`).
- **Never hand-write engine JSON-path SQL** (`JSON_EXTRACT`, `->`, `->>`, `JSON_VALUE`). Select the raw column and use `--json-extract <column>:<dotpath>`, or parse offline.
- **Keep partition and indexed keys as bare columns** in `WHERE` and `JOIN`. Wrapping them in `TO_DAYS()`, `DATE()`, or `CAST()` forces `partition:all`, a full scan.
- **Prefer existing state over rediscovery.** If the datasource, env/service mapping, target, database, or query intent is already known from the user, KB, or prior output, use it. Do not re-resolve to reconfirm. To reuse an earlier result, keep the output you already have; do not re-run the query.
- Never read TapRoot cache or credential files directly. Use TapRoot commands.
- Environment safety and service aliases come from `~/.taproot/config/deterministic-config.json`, not hardcoded env names. Use the canonical service name when known; aliases resolve transparently but should not be stored.

## Everywhere invariants
- Envelope: `{ ok, data, meta, error }`.
- `data.rows` is positional, paired with `data.columns` and marked `data.rowsForm: "array"`. Index via `data.columns.indexOf("<col>")`. `--rows-object` only for a consumer that needs the legacy form.
- Every command prints exactly one line of compact JSON on stdout, errors and `--help` included. stderr stays empty unless `--verbose`.
- `--pluck <dot.path>` projects a subtree in-process on any command; prefer it over piping to jq. For rows, `--pluck data.rows`. On failure it prints the full error envelope instead and exits non-zero, so always gate on exit code.
- The query text goes in `--sql "<native>"` or its synonym `--query "<native>"` (pass one, not both), never as a positional argument. `--query` reads better for a Redis command or a gRPC `Service/Method`. Example: `taproot query --datasource <name> --sql "<sql>"`
- Every query response carries `meta.schemaContext` for referenced tables (SQL) or the called service and messages (gRPC). Read it instead of re-introspecting.
- The table catalog is cached per datasource for 24 h (`TAPROOT_CATALOG_TTL_HOURS`) and refreshed in the background when stale. An `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` error refetches it, so a recent migration shows up on the next query.
- Wide scans warn rather than block: `unbounded_range`, `wide_range:<table>.<key>:actual=N:max=M`, and `range_unverified` land in `data.warnings`. Tighten the range unless the wide scan is intended.
- Queries default to a 15000 ms timeout, counted from when the connectors are ready. Raise with `--timeout <ms>` only when a slower query is intentional.
- Connections run in UTC, so timestamp literals are UTC and match rendered values. Override with `--tz` rather than shifting literals by hand.
- Prefer `--datasource` when the datasource is known, `--env` + `--service` when resolution is part of the task. To find a name, `taproot datasource list <pattern>` keeps names containing the pattern and shows each one's `host`, `target` and `database`.
- The first query starts `taprootd`, which keeps Teleport tunnels and connection pools open, so only the first query pays the 3 to 10 s of a cold `tsh proxy db`.

## Error codes
One recovery action each. Do not loop. If it does not resolve, return the error and stop.

- `CONNECTIVITY`: rerun `doctor --datasource <n> --connect` **once**, then stop. `getaddrinfo ENOTFOUND` on an in-cluster hostname means the cluster network (VPN, telepresence, port-forward) is down.
- `UNKNOWN_COLUMN` / `UNKNOWN_TABLE`: the message ends with `Did you mean: ...?` (`error.details.didYouMean`) from the cached catalog. Fix the name and retry once; without a suggestion, look it up with `SHOW CREATE TABLE` or `SHOW TABLES`.
- `KB_MISSING`: the KB directory named in the message does not exist or lists no services. Ask the user for the KB path and run `taproot init --kb-dir <dir>`, or use `datasource add`.
- `UNKNOWN_DATASOURCE`: no profile has that name. Use a name from the `Did you mean` list, or pass `--env` + `--service`.
- `SQL_SYNTAX`: fix the SQL. Never resend it unchanged.
- `ACCESS_DENIED` / `AUTH_EXPIRED`: fail fast. Tell the user to run `tsh login` or `taproot creds set` themselves. Never spawn an interactive `tsh login`.
- `BAD_INPUT`: invalid arguments or missing params. Re-read the command signature; do not retry blindly.
- `MISSING_PARTITION_PREDICATE`: add the partition column(s) to `WHERE`/`JOIN` and retry. `--allow-partition-scan` needs explicit authorization.
- `UNKNOWN_TARGET`: verify the datasource name, then rerun resolution.
- `MISCONFIGURED_DATASOURCE`: repair with `taproot init datasource --env <env> --service <service>`.
- `DETERMINISTIC_REQUIRED` / `DISCOVERY_UNAVAILABLE`: populate deterministic routing via datasource profiles or the KB. `--allow-discovery` is a last resort and needs explicit authorization.
- `OVERLOADED`: daemon queue full. Wait and retry once, or set `TAPROOT_FORCE_DIRECT=1`.

## Readiness in one line
`taproot init` prints `data.readiness` plus `data.checks` for the whole install. `warn` means not configured yet, not broken. Bare `taproot doctor` is not a health check: it needs `--datasource` or `--env`+`--service`. A failing check's `code` and `detail` name the cause. Details in `references/setup.md`.
