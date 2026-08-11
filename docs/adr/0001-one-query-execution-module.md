# ADR-0001: One query execution module behind one interface

Status: accepted
Date: 2026-08-11

## Context

The query pipeline is implemented twice. `src/commands/query-direct.ts` (381 lines) runs it in
process for the CLI. `src/daemon/handlers/query-execute.ts` (341 lines) runs it again inside the
daemon. `src/commands/query.ts` picks between them with a `forceDirect` predicate. Neither copy
shares an interface with the other, and both duplicate the same steps verbatim: safety gating, the
KB conflict gate, plugin parameter assembly, ledger success and failure writes, run artifacts,
resolved metadata, schema context merging, phase timings and envelope shaping.

The copies have drifted, and the drift has shipped:

- Warnings are appended twice on the daemon path, once at `query-execute.ts:267` and again at
  `:310`. A partitioned table yields one warning direct and two through the daemon, and the doubled
  list is persisted to `summary.json`.
- A malformed `--param` fails on the direct path and is silently dropped on the daemon path. A third
  copy of the parser, `parseQueryParams`, is dead code.
- The two paths use different resolvers. `resolveCanonicalDatasource` is a strict prefix of
  `resolveDatasourceWithFallbacks`, so a learning derived datasource resolves direct and fails
  through the daemon.
- Warnings render on TTY through the daemon and are invisible on TTY direct, where they are placed
  in the JSON payload only. The safety system is silent for the human it is warning.
- The `resolved via=` line prints on the direct path only.

No test injects an executing plugin into either path. Every query assertion is an error code or an
exit code, so the success envelope is unasserted on both paths and the drift is invisible to the
suite.

## Decision

Extract `executeQuery(request, deps)` into `src/core/execute-query.ts`. Both paths become thin
adapters over it.

**Inside the module**: datasource resolution, safety and KB gates, connector preflight, plugin
execution, ledger writes, run artifacts, learning store writes, envelope data shaping.

**Outside the module**: commander flag parsing, rendering, the queue limiter, session open, lease
acquisition and heartbeat.

**Contract**:

- `QueryRequest` is flat plain data. It carries no `AppContext`, no commander options and no
  reporter. It carries an optional `sessionId`.
- `QueryOutcome` is a union of `{ ok: true, data, meta }` and
  `{ ok: false, code, message, details, meta }`. The module returns failures rather than throwing,
  which removes the error class round trip through the message string that runs `classifyError` up
  to four times per failed daemon query.
- `QueryDeps` carries `ctx`, a required `report`, an optional `promptPassword` and an optional
  discovery hook. Capabilities the daemon lacks are expressed as absent dependencies, not as a mode
  flag branching inside the module.
- `report` is required with a no op implementation for the daemon, because it is called at every
  phase and an optional reporter would mean an optional call at each one. Phase events cross it as
  data, and the CLI adapter decides whether that becomes a spinner, a stderr line or nothing.
- `QueryEnv` is deleted. No forwarding constructor, no legacy field, no default. Every call site is
  updated in the same change.

**Resolution**: `resolveDatasourceWithFallbacks` is the only resolver. `resolveCanonicalDatasource`
is deleted. The daemon inherits the store lookup and the learning branch, which is already gated on
`(!deterministicRequired || allowDiscovery)`, and it inherits the profile write that resolution
performs. The write is idempotent for a given env and service, so concurrent daemon requests do not
need extra protection.

**Session identity**: `sessionId` travels as a field on `QueryRequest` and is threaded into the
credential object inside the module, exactly as the daemon does today. The `__sessionId` channel
between the daemon and the teleport-mysql plugin is preserved unchanged. Promoting it to a real
field on the plugin execute input changes the published plugin contract and belongs in its own ADR.

**Rendering**: a query local `presentQueryOutcome(outcome, ctx, opts)` replaces the two renderers.
The broader single envelope seam across all command families is a separate change and is not
attempted here.

