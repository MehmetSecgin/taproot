# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.20.0 are recorded in the git history only.

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
