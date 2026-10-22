# Output: JSON envelope, pluck, benchmarking

## Envelope
- Every command prints exactly one line of compact JSON on stdout: results, errors, `--help` and `--version`. stderr stays empty unless `--verbose` is set.
- Stable envelope shape: `{ ok, data, meta, error }`. `meta.requestId` on daemon-routed commands, `meta.sessionId` where applicable.
- The JSON envelope is compacted across all surfaces (rows as positional arrays, schema-context indexes stripped of defaults, empty arrays omitted).
- Frozen envelope shape: `references/json-envelope-contract.md` in the project repo.

## Rows
`data.rows` is an array of arrays paired with `data.columns`, confirmed by the `data.rowsForm: "array"` marker. Index by column name: `data.rows[i][data.columns.indexOf("id")]`. The shape is identical for daemon-routed and direct queries. Pass `--rows-object` only when a downstream consumer needs the legacy object form keyed by column name.

## Types and time
- JSON-typed columns come back as native values when the engine surfaces them as JSON, otherwise as strings.
- Datetime cells render ISO-8601 UTC by default. Connections run with the session time zone set to UTC, so `WHERE` timestamp literals are interpreted as UTC and match the rendered values. Override per query with `--tz <offset|name>`.
- For JSON columns, do **not** hand-write engine JSON-path SQL (`JSON_EXTRACT`, `->`, `->>`, `JSON_VALUE`): path syntax and null/type handling differ between MySQL and TiDB and are easy to get subtly wrong. `SELECT` the raw column and extract client-side with `--json-extract <column>:<dotpath>` (repeatable), which parses the cell after fetching and adds a derived `<column>.<dotpath>` column. For shapes it cannot express (arrays, conditional walks), pull the raw column and parse offline with jq or python.

## schemaContext
- `meta.schemaContext.tables[<table>]` carries `database`, `columns`, `primaryKey`, `indexes` (`unique` appears only when true, `type` only when not BTREE), and `partition`. Read it before the next query against that datasource instead of re-running `SHOW CREATE`.
- `meta.schemaContext.catalog` is `{ tables, fetchedAt }` for the datasource's cached catalog.
- gRPC queries carry `meta.schemaContext.services`, `.messages`, and `.enums` instead.
- Empty `warnings` and empty `meta.schemaContext.tables` are omitted entirely.

## Pluck
- `--pluck <dot.path>` returns only that subtree of the envelope and cuts token cost sharply. Array indexing works (`data.rows[0]`). It is a global option, so every command accepts it. Pluck runs in-process, so prefer it over `| jq` for anything it can reach.
- On a **failed** command `--pluck` is ignored: stdout gets the full error envelope (`{"ok":false,"error":{code,message,details}}`) and the exit code is non-zero. When capturing a plucked value, always gate on exit code.
- Paths differ per command:
  - `query ... --pluck data.rows` (rows only), `--pluck data.columns`, `--pluck meta.schemaContext.tables.<t>.indexes`.
  - Every command wraps output in `{ok,data}`, so paths need the `data.` prefix: `--pluck "data[0].name"`, `--pluck data.readiness`, `jq '.data[]'`.
  - `--pluck "length"` is unsupported; jq is still needed for aggregates.

## Large results
To reuse an earlier result, keep the output you already have. For results over 32 KB, use `--pluck` or `| jq` for precise extraction instead of awk or sed.

## Timing
`taproot query` JSON exposes the phase split at `meta.phases` (`resolveMs`, `connectMs`, `executeMs`, `totalMs`) and overall `meta.timings.durationMs`, identical for daemon-routed and direct queries. Use it to attribute a slow query to resolution, connector preflight, or raw execution before touching timeouts. `--verbose` also prints each phase to stderr.
