# Context

TapRoot is a query orchestration CLI with a plugin runtime. It resolves a datasource, gates the
query against safety policy, executes it through a plugin, and records the run.

## Glossary

Terms below are the ones the query execution seam turns on. The wider vocabulary (datasource,
credential ref, connector, executor, capability, access method, KB, learning cache, schema catalog,
run artifacts, runs ledger, session, lease, envelope, readiness) is defined
across `references/`. Terms move here when a decision depends on the definition.

**Query execution request**
Flat plain data describing one query to execute: the target, the native query text, the safety
flags, the timeout, and an optional session id. It carries no application context, no commander
options and no reporter, so it can be built by any adapter and asserted in a test. Owned by
`src/core/execute-query.ts` as `QueryExecutionRequest`.

Distinct from `QueryRequest` in `src/types/core.ts`, which is the input one plugin receives for one
execute call and is published in `references/plugin-contract.md`. The two are different concepts and
do not share a name.

**Query outcome**
The result of one execution, as a union of success and failure rather than a value plus a thrown
error. Failure carries a classified code, a message, optional details and the same metadata success
carries, so a caller never re-parses an error message to learn what went wrong. Owned by
`src/core/execute-query.ts`.

**Adapter**
A thin caller that maps some transport into a query request and maps the outcome back out. There are
two: the CLI command, which maps commander flags and throws at the process edge, and the daemon
handler, which owns the lease and the session and writes the outcome onto its RPC response. An
adapter holds no pipeline logic. When a step appears in both adapters, it belongs in the module.

**Pipeline phase**
One named stage of execution: resolve, connect, execute. Each phase reports its duration, and the
durations reach the caller as `meta.phases`.

**Report**
The dependency through which the module emits progress and diagnostic lines through one `log` method, as data
rather than as terminal output. The CLI adapter writes it to stderr as JSON lines under `--verbose`. The daemon
passes a no op. Phase timings travel in `meta.phases` instead. It is required rather than optional so the module body has no conditional reporting.

## Decisions

Architectural decisions live in `docs/adr/`. `references/architecture-decisions.md` holds the
earlier v1 record.
