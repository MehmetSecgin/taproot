# Troubleshooting

Map symptoms to TapRoot commands. Do not bypass with direct shell DB tools.

- **Hangs about 10 s, then `CONNECTIVITY: teleport proxy path unavailable`.** `tsh proxy db` is exiting before TCP-ready (expired cert, bad db user, missing target). Run `taproot --json doctor --datasource <n> --connect --verbose-detail`. Check `tsh status` outside TapRoot to diagnose only; do not switch to direct `tsh db exec` for the actual query.
- **`REDUNDANT_INTROSPECTION` on `SHOW CREATE TABLE`, `DESCRIBE`, or `SHOW COLUMNS`.** The service schema is already cached. Read it with `taproot --json learn ensure-schema --service <svc>` (or `learn schema --datasource <name>`). The cache holds columns, indexes, primary key, and partition, and the error's `details.nextCommand` points at the exact read. Pass `--allow-schema-introspection` only when the user explicitly asks for raw DDL or you suspect drift the cache missed.
- **Same service across env or namespace.** The schema cache is service-keyed, so one `learn refresh-schema --service <svc>` covers every env for that service. Re-running per env is wasted work.
- **`taproot doctor` slow (over 15 s).** Usually OpenVPN connect (up to 20 s) or a cold `tsh proxy db`. Drop `--connect` if you only need status, and confirm the daemon is started so later queries reuse the session.
- **Query timeout fires immediately.** Connector preflight ran before the query timeout applied. Pass `--timeout` large enough to cover preflight plus query.
- **First query against a Teleport datasource is always slow.** Cold-spawning `tsh proxy db` is the cost. Start the daemon and open a session, then query.
- **SQL syntax error on a column alias.** A reserved word used as a bare alias (`COUNT(*) rows`, `... AS rank`) is rejected by the engine. The error names the offender in a `taproot hint`; quote it with backticks or rename the alias.
- **Timestamp filters select the wrong window.** Connections run in UTC, so `WHERE ts BETWEEN ...` literals are UTC and match the rendered UTC values. If a datasource genuinely needs another zone, pass `--tz <offset|name>` or set `resolverHints.timeZone` / `defaults.query.timeZone`. Never compensate by hand-shifting literals.
- **gRPC call fails.** Split the problem first: `grpc list` is offline, so if it also fails the proto root is wrong; if it succeeds and `doctor` fails, it is connectivity. See `references/grpc.md`.
- **A fresh install shows warns and you are unsure whether it is broken.** `warn` on `kb_dir`, `datasources`, or `credentials` means not configured yet. `init` exits 0. Bare `taproot doctor` needs a target and exits non-zero without one, which is not an install failure. See `references/setup.md`.
