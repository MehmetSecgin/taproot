# TapRoot Porcelain vs Plumbing Contract

This document defines TapRoot's CLI surface as two layers:

- **Porcelain** — human-first commands. Default output is compact, may use color, animation, or interactive prompts. Output format may evolve between releases.
- **Plumbing** — agent/script-first commands and modes. Output is the frozen [JSON envelope](json-envelope-contract.md). Stable across patch releases; breaking changes bump the envelope version.

The split is per **invocation**, not per **command name**. Most commands have both a porcelain default and a plumbing `--json` mode. A few commands exist purely on one side.

## Rules

### Mode selection
- `--json` (or `TAPROOT_JSON=1`) switches a command into plumbing mode.
- In plumbing mode, stdout contains **exactly one** JSON payload conforming to the shared envelope. No banners, no progress, no color codes.
- Human progress, hints, and animations go to stderr in plumbing mode, never stdout.
- Porcelain (human) mode is the default. It may print free-form text, tables, hints, and color.

### Plumbing guarantees
- Stable envelope shape (`ok`, `data`, `meta`, `error`) — see [json-envelope-contract.md](json-envelope-contract.md).
- Stable exit code taxonomy: `0` success, non-zero failure with `error.code` set.
- `--pluck <dot-path>` projects a subtree of the envelope for token-efficient agent consumption (e.g. `--pluck data.rows`, `--pluck data.tables[0].indexes`).
- New fields may be added; existing fields will not change type or be silently renamed within a major version.
- `meta.requestId` is included for any command that goes through the daemon.

### Porcelain guarantees
- Stable command names and primary flags within a major version.
- Human output layout (column order, spacing, hint text) is **not** stable and may change between minor releases.
- Interactive prompts are allowed in porcelain mode only.
- Color and animation respect `NO_COLOR`, `--no-color`, and `--no-animations`.

### Cross-mode rules
- A command must never emit interactive prompts in plumbing mode. If input is missing, fail with `error.code = "MISSING_INPUT"` (or equivalent) and exit non-zero.
- Mutate operations are gated identically in both modes: `--allow-mutate` (or policy) is required regardless of output format.
- A command's data semantics must match across modes — `--json` is a different rendering of the same result, not a different operation.

## Command Matrix

Legend:
- **P** — porcelain (human) supported
- **L** — plumbing (`--json`) supported and contract-stable
- **L+pluck** — plumbing with `--pluck` projection
- **—** — not applicable

| Command | P | L | Notes |
|---|---|---|---|
| `init` | P | L | First-run bootstrap. `init --check` returns readiness without writing. |
| `init datasource` | P | L | KB-backed datasource bootstrap and repair. |
| `self-check` | P | L | `--agent` for machine-readable readiness states. Target-aware via `--datasource` / `--env`+`--service`. |
| `doctor` | P | L+pluck | Pre-flight diagnostics. Structured `nextActionDetails` in plumbing mode. |
| `query` | P | L | Primary execution path. Daemon-routed includes `meta.requestId`, `meta.runId`, `meta.sessionId`. |
| `datasource list/show/add/remove/resolve/import/export` | P | L+pluck | All emit the `{ok,data,...}` envelope; pluck paths are `data`-prefixed. `import --file` bulk-adds profiles; `export` round-trips with it. |
| `kb resolve-* / tables / related / list-services` | P | L+pluck | Knowledge-base resolvers; safe-by-default read paths. |
| `learn status/schema/tables/joins/shapes/ensure-schema/refresh-schema` | P | L+pluck | Learning cache inspection and maintenance. |
| `template list/validate/run/save` | P | L | `template run` resolves a saved template into a query payload. |
| `cache show/lookup-target/save-target/resolve-query/save-query/prune/clear` | P | L | Cache maintenance. |
| `creds set/show/list/unset/migrate-to-fallback` | P | — | Interactive by design; credential material never returned in plumbing JSON. |
| `connector status/setup` | P | L | `status` plumbing-safe. `setup` may prompt in porcelain. |
| `daemon start/status/stop/restart` | P | L | Daemon lifecycle. Plumbing always includes `meta.requestId`. |
| `session open/ls/inspect/close/close-all` | P | L | Session lifecycle through `taprootd`. |
| `run show/list` | P | L | Inspect persisted run artifacts. |
| `card list/show/validate` | P | L | Curated query cards. |
| `sanitize check-repo` | P | L | Secret/sensitive leak scan. |
| `onboard` | P | — | Interactive porcelain only. |
| `completion <shell>` | P | — | Emits shell-completion script to stdout. |
| `__complete` | — | — | Hidden completion provider. Internal, not part of public contract. |

## Agent Workflow Template

The recommended plumbing entry for an agent:

```bash
taproot --json self-check --agent --env <env> --service <service>
```

Decision tree:
1. `data.state === "ready"` → proceed to query.
2. otherwise → run `data.nextAction.command` (or follow `data.nextActionDetails`) and re-check.

For query execution:

```bash
taproot --json query --datasource <name> --query "<sql>" --pluck data.rows
```

For schema discovery without re-querying:

```bash
taproot --json learn schema --datasource <name> --pluck data.tables
taproot --json learn joins --datasource <name>
```

## Versioning

- Envelope schema version: `v1` (frozen prerelease).
- Porcelain layout is not versioned; treat any human-mode output as informational.
- Breaking plumbing changes (renamed/removed fields, changed types) require a version bump and entries in both this file and [json-envelope-contract.md](json-envelope-contract.md).

## Test Coverage Targets

For every command listed with **L** above:
- One test asserting `ok=true` envelope shape on success path.
- One test asserting `ok=false` envelope shape and `error.code` on a representative failure path.
- For **L+pluck** commands: one test asserting `--pluck` returns the projected subtree.

These tests live alongside the command's existing suite under `test/`.
