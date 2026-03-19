---
name: taproot
description: Use TapRoot for deterministic datasource queries, doctor checks, KB resolution, explicit cache operations, and session-backed connector workflows. Trigger when users ask to run DB/service queries through TapRoot, diagnose connector or auth issues, resolve env/service to a datasource, reuse learned query or target selections, inspect TapRoot KB/cache state, or work through TapRoot instead of ad-hoc DB scripts.
---

# TapRoot

Use TapRoot as the canonical DB/operator path.

## Hard Rules
- Prefer `--json` for command execution paths that will be parsed or relayed.
- Prefer `--datasource` when the datasource is already known; use `--env` + `--service` when resolution is part of the task.
- Keep queries read-only unless the user explicitly requests mutation and the datasource policy allows it.
- Never inspect TapRoot cache, learning, or credential files directly. Use TapRoot commands only.
- Respect runtime config from `~/.taproot/config/deterministic-config.json`; environment safety and service alias behavior come from config, not hardcoded env names.
- Service names are normalized through `serviceAliases` in runtime config. Always use the canonical service name when known; aliases resolve transparently but should not be stored.

## Setup & Credentials
- Use `taproot --json self-check` at the start of a new machine or repo setup to validate runtime, state root, KB dir, and built-in plugins.
- Use `taproot --json creds set --ref <ref> --user <u> --password <p>` to store credentials, or add connector-specific keys such as `--status-command`, `--connect-command`, `--disconnect-command`, and `--login-command`.
- Use `taproot --json creds show --ref <ref>` to verify a credential ref. Sensitive values are redacted.
- Use `taproot --json creds unset --ref <ref>` only when the user explicitly wants to remove a saved credential ref.
- Use `taproot --json connector setup --datasource <name> --connector <name> --ref <ref>` to wire a connector to a datasource.
- Use `taproot --json connector status --datasource <name>` to check connector health.
- Add `--connector <name>` to filter connector checks to a single connector.
- Add `--all` or `--verbose-detail` when the user needs the full connector check table or expanded details.

## Workflow
1. Resolve the target path.
- Start with `taproot --json doctor --datasource <name>` when a datasource is known.
- Add `--all` or `--verbose-detail` when doctor output needs full check coverage or expanded connector detail.
- Start with `taproot --json kb resolve-connection --service <service> --env <env>` or `taproot --json datasource resolve --env <env> --service <service>` when env/service resolution is needed.
- Use `taproot --json kb list-services` when the service name is uncertain.

2. Preflight connectors and auth.
- Run `taproot --json doctor --datasource <name> --connect` before query execution when connector or auth state may matter.
- If doctor returns failures, stop and surface `checks` and `nextActions`.

3. Execute the query path.
- Use `taproot --json query --datasource <name> --query "<sql>"` for explicit SQL.
- Use `taproot --json query --datasource <name> --intent "<intent>" --param key=value` for learned or KB-backed query reuse.
- Use `taproot --json query --datasource <name> --template <id> --param key=value` to execute a saved template directly.
- When env/service is the entrypoint, use `taproot --json query --env <env> --service <service> ...`.
- Add `--allow-discovery` when the environment policy does not enable discovery by default but the user has explicitly authorized it.
- Read `resolved` metadata in the result to understand source, engine, target, database, and access method.

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

6. Prefer session-backed execution for repeated Teleport-style access.
- Use `taproot --json daemon start` and `taproot --json session open ...` when repeated queries are expected and the datasource uses session-backed access.
- Treat daemon/session mode as the preferred efficiency path for repeated Teleport DB queries.

## Operations
- Use `taproot --json self-check` to validate the runtime environment before debugging higher-level failures.
- Use `taproot --json sanitize check-repo` before committing or sharing the repo to scan tracked files for leaked secrets.
- Use `taproot completion zsh` or `taproot completion bash` / `fish` to inspect or install shell completion output.

## Error Handling
- `CONNECTIVITY` or connector failures: rerun doctor with `--connect` once, then return `checks` and `nextActions`.
- `ACCESS_DENIED` or `AUTH_EXPIRED`: fail fast and return the exact error plus the next operator action.
- `BAD_INPUT`: invalid CLI arguments or missing required params. Check the command signature and required options.
- `UNKNOWN_TARGET`: datasource or target not found. Verify the datasource name first, then rerun resolution.
- `OVERLOADED`: daemon query queue is full. Wait and retry, or use direct CLI mode with `TAPROOT_FORCE_DIRECT=1`.
- `SESSION_BUSY`: the per-session concurrent lease cap is exceeded. Wait for in-flight queries to finish, or open a new session.
- `DETERMINISTIC_REQUIRED`: require a deterministic path from datasource profile or KB, or a config/CLI setting that explicitly enables discovery for that environment.
- `DISCOVERY_UNAVAILABLE`: bypass the daemon and use direct CLI mode when explicit discovery is required.

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
