# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.20.0 are recorded in the git history only.

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
