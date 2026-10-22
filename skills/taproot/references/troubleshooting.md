# Troubleshooting

Map symptoms to TapRoot commands. Do not bypass with direct shell DB tools.

- **Hangs about 10 s, then `CONNECTIVITY: teleport proxy path unavailable`.** `tsh proxy db` is exiting before TCP-ready (expired cert, bad db user, missing target). Run `taproot doctor --datasource <n> --connect`. Check `tsh status` outside TapRoot to diagnose only; do not switch to direct `tsh db exec` for the actual query.
- **Need a table's columns, indexes, or partition key.** `SHOW CREATE TABLE <t>` with `--pluck meta.schemaContext.tables.<t>`. The full question-to-command table is in `references/sql.md`.
- **Columns from a migration are missing in `meta.schemaContext`.** The catalog is cached per datasource for 24 h. An `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` error refetches it in the background, so retry once after that error.
- **The same query keeps failing.** Resending it fails the same way. Read `error.code` and `error.message`, change the cause, then retry.
- **`taproot doctor` slow (over 15 s).** Usually a cold `tsh proxy db` or a port-forward that is still starting. Drop `--connect` if you only need status; queries reuse the daemon's open tunnels after the first one.
- **Query timeout fires immediately.** Connector preflight ran before the query timeout applied. Pass `--timeout` large enough to cover preflight plus query.
- **First query against a Teleport datasource is always slow.** Cold-spawning `tsh proxy db` is the cost. Start the daemon and open a session, then query.
- **SQL syntax error on a column alias.** A reserved word used as a bare alias (`COUNT(*) rows`, `... AS rank`) is rejected by the engine. The error names the offender in a `taproot hint`; quote it with backticks or rename the alias.
- **Timestamp filters select the wrong window.** Connections run in UTC, so `WHERE ts BETWEEN ...` literals are UTC and match the rendered UTC values. If a datasource genuinely needs another zone, pass `--tz <offset|name>` or set `resolverHints.timeZone` / `defaults.query.timeZone`. Never compensate by hand-shifting literals.
- **gRPC call fails.** Split the problem first: `grpc list` is offline, so if it also fails the proto root is wrong; if it succeeds and `doctor` fails, it is connectivity. See `references/grpc.md`.
- **A fresh install shows warns and you are unsure whether it is broken.** `warn` on `kb_dir`, `datasources`, or `credentials` means not configured yet. `init` exits 0. Bare `taproot doctor` needs a target and exits non-zero without one, which is not an install failure. See `references/setup.md`.
