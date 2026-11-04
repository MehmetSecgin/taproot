---
name: taproot
description: Use whenever a task runs, names, or points at the `taproot` CLI, or needs to read a MySQL/TiDB database, Redis/Dragonfly cache, or gRPC endpoint through a datasource profile. Also use for TapRoot doctor checks, connector or auth failures (Teleport, kubectl port-forwards), and KB resolution, and instead of ad-hoc `mysql`, `redis-cli`, `grpcurl` or `tsh` commands.
---

# TapRoot

Learn commands from `taproot --help` and `taproot <command> --help`. Every error carries a code, and most messages name the fix. This page holds only the rules the CLI cannot enforce.

## Rules
- **Every query goes through `taproot query`.** Never run `mysql`, `psql`, `redis-cli`, `grpcurl`, `tsh db exec` or `tsh proxy db` directly, even when TapRoot fails.
- **Read-only unless the user asks for a write.** `--allow-mutate`, `--allow-flush`, `--allow-partition-scan` and `--allow-discovery` each need the user's explicit go-ahead for that task. On `MISSING_PARTITION_PREDICATE`, add the partition column to `WHERE` instead.
- **One fix per error, then stop.** Change the cause before retrying, and never resend a failing query unchanged. If the fix the error names does not work, report `error.code` and `error.message` and stop.
- **Auth is the user's job.** On `ACCESS_DENIED` or `AUTH_EXPIRED`, tell the user to run `tsh login` or `taproot creds set`. Never start an interactive login yourself. On `MISSING_TOOL`, tell the user what to install; do not install it.
- **On `CONNECTIVITY`, run `taproot doctor --datasource <name> --connect` once**, then report what it says.
- **Never probe with `SELECT 1`.** Run the real query; a dead connector fails it with `CONNECTIVITY` anyway.
- **Never guess table or column names.** Use the names the user, code or migrations give, or look them up with `SHOW TABLES` and `SHOW CREATE TABLE`.
- **Keep partition and indexed columns bare** in `WHERE` and `JOIN`. Wrapping them in `DATE()`, `TO_DAYS()` or `CAST()` scans every partition.
- **Never hand-write JSON-path SQL** (`JSON_EXTRACT`, `->`, `->>`, `JSON_VALUE`). Path and null/type handling differ between MySQL and TiDB. Select the raw column and use `--json-extract <column>:<dotpath>`.
- **Never read TapRoot's cache or credential files.** Use TapRoot commands.

## Output
- One line of JSON per command: `{ok, data, meta, error}`. The exit code is non-zero whenever `ok` is false.
- Use `--lines` (one row per line) or `--pluck <path>` instead of `| jq`. A jq filter like `.data.rows` prints `null` on failure and hides the error.
- JSON columns come back already parsed; do not `fromjson` them.
