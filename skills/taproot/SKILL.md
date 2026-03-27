---
name: taproot
description: Use TapRoot for deterministic datasource queries, doctor checks, KB resolution, explicit cache operations, and session-backed connector workflows. Trigger when users ask to run DB/service queries through TapRoot, diagnose connector or auth issues, resolve env/service to a datasource, reuse learned query or target selections, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB scripts.
---

# TapRoot

Use TapRoot as the canonical DB/operator path.

## Hard Rules
- Prefer `--json` for command execution paths that will be parsed or relayed.
- Prefer `--datasource` when the datasource is already known; use `--env` + `--service` when resolution is part of the task.
- Prefer known-good existing TapRoot state over rediscovery. If datasource, service/env mapping, target, database, or query intent is already known from the user, KB, saved templates, cache, or prior TapRoot output, use it directly instead of rediscovering it.
- Prefer `--intent` or `--template` over raw SQL when the task matches an existing query shape. Raw SQL is the fallback, not the default.
- Keep queries read-only unless the user explicitly requests mutation and the datasource policy allows it.
- TapRoot query execution defaults to a 5000ms timeout. Only raise it with `--timeout-ms <ms>` when a slower query is intentional.
- Never inspect TapRoot cache, learning, or credential files directly. Use TapRoot commands only.
- Respect runtime config from `~/.taproot/config/deterministic-config.json`; environment safety and service alias behavior come from config, not hardcoded env names.
- Service names are normalized through `serviceAliases` in runtime config. Always use the canonical service name when known; aliases resolve transparently but should not be stored.
- Do not fall back to direct `mysql`, `psql`, or `tsh` commands for DB work unless the user explicitly requests that fallback.

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
  - First: `taproot --json query --datasource <name> --intent "<intent>" --param key=value`
  - Second: `taproot --json query --datasource <name> --template <id> --param key=value`
  - Third: `taproot --json query --datasource <name> --query "<sql>"`
- Use `taproot --json cache resolve-query --service <service> --intent "<intent>"` when you suspect an intent/query mapping already exists and need to inspect it before writing SQL.
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
- Use `taproot --json template list` to see available templates.
- Use `taproot --json template validate --id <id>` to check parameter coverage before relying on a template.
- Use `taproot --json template run --id <id> --param key=value` to render a template without executing it.
- Use `taproot --json template save --id <id> --intent "<intent>" --query "<sql>"` to create a reusable template.

5. Reuse and inspection.
- Use `taproot --json cache lookup-target --env <env> --service <service> --intent "<intent>"` to inspect saved target selections.
- Use `taproot --json cache resolve-query --service <service> --intent "<intent>"` to inspect saved query templates.
- Use `taproot --json cache save-target ...` or `taproot --json cache save-query ...` only when the user explicitly wants to pin a reusable target or query shape.
- Use `taproot --json learn status` or `taproot --json learn replay --run-id <id>` for learning/run inspection.
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
- `CONNECTIVITY` or connector failures: rerun doctor with `--connect` once, then return `checks`, ordered `nextActions`, and structured `nextActionDetails`.
- `ACCESS_DENIED` or `AUTH_EXPIRED`: fail fast and return the exact error plus the next operator action.
- `BAD_INPUT`: invalid CLI arguments or missing required params. Check the command signature and required options.
- `UNKNOWN_TARGET`: datasource or target not found. Verify the datasource name first, then rerun resolution.
- `OVERLOADED`: daemon query queue is full. Wait and retry, or use direct CLI mode with `TAPROOT_FORCE_DIRECT=1`.
- `SESSION_BUSY`: the per-session concurrent lease cap is exceeded. Wait for in-flight queries to finish, or open a new session.
- `DETERMINISTIC_REQUIRED`: require a deterministic path from datasource profile or KB, or a config/CLI setting that explicitly enables discovery for that environment.
- `DISCOVERY_UNAVAILABLE`: populate deterministic routing through datasource profiles, KB, or prior TapRoot learning before retrying.
- `MISCONFIGURED_DATASOURCE`: the datasource profile conflicts with stronger KB-backed routing and should be repaired with `taproot --json init datasource --env <env> --service <service>` before query execution.

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
