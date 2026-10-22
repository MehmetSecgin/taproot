# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.20.0, and 0.25.0 to 0.47.0, are recorded in the git history only. The 1.0.0
entry collects every breaking change released from 0.32.0 to 0.47.0.

## [1.0.0]

### Breaking changes since 0.31.0

- 0.32.0 (#69): `--sql` is the only query text flag. `--query`, `--intent` and `--timeout-ms` are
  removed; use `--sql` and `--timeout`, also on `bench`.
- 0.36.0 (#73): `datasource show` and `datasource remove` take the name as a positional argument
  instead of `--name`. `kb resolve-connection`, `kb resolve-credentials` and
  `kb resolve-database-name` are replaced by `kb resolve`, which also accepts `--datasource <name>`.
- 0.36.0 (#76): `--memory-root`, `OBSIDIAN_MEMORY_ROOT` and the `~/memory-root` fallback are removed.
  Use `taproot init --kb-dir <dir>` or `TAPROOT_KB_DIR`.
- 0.41.0 (#83): every command prints the JSON envelope. `--json`, `--no-color`, `--no-animations`,
  `--datetime-format`, `query --full`, `doctor`/`connector` `--all` and `--verbose-detail`, and
  `config diff --max-lines` are removed, as is the interactive password prompt.
- 0.41.0 (#84): output is one line of compact JSON, errors and `--help` included. `--jsonl`,
  `--skill-version` and the `completion` command are removed. A failure with `--pluck` prints the
  full error envelope on stdout. `--verbose` diagnostics are JSON lines on stderr.
- 0.42.0 (#85): `taproot learn`, `taproot run`, `kb relations validate`, `cache prune`,
  `query --reason` and `query --allow-schema-introspection` are removed, along with `meta.runId`,
  `meta.queryMemory` and relations injection. The schema catalog and the partition guard stay.
- 0.43.0 (#86): `error.details.nextAction`, `nextActionDetails`, `nextCommand`, `phases.catalogMs`,
  `init --kind` and the `self-check --agent` `missing` field are removed. Read `error.code`,
  `error.message`, `readiness` and the failing checks' `code` and `detail` instead.
- 0.44.0 (#88): the CLI keeps eight commands: `query`, `datasource`, `creds`, `doctor`, `init`,
  `kb`, `grpc` and `daemon`. `bench`, `discover`, `session`, `sanitize`, `connector`, `cache`,
  `config`, `self-check`, `daemon start`, `daemon restart`, `datasource export` and
  `creds migrate-to-fallback` are removed; the first query starts the daemon, `init` reports
  readiness and `doctor --connect` checks connectors. The `postgres` kind, the `openvpn` connector
  and `datasource add --openvpn-ref` are removed.
- 0.45.0 (#89): the global `--profile` option and the `defaults.profile` config field are removed.
- 0.46.0 (#90): `kb related` is removed; use `kb relations list [--cross-service]`.
- 0.47.0 (#91): `init`, `doctor`, `creds` and `kb` wrap success output in `{ok,data}` like every
  other command, so their `--pluck` paths gain a `data.` prefix.

### Changed

- The release workflow bumps the major version when a commit since the last tag carries `!` in its
  type or a `BREAKING CHANGE:` footer, and the minor version otherwise.

## [0.24.0]

### Fixed

- The `--query`/`--sql` conflict guard and the `--explain requires --query` guard in `query`, and the
  missing-target and missing-`--query` guards in `bench`, now throw `BAD_INPUT` instead of a plain
  error. All four already exited 2, because `classifyExitCode` sniffs the literal string
  `invalid argument`, but the JSON envelope reported `"code": "GENERIC"` with the generic
  `nextAction`. The envelope now carries `BAD_INPUT`, and the plain-text message is prefixed
  `BAD_INPUT:` like the other argument failures.
- `bench --scenario` reports a missing file, malformed JSON, and a file with no `scenarios[]` array as
  `BAD_INPUT`, exiting 2 instead of 1.
- The remaining CLI argument guards throw `BAD_INPUT` too, so they exit 2 instead of 1:
  `--datetime-format`, `--hint`, `--connector-ref`, `--kv`, `--keep`, `datasource import` without
  `--file`, `config restore` without a selector, `grpc describe` without `--proto-root`/`--datasource`,
  `connector` without a name, and `completion` for an unsupported shell.

## [0.23.0]

### Changed

- `redis` credentials are reported as optional rather than required. The setup chain still offers a
  `creds set` step, now marked conditional on the server having AUTH enabled, and `credentialsCheck`
  says the same thing instead of flatly reporting credentials as not required.

### Fixed

- `doctor` no longer writes `datasources.json` or seeds credentials. A diagnostic that resolves
  `--env/--service` to no stored profile now reports the missing profile and points at
  `init datasource` or `datasource add`, exiting 7.

## [0.22.0]

### Fixed

- `learn prune` drops catalog rows with an unparseable timestamp instead of keeping them. The other
  four learning files already dropped them, so the catalog was the only one that grew without bound
  when a row carried a bad date.
- `learn clear` and `cache clear --kind all` remove the runs ledger. The ledger is nested inside the
  learning directory, so it survived both.

## [0.21.0]

### Changed

- `--explain` queries run through the daemon instead of forcing the direct path. The EXPLAIN wrap
  lives in the shared execution module, so both paths produce the same envelope.
- `--json-extract` queries run through the daemon instead of forcing the direct path. The extraction
  lives in the shared execution module, so both paths produce the same derived column.
- A malformed `--param` value fails as `BAD_INPUT` instead of `GENERIC`, so the exit code is 2 rather
  than 1. Callers that branch on exit code 1 for this failure need updating.

### Fixed

- A malformed `--json-extract` spec returns a `BAD_INPUT` failure instead of throwing out of the
  execution module. The exit code was already 2; run artifacts and the ledger are untouched either
  way.
- `--explain` without `--query` no longer points at `--card`/`--template`, which were removed.

## [0.20.0]

### Changed

- `query` runs one execution module on both the direct and daemon paths. The two pipelines had
  drifted, and the differences below were the result. See `docs/adr/0001-one-query-execution-module.md`.
- A malformed `--param` value now fails with an error on the daemon path. It was silently dropped
  before. The direct path already failed, so behaviour is now the same on both paths.
- Warnings are reported once per query through the daemon. They were appended twice, and the
  doubled list was persisted to the run summary.
- Warnings are printed on the terminal on the direct path. They were placed in the JSON payload
  only, so a partition scan warning was invisible when running without a daemon.
- The `resolved via=` line is printed on both paths. It was printed on the direct path only.
- Both paths resolve a datasource through the same resolver. A learning derived datasource resolved
  on the direct path and failed through the daemon.
- The query timeout is now a single budget across resolve, connect and execute. On the direct path
  each step previously got the full timeout, so a slow resolve could extend the total well past the
  requested value.
- Failed queries emit `meta.runId` and `meta.requestId` in the JSON error envelope.

### Removed

- The `_testHoldMs` request field and its `NODE_ENV` check. `startDaemon` accepts a
  `configurePlugins` hook instead, so tests inject a plugin rather than the daemon carrying a test
  branch in production code.
