# Output: JSON envelope, JSON lines, pluck, benchmarking

## Porcelain vs plumbing
- Every command has a stable plumbing form (`--json` envelope) and a porcelain form (human output). For agent workflows always use plumbing, since porcelain layout is not version-stable.
- Stable envelope shape: `{ ok, data, meta, error }`. `meta.requestId` on daemon-routed commands, `meta.runId` and `meta.sessionId` where applicable.
- The JSON envelope is compacted across all surfaces (rows as positional arrays, schema-context indexes stripped of defaults, query-memory deduped, empty arrays omitted). Token cost is roughly the same as the box-drawing table form, with type fidelity and unambiguous parsing on top.
- Full matrix and stability rules: `references/porcelain-plumbing-contract.md` in the project repo. Frozen envelope shape: `references/json-envelope-contract.md` in the project repo.

## Rows
`data.rows` is an array of arrays paired with `data.columns`, confirmed by the `data.rowsForm: "array"` marker. Index by column name: `data.rows[i][data.columns.indexOf("id")]`. The shape is identical for daemon-routed and direct queries. Pass `--rows-object` only when a downstream consumer needs the legacy object form keyed by column name.

## Types and time
- JSON-typed columns come back as native values when the engine surfaces them as JSON, otherwise as strings.
- Datetime cells render ISO-8601 UTC by default. Connections run with the session time zone set to UTC, so `WHERE` timestamp literals are interpreted as UTC and match the rendered values. Override per query with `--tz <offset|name>`. Global `--datetime-format iso|js|epoch` (default `iso`); pass `js` only for a parser that needs the legacy `Date.toString()` form, `epoch` for ms-since-epoch numerics.
- For JSON columns, do **not** hand-write engine JSON-path SQL (`JSON_EXTRACT`, `->`, `->>`, `JSON_VALUE`): path syntax and null/type handling differ across MySQL, TiDB, and Postgres and are easy to get subtly wrong. `SELECT` the raw column and extract client-side with `--json-extract <column>:<dotpath>` (repeatable), which parses the cell after fetching and adds a derived `<column>.<dotpath>` column. For shapes it cannot express (arrays, conditional walks), pull the raw column and parse offline with jq or python.

## schemaContext
- `meta.schemaContext.tables[<table>]` carries `columns`, `primaryKey`, `indexes` (defaults `unique:false` and `type:BTREE` stripped), and `partition`. Read it before the next query against that datasource instead of re-running `SHOW CREATE`.
- `meta.schemaContext.relations` is auto-injected when a query touches a table with curated KB relations, cross-service edges first. Each edge is `{ from: "service.table.column", to: "service.table.column", relationship, crossService, notes }`.
- Empty `meta.queryMemory`, empty `warnings`, and empty `meta.schemaContext.tables` are omitted entirely.
- Table render (no `--json`) emits `[schemaContext: N tables cached, M relations - pass --json for full detail]` for SQL kinds, or `[schemaContext: N services, M messages - ...]` for grpc. Treat it as cache-state signal: if N covers what you need, do not call `learn ensure-schema` or `grpc describe` again this session.

## JSON lines
- `--jsonl` is the shortest path from a query to rows: `taproot --jsonl query --datasource <name> --sql "<sql>"` prints one row object per line (`{"id":1,"name":"a"}`), ready for `head`, `grep` or `jq -c`. No envelope, no `meta`, nothing to post-process.
- On failure stdout stays empty, stderr gets one `CODE: message` line plus a `nextAction: ...` line when there is one, and the exit code is non-zero.
- It is global. On other commands an array prints one item per line and anything else prints as one line; `{ok,data}` envelopes are unwrapped to `data`. With `--pluck`, the plucked value is printed the same way.

## Pluck
- `--pluck <dot.path>` returns only that subtree of the envelope and cuts token cost sharply. Array indexing works (`data.rows[0]`). It is a global option, so every command accepts it, and it implies `--json`. Pluck runs in-process, so prefer it over `--json ... | jq` for anything it can reach.
- On a **failed** command `--pluck` prints only the `error` object (`{code,message,details}`) to **stderr** and exits non-zero. When capturing a plucked value, always gate on exit code. Empty stdout plus non-zero exit means failure, not zero rows.
- Paths differ per command:
  - `query ... --pluck data.rows` (rows only), `--pluck data.columns`, `--pluck meta.schemaContext.tables.<t>.indexes`, `--pluck error.details.nextAction`.
  - `learn ensure-schema ... --pluck tables`, NOT `meta.schemaContext.tables`; that nested shape exists only on `query` responses. `--pluck "tables[0]"` for the first table, `--pluck "tables[0].indexes"` for its indexes.
  - `learn tables ... --pluck rows`, `learn joins ... --pluck rows`.
  - `datasource list|show|add|resolve|remove|import|export` wrap output in `{ok,data}`, so paths need the `data.` prefix: `--pluck "data[0].name"`, `jq '.data[]'`.
  - `--pluck "length"` is unsupported; jq is still needed for aggregates.

## Runs
Results persist to `~/.taproot/runs/<runId>/summary.json` for 7 days. The stored copy keeps the first 1000 rows; `result.rowCount` holds the full count and `result.truncated` is `true` when rows were cut. When a later step needs a different slice from an earlier run, fetch it with `taproot --json run show --run-id <id> --pluck <path>` instead of re-running the query. `taproot --json run list --limit <n> [--datasource <name>]` discovers recent run IDs.

Results over 32 KB are persisted to a tool-results file with table formatting preserved. awk and sed on that file are brittle, so switch to `--json | jq` for precise extraction.

## Timing
`taproot query` JSON exposes the phase split at `meta.phases` (`resolveMs`, `connectMs`, `executeMs`, `totalMs`) and overall `meta.timings.durationMs`, identical for daemon-routed and direct queries. Use it to attribute a slow query to resolution, connector preflight, or raw execution before touching timeouts. `--verbose` prints the split inline in human mode.

## Benchmarking
- `taproot --json bench --datasource <name> --sql "<sql>" --iterations <n>` for a single scenario. Reports p50/p95/avg per phase and aggregate totals.
- `taproot --json bench --scenario <file>` for reproducible sweeps. File shape: `{ "iterations": <default>, "scenarios": [{ "name", "datasource"|"env"+"service", "query", "iterations"? }, ...] }`.
- Bench routes through the daemon, so start it first with `taproot --json daemon start`.
- Non-zero exit when any iteration fails, with errors aggregated per error code in `data.scenarios[].errors`.
