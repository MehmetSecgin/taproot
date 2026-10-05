---
name: taproot
description: Use TapRoot for deterministic datasource queries (MySQL/TiDB, Postgres, Redis/Dragonfly, gRPC unary and streaming calls), doctor checks, KB resolution, explicit cache operations, and session-backed connector workflows. Trigger when users ask to run DB/cache/service queries through TapRoot, call gRPC endpoints, diagnose connector or auth issues, resolve env/service to a datasource, reuse learned query or target selections, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB, `redis-cli`, or `grpcurl` scripts.
---

# TapRoot

TapRoot is the canonical path for DB, cache, and RPC access. Read the reference file for the kind you are working with; this page holds only the rules that apply everywhere.

## Read next
| Task | File |
| --- | --- |
| New machine, init, credentials, connectors, first call | `references/setup.md` |
| gRPC endpoints (offline introspection, unary and streaming calls) | `references/grpc.md` |
| Redis / Dragonfly (command tiers, protobuf payloads) | `references/redis.md` |
| SQL schema cache, partitions, relations | `references/sql.md` |
| JSON envelope, `--pluck`, rows shape, benchmarking | `references/output.md` |
| Symptom-to-command map | `references/troubleshooting.md` |
| Command patterns and decision points | `references/workflows.md` |

## Hard Rules
- **Schema arrives on its own. Never run a separate schema step.** The first query against a datasource caches its whole table catalog, and every response carries `meta.schemaContext` for the referenced tables plus `meta.schemaContext.catalog` (`{tables, fetchedAt}`) proving the full catalog is cached. Read that instead of introspecting. `learn ensure-schema` and `learn tables` stay available for inspecting the cache directly, but a query never needs them first.
- **Never probe with `SELECT 1`.** Run the real query. A dead connector returns `CONNECTIVITY` with `nextActionDetails`; a pre-flight ping only costs a round trip and tells you nothing the first query would not.
- **All DDL inspection goes through the learning cache.** Never issue `SHOW CREATE TABLE`, `SHOW FULL COLUMNS FROM`, `SHOW INDEX FROM`, `DESCRIBE`, or `DESC`; TapRoot blocks them with `REDUNDANT_INTROSPECTION`. Never run `mysql -e`, `psql -c`, `tsh db exec`, `tsh proxy db`, `redis-cli`, or `grpcurl` directly. The only path to raw DDL is `--allow-schema-introspection`, and only when the user explicitly asks.
- **No silent fallback.** On `CONNECTIVITY`, `ACCESS_DENIED`, `AUTH_EXPIRED`, `MISCONFIGURED_DATASOURCE`, or any non-`ok` response, surface `error.code`, `error.message`, and `nextActionDetails`, then stop. Direct shell fallback needs an explicit user request.
- **Read-only by default.** Keep queries read-only unless the user explicitly asks for mutation and the datasource policy allows it. Redis mutate and flush tiers are gated separately (see `references/redis.md`).
- **Never hand-write engine JSON-path SQL** (`JSON_EXTRACT`, `->`, `->>`, `JSON_VALUE`). Select the raw column and use `--json-extract <column>:<dotpath>`, or parse offline.
- **Keep partition and indexed keys as bare columns** in `WHERE` and `JOIN`. Wrapping them in `TO_DAYS()`, `DATE()`, or `CAST()` forces `partition:all`, a full scan.
- **Prefer existing state over rediscovery.** If the datasource, env/service mapping, target, database, or query intent is already known from the user, KB, cache, or prior output, use it. Do not re-resolve to reconfirm.
- Never read TapRoot cache, learning, or credential files directly. Use TapRoot commands.
- Environment safety and service aliases come from `~/.taproot/config/deterministic-config.json`, not hardcoded env names. Use the canonical service name when known; aliases resolve transparently but should not be stored.

## Everywhere invariants
- Use `--json` for anything parsed or relayed. Envelope: `{ ok, data, meta, error }`.
- `data.rows` is positional, paired with `data.columns` and marked `data.rowsForm: "array"`. Index via `data.columns.indexOf("<col>")`. `--rows-object` only for a consumer that needs the legacy form.
- `--pluck <dot.path>` projects a subtree in-process; prefer it over piping to jq. On failure it writes the error envelope to stderr and exits non-zero, so always gate on exit code.
- The SQL or native command goes in `--query "<native>"` (alias `--sql`), never as a positional argument; a positional string fails with "too many arguments for 'query'". Example: `taproot --json query --datasource <name> --reason "<why>" --query "<sql>" --pluck data.rows`
- Every query response carries `meta.schemaContext` for referenced tables (SQL) or the called service and messages (gRPC). Read it instead of re-introspecting.
- The table catalog is cached per datasource for 24 h (`TAPROOT_CATALOG_TTL_HOURS`). After a migration, force a re-read with `learn refresh-schema --datasource <name>`.
- Wide scans warn rather than block: `unbounded_range`, `wide_range:<table>.<key>:actual=N:max=M`, and `range_unverified` land in `data.warnings`. Tighten the range unless the wide scan is intended.
- Queries default to a 15000 ms timeout. Raise with `--timeout <ms>` only when a slower query is intentional.
- Connections run in UTC, so timestamp literals are UTC and match rendered values. Override with `--tz` rather than shifting literals by hand.
- Prefer `--datasource` when the datasource is known, `--env` + `--service` when resolution is part of the task.
- For repeated Teleport-style access, start the daemon and open a session; a cold `tsh proxy db` costs 3 to 10 s per call.

## Error codes
One recovery action each. Do not loop. If it does not resolve, return the error plus `nextActionDetails` and stop.

- `CONNECTIVITY`: rerun `doctor --datasource <n> --connect` **once**, then stop.
- `REDUNDANT_INTROSPECTION`: read the cache via the `nextCommand` in `error.details`. Never retry the DDL query.
- `ACCESS_DENIED` / `AUTH_EXPIRED`: fail fast. Tell the user to run `tsh login` or `taproot creds set` themselves. Never spawn an interactive `tsh login`.
- `BAD_INPUT`: invalid arguments or missing params. Re-read the command signature; do not retry blindly.
- `MISSING_PARTITION_PREDICATE`: add the partition column(s) to `WHERE`/`JOIN` and retry. `--allow-partition-scan` needs explicit authorization.
- `UNKNOWN_TARGET`: verify the datasource name, then rerun resolution.
- `MISCONFIGURED_DATASOURCE`: repair with `taproot --json init datasource --env <env> --service <service>`.
- `DETERMINISTIC_REQUIRED` / `DISCOVERY_UNAVAILABLE`: populate deterministic routing via datasource profiles, KB, or prior learning. `--allow-discovery` is a last resort and needs explicit authorization.
- `OVERLOADED`: daemon queue full. Wait and retry once, or set `TAPROOT_FORCE_DIRECT=1`.
- `SESSION_BUSY`: concurrent-lease cap hit. Wait for in-flight queries or open a new session.

## Readiness in one line
`taproot init` (add `--kind mysql|postgres|redis|grpc`) prints checks plus an ordered list of runnable next actions. `warn` means not configured yet, not broken. Bare `taproot doctor` is not a health check: it needs `--datasource` or `--env`+`--service`. Read `nextActionDetails[0].command` for the top action; only `self-check --agent` also emits `nextCommand`. Details in `references/setup.md`.