## Behaviour changes

The direct path wins every divergence:

1. Warnings are appended once through the daemon.
2. A malformed `--param` fails on both paths. It classifies as `GENERIC` (exit 1), not `BAD_INPUT`,
   because the parser's message carries no `bad_input:` prefix for `classifyError` to match. The
   architecture review claimed `BAD_INPUT`; a live check against a QA datasource showed otherwise.
   Correcting the class changes an exit code, so it is left for a separate change.
3. Both paths resolve through the same resolver.
4. Warnings render on TTY on both paths.
5. The `resolved via=` line prints on both paths.

Change 2 is visible to callers who relied on the daemon dropping bad pairs. It ships in 0.20.0 with
a `CHANGELOG.md` entry.

## Scope boundaries

- `forceDirect` is unchanged. `--explain` and `--json-extract` become ordinary request fields, which
  makes two of its four conditions removable, but removing them routes traffic to a path that has
  never served it. Each condition is removed in its own later change with its own test.
- The existing subprocess tests stay. They are the only regression net over this pipeline, and
  removing them in the change that rewrites it would remove the evidence that the rewrite is safe.

## Deletions

`parseQueryParams` (unreferenced), `resolveCanonicalDatasource`, `QueryEnv`, and the `_testHoldMs`
request field with its `NODE_ENV` check. The hold that field provided comes from the injected test
plugin instead.

## Verification

A fake plugin registered into `pluginRegistry` gives the first in process test of a successful
query. One table driven parity test runs the same `QueryRequest` through both adapters and asserts
the envelopes match.

Before merge, the same query runs twice against one QA datasource, once with `TAPROOT_FORCE_DIRECT=1`
and once through the daemon, against a table with RANGE or HASH partitioning, with the envelopes
compared through `--pluck data`. The fake plugin cannot cover real credentials and real network, and
all four builtin plugins sit behind the same execute call.

## Departures found during implementation

Three decisions above did not survive contact with the code. They are recorded here rather than
edited into the text above, so the reasoning stays visible.

**Session identity is a callback, not only a request field.** The decision was that `sessionId`
travels as a field on the request. It cannot be only that: the daemon opens its session from the
resolved datasource (name, kind, connection, connectors), and resolution now happens inside the
module. Passing a session id in would have meant either resolving twice or degrading the session
registry to partial data. `QueryDeps` therefore carries an optional
`openSession(datasource) => string`, called once the datasource is known, and the module uses the id
it returns. The request field remains for callers that already have an id.

**The request type is `QueryExecutionRequest`, not `QueryRequest`.** `src/types/core.ts` already
exports `QueryRequest` as the input to one plugin execute call, and that name is published in
`references/plugin-contract.md`. Two different concepts under one name is what `CONTEXT.md` exists
to prevent, and the published one cannot move in this change.

**The timeout became a single budget.** Not discussed beforehand. The direct path gave resolve,
connect and execute a full timeout each, so a slow resolve could push the total well past the
requested value. The daemon computed a remaining budget for execute, and its `AbortController` only
ever gated the queue wait, so dropping the remaining-budget calculation would have removed the
daemon's only real total-time guarantee. The module now sets one deadline at entry and every timed
step draws from it. This makes the direct path stricter than before and is listed in the changelog.

## Consequences

Good:

- The safety gate, the ledger write and the envelope shape each exist once.
- Parity becomes a single test instead of a property nobody checks.
- The success envelope gains its first assertions.
- `query-types.ts` shrinks to the commander option type and stays out of `core`.

Costs:

- One large change, roughly 1,000 lines across 8 files, mostly deletion and movement. A stacked
  split was rejected because the parity test cannot pass until both adapters cross the seam, so the
  intermediate commit would hold three copies of the pipeline instead of two.
- The daemon inherits a resolver that writes a datasource profile during resolution.
- Rendering duplication is reduced but not eliminated across the wider CLI.
