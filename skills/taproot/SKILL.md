---
name: taproot
description: Use TapRoot for deterministic datasource queries, doctor checks, KB resolution, explicit cache operations, and session-backed connector workflows. Trigger when users ask to run DB/service queries through TapRoot, diagnose connector or auth issues, resolve env/service to a datasource, reuse learned query or target selections, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB scripts.
---

# TapRoot

Use TapRoot as the canonical DB/operator path.

## Hard Rules
- **Schema first.** Before any exploratory table/column SQL, run `taproot --json learn ensure-schema --datasource <name>` or `--env <env> --service <service>`. It returns cached learning when present and runs one introspection pass when missing. Do not rediscover tables/columns with ad-hoc queries.
- **Read schemaContext.** Every `taproot query` response carries `meta.schemaContext` for referenced learned tables. Read it for partition keys and indexes before writing the next query against the same datasource. Do not re-run `SHOW CREATE` when `schemaContext` already has the table metadata.
- **All DDL inspection goes through TapRoot.** When you need DDL, use `taproot --json query --query "SHOW CREATE TABLE <db>.<table>"` (or `SHOW FULL COLUMNS FROM <table>`). Never run `mysql -e`, `psql -c`, `tsh db exec`, or `tsh proxy db` directly. Routing the query through TapRoot lands the result in the learning store and benefits the next agent.
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

## Setup & Credentials
- Use `taproot --json init` at the start of a new machine or repo setup to create starter runtime state and get the current readiness summary.
- Use `taproot --json self-check --agent` for machine-readable readiness, and prefer targeted runs with `--datasource <name>` or `--env <env> --service <service>` when checking a real query path.
- Use `taproot --json init datasource --env <env> --service <service>` as the explicit KB-backed create/repair path for datasource profiles.
- Treat `nextActionDetails` as the preferred remediation contract in `init --json`, `self-check --agent --json`, and `doctor --json`; keep `nextActions` and `nextCommand` only for compatibility.
- Use `taproot --json creds set --ref <ref> --user <u> --password <p>` to store credentials, or add connector-specific keys such as `--status-command`, `--connect-command`, `--disconnect-command`, and `--login-command`.
- Use `taproot --json creds show --ref <ref>` to verify a credential ref. Sensitive values are redacted.
- Use `taproot --json creds unset --ref <ref>` only when the user explicitly wants to remove a saved credential ref.
- Use `taproot --json connector setup --datasource <name> --connector <name> --ref <ref>` to wire a connector to a datasource.
- Use `taproot --json connector status --datasource <name>` to check connector health.
- Add `--connector <name>` to filter connector checks to a single connector.
- Add `--all` or `--verbose-detail` when the user needs the full connector check table or expanded details.

## Workflow
1. Resolve the target path.
- If the datasource is already known, use it directly. Do not start with `doctor` for routine reads.
- Use `taproot --json kb resolve-connection --service <service> --env <env>` or `taproot --json datasource resolve --env <env> --service <service>` only when env/service resolution is actually needed.
- Use `taproot --json kb list-services` when the service name is uncertain.
- If a targeted path may not be ready, run `taproot --json self-check --agent --datasource <name>` or `taproot --json self-check --agent --env <env> --service <service>` before deeper diagnosis.
- Do not re-run discovery or resolution steps just to reconfirm information already provided by the user or already present in TapRoot state.

2. Preflight connectors and auth.
- Run `taproot --json doctor --datasource <name> --connect` only when connector or auth state is the task, or when the previous query attempt failed for connectivity/auth reasons.
- If readiness or doctor returns failures, stop and surface `checks`, `nextActions`, and `nextActionDetails`.
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
- Read `resolved` metadata in the result to understand source, engine, target, database, and access method.
- For MySQL/TiDB schema discovery, prefer direct introspection primitives over `information_schema` sweeps:
  - Use `SHOW TABLES` to discover candidate tables.
  - Never use `LIKE`-based table discovery. List tables first, then choose exact table names to inspect.
  - Use `SHOW CREATE TABLE <table>` to inspect columns, indexes, and DDL for a specific table.
  - Use `SHOW FULL COLUMNS FROM <table>` only when column-level detail is needed without full DDL.
  - Do not query `information_schema.tables`, `information_schema.columns`, or similar metadata tables for basic table/column discovery unless the user explicitly needs cross-table search, bulk machine-readable metadata, or a database-wide audit.
- Schema discovery is last resort work. If the user already named the table or TapRoot already has the query shape, do not start with table discovery.

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
- Use `taproot --json learn ensure-schema --datasource <name>` as the default first read for table/column context.
- Use `taproot --json learn schema --datasource <name>` when you explicitly want a read-only view of current learned schema without triggering introspection.
- Use `taproot --json learn tables --datasource <name> --limit <n>`, `learn joins`, and `learn shapes` to inspect learned schema observations.
- Use `taproot --json learn refresh-schema --datasource <name>` when learned schema is empty or stale and TapRoot needs to refresh metadata itself.

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

- `CONNECTIVITY` / connector failures: rerun `doctor --datasource <n> --connect` ONCE. If still failing, return `checks` + ordered `nextActions` + structured `nextActionDetails` and stop.
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
- **Repeated `SHOW CREATE TABLE` calls in a session** — call `taproot --json learn ensure-schema ...` once at the start. The schema cache answers column / index / DDL questions. Re-running `SHOW CREATE` per question is the smell that introspection was skipped.
- **`taproot doctor` slow (>15 s)** — likely OpenVPN connect (up to 20 s) or cold `tsh proxy db`. Drop `--connect` if you only need status. Confirm the daemon is started so subsequent queries reuse the session.
- **Query timeout fires immediately** — connector preflight ran before the query timeout was applied. Pass `--timeout-ms` large enough to cover preflight + query.
- **First query against a prod tsh datasource is always slow** — start the daemon and open a session, then run queries. Cold-spawn `tsh proxy db` is the cost.

## First Successful Query — Prod TSH Smoke Test

Verify TapRoot is healthy against a known prod datasource (read-only DDL only):

```bash
taproot --json daemon start
taproot --json learn ensure-schema --env prod --service order-processor
taproot --json query --env prod --service order-processor --query "SHOW CREATE TABLE order_service.order_items"
```

## First Successful Query (Happy Path)
```bash
taproot --json init
taproot --json init datasource --env qa --service orders
taproot --json creds set --ref qa:orders --user reader --password <password>
taproot --json doctor --datasource qa-orders --connect
taproot --json query --datasource qa-orders --query "SELECT 1 AS ok"
```

## References
- For command patterns and decision points, read `references/workflows.md`.
