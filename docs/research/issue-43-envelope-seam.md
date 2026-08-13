# Issue #43 dossier: one envelope seam for every plumbing invocation

Survey of the tree at `7ecd5fb`, produced 2026-08-13 by a read-only agent for issue #43. Every claim is cited to `file:line`. Claims from the issue that could not be verified are marked as such.

This is a snapshot, not a living document. It records what was true at `7ecd5fb` and is kept as a primary source for the design decision, so it is not updated as the code moves.

**Line-number drift since the survey.** `af8f3b6` (#50), `343e65b` (#51) and `332749a` (#52) landed afterwards. Of the files cited below, these changed: `src/commands/doctor.ts`, `src/commands/query.ts`, `src/core/app.ts`, `src/core/execute-query.ts`, `docs/adr/0001-one-query-execution-module.md`, `test/init.test.ts`, `test/query-parity.test.ts`, `test/execute-query.test.ts`. Line numbers in those files have moved; locate by symbol name instead. `src/core/output.ts`, `src/index.ts`, `src/commands/query-present.ts` and `skills/taproot/references/output.md`, which carry the load-bearing findings, are untouched.

---

## 0. Scoreboard on the issue's own numbers

| Issue claim | Verdict | Actual |
|---|---|---|
| Seven printers in `src/core/output.ts` | Verified | 7, at lines 57, 61, 116, 124, 128, 138, 142 |
| 90 references to `ctx.jsonMode` in `src/commands/` | Verified exactly | 90 occurrences, 21 files |
| Eleven families emit a bare payload | Verified with a caveat | 10 whole families + 1 subcommand (`daemon start`) |
| Sixteen families re-implement the envelope | **Not verified** | 18 top-level families call a printer, not 16 |
| `presentQueryOutcome` left query-local by ADR-0001 | Verified | `docs/adr/0001-one-query-execution-module.md:72-74` |

Two extra facts the issue does not mention, both load-bearing:

- `respondErr` (`src/core/output.ts:142`) has **zero call sites**. It is dead code. The error path
  runs through `printEnvelope` / `printJsonStderr` in `src/index.ts` instead.
- The published agent skill doc `skills/taproot/references/output.md:20-27` **documents the
  inconsistency as the contract**, path by path, per command. That file is the real blast radius,
  not `references/json-envelope-contract.md`.

---

## 1. Current surface: the seven printers

All seven live in `src/core/output.ts`. Call-site counts exclude import statements and exclude
in-module use. Total external call sites: **79 across 20 files**.

### `printJson(data: unknown): void` — `output.ts:57`

- Emits: whatever it is handed, `JSON.stringify(data, null, 2)` plus `\n`. No envelope of its own.
- Stream: **stdout** (`output.ts:58`).
- Call sites: **46 across 16 files**.

| File | Lines |
|---|---|
| `src/commands/config.ts` | 30, 42, 65, 88, 122, 138 |
| `src/commands/discover.ts` | 67, 84, 136, 166, 186, 199 |
| `src/commands/creds.ts` | 49, 60, 68, 78, 100 |
| `src/commands/learn.ts` | 27, 43, 66, 98, 145 |
| `src/commands/session.ts` | 29, 50, 66, 82, 96 |
| `src/commands/cache.ts` | 15, 33, 48 |
| `src/commands/daemon.ts` | 65, 89, 112 |
| `src/commands/kb.ts` | 31, 51, 61 |
| `src/commands/init.ts` | 37, 64 |
| `src/commands/self-check.ts` | 51, 64 |
| `src/commands/bench.ts` | 237 |
| `src/commands/connector.ts` | 127 |
| `src/commands/datasource.ts` | 271 |
| `src/commands/grpc.ts` | 145 |
| `src/commands/run.ts` | 75 |
| `src/commands/sanitize.ts` | 56 |

Also used internally by `printJsonPluck` (118, 121), `printEnvelope` (135), `respondOk` (139),
`respondErr` (148).

### `printJsonStderr(data: unknown): void` — `output.ts:61`

- Emits: same serialization, no envelope of its own.
- Stream: **stderr** (`output.ts:62`).
- Call sites: **1 in 1 file** — `src/index.ts:136`, reached only when `--json` and `--pluck` are both
  present on a failing invocation.

### `printJsonPluck(data: unknown, path?: string): void` — `output.ts:116`

- Emits: `data` unchanged when `path` is absent, else `pluckPath(data, path)`. Adds **no** envelope.
- Stream: stdout.
- Call sites: **17 across 6 files**.

| File | Lines |
|---|---|
| `src/commands/learn.ts` | 184, 201, 265, 271, 360, 425, 471 |
| `src/commands/kb.ts` | 86, 121, 147, 180, 225 |
| `src/commands/doctor.ts` | 411, 466 |
| `src/commands/query-present.ts` | 41 |
| `src/commands/bench.ts` | 236 |
| `src/commands/run.ts` | 62 |

Note `src/commands/run.ts:62` is **not gated on `ctx.jsonMode`**. `run show` prints JSON in human
mode too.

### `printEnvelopePluck(data: unknown, path?: string): void` — `output.ts:124`

- Emits: `{ ok: true, data }`. **No `meta` key at all.**
- Stream: stdout.
- Call sites: **3 in 1 file** — `src/commands/datasource.ts:69, 80, 270`.

### `printEnvelope(ok, data, error?, meta?): void` — `output.ts:128`

```ts
export function printEnvelope(
  ok: boolean,
  data: unknown,
  error?: CliOutputEnvelope['error'],
  meta?: CliOutputEnvelope['meta'],
): void
```

- Emits: `{ ok, data, error, meta }` in that key order. Undefined members are dropped by
  `JSON.stringify`, so the error call in `src/index.ts:170` produces literally `{"ok":false,
  "error":{...}}` with no `data` and **no `meta`**.
- Stream: stdout.
- Call sites: **8 across 2 files** — `src/commands/datasource.ts:107, 196, 208, 222, 247, 297`;
  `src/index.ts:139, 170`.

### `respondOk<T>(data: T, meta?: Record<string, unknown>): void` — `output.ts:138`

- Emits: `{ ok: true, data, meta: meta || {} }`. `meta` is **always present**, possibly `{}`. This is
  the only printer that guarantees a `meta` key.
- Stream: stdout.
- Call sites: **4 across 3 files** — `src/commands/kb.ts:214`, `src/commands/connector.ts:196`,
  `src/commands/grpc.ts:203, 221`.

### `respondErr(code, message, details?, meta?): void` — `output.ts:142`

- Emits: `{ ok: false, error: { code, message, details }, meta: meta || {} }`.
- Stream: stdout.
- Call sites: **zero**. Dead export. Nothing in `src/`, `test/`, or `docs/` references it.

### Envelope-shape census, by what an external parser actually sees

| Shape | Where |
|---|---|
| `{ok, data, meta}` full | `query` (`query-present.ts:40`), `session` x5 (`session.ts:29,50,66,82,96`), `daemon status`/`stop` (`daemon.ts:89,112`), `grpc describe` (`grpc.ts:145`) |
| `{ok, data, meta:{}}` via `respondOk` | `kb relations import` (`kb.ts:214`), `connector setup` (`connector.ts:196`), `grpc list`/`search` (`grpc.ts:203,221`) |
| `{ok, data}` no meta | `datasource list/show/export` (`datasource.ts:69,80,270`), `datasource add/remove/resolve/import` (`107,196,208,222,247,297`), `connector status` (`connector.ts:127`), `bench` (`bench.ts:223-237`) |
| `{ok, <payload fields as siblings>}` flat pseudo-envelope | `discover kb/kubectl/teleport` (`discover.ts:67,84,136,166,186,199`) |
| Bare payload, no `ok`, no `data` | the eleven in section 3 |
| `{ok:false, error, meta?}` | `src/index.ts:136` (stderr) and `:139, :170` (stdout) |

---

## 2. The gating: 90 references, four shapes

`grep -o 'ctx\.jsonMode' src/commands` returns exactly **90**. Distribution:

```
learn.ts 12   daemon.ts 10   kb.ts 9    datasource.ts 9   config.ts 6   discover.ts 6
doctor.ts 5   session.ts 5   creds.ts 5  cache.ts 3       grpc.ts 3     query.ts 3
query-direct.ts 3  init.ts 2  self-check.ts 2  connector.ts 2
bench.ts 1  run.ts 1  sanitize.ts 1  query-present.ts 1  query-daemon.ts 1
```

`ctx.jsonMode` appears **nowhere in `src/` outside `src/commands/`** (same grep over `src` also
returns 90). `src/index.ts:127` re-derives the flag independently as
`process.argv.includes('--json')`.

The 90 split into **four distinct shapes**, and only 73 of them are output selection:

**Shape A — one-line ternary-free output switch (the bulk, ~50 sites).**
```ts
if (ctx.jsonMode) printJson({ cacheDir: ctx.paths.cacheDir, files, learning });
else {
```
`src/commands/cache.ts:15`

**Shape B — block form with an inline payload literal and an early `return` (~23 sites).**
```ts
      if (ctx.jsonMode) {
        printJsonPluck({
          datasource: datasource.name,
          plugin: plugin.manifest.name,
          warnings,
          checks,
          nextActionDetails,
          summary: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
        }, opts.pluck ? String(opts.pluck) : undefined);
      } else {
```
`src/commands/doctor.ts:465-474`

**Shape C — progress/animation suppression, not output (14 sites).**
```ts
      enabled: !ctx.jsonMode && !ctx.verbose,
      ...
      plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
```
`src/commands/daemon.ts:42,46` (repeated at `101,105`, `130,134`; `doctor.ts:356,360`;
`query.ts:71,75`)

**Shape D — capability gating, not output (3 sites).**
```ts
  const canPrompt = !ctx.jsonMode && process.stdin.isTTY && !process.env.CI;
```
`src/commands/query-direct.ts:43`; also `query-direct.ts:24,31`, `query-daemon.ts:22`,
`doctor.ts:363`, `query.ts:107` (discovery prompt suppression).

**Counts:** 73 sites are output selection (A + B). 17 are not (C: `daemon.ts:31,42,46,101,105,130,134`,
`doctor.ts:356,360,363`, `query.ts:71,75`; D: `query-direct.ts:24,31,43`, `query.ts:107`,
`query-daemon.ts:22`). A `respond(ctx, result)` seam absorbs the 73 and touches none of the 17.
`daemon.ts:31` is a fifth micro-shape: `if (ctx.jsonMode) return false;` inside
`shouldPrintPlainSuccess`.

---

## 3. The bare-payload families

Ten whole families plus one subcommand of `daemon` emit a payload with **no `ok`, no `data`, no
`meta`**. An external consumer sees the payload object itself at the JSON root.

| # | Family | Emitting lines | One example verbatim | What a consumer sees at root |
|---|---|---|---|---|
| 1 | `init`, `init datasource` | `init.ts:37, 64` | `if (ctx.jsonMode) printJson(data);` (`init.ts:37`) | `{checks, readiness, nextActionDetails}` / `{source, skipped, profile, credentialRefs, connectors, warnings}` |
| 2 | `self-check` (both branches) | `self-check.ts:51, 64` | `if (ctx.jsonMode) printJson(data);` (`self-check.ts:51`) | `{readiness, missing?, nextCommand?, nextActionDetails, checks, target?}` |
| 3 | `doctor` | `doctor.ts:411, 466` | `printJsonPluck({ datasource: datasource.name, plugin: plugin.manifest.name, warnings, checks, nextActionDetails, summary: {...} }, ...)` (`doctor.ts:466-473`) | `{datasource, plugin, warnings, checks, nextActionDetails, summary}` |
| 4 | `kb` (all subcommands except `relations import`) | `kb.ts:31, 51, 61, 86, 121, 147, 180, 225` | `if (ctx.jsonMode) printJson(rows);` (`kb.ts:51`) | a bare object, or a bare array for `tables` / `list-services` / `related` |
| 5 | `learn` (every subcommand) | `learn.ts:27, 43, 66, 98, 145, 184, 201, 265, 271, 360, 425, 471` | `if (ctx.jsonMode) printJson(status);` (`learn.ts:27`) | `{latest, files:{...}}`, `{tables, joins, ...}`, `{candidates, promoted}`, ... |
| 6 | `cache show/prune/clear` | `cache.ts:15, 33, 48` | `if (ctx.jsonMode) printJson({ cacheDir: ctx.paths.cacheDir, files, learning });` (`cache.ts:15`) | `{cacheDir, files, learning}` |
| 7 | `creds set/show/list/unset/migrate-to-fallback` | `creds.ts:49, 60, 68, 78, 100` | `if (ctx.jsonMode) printJson({ ref: opts.ref, values: redacted });` (`creds.ts:60`) | `{ref, values}`; `creds list` emits a bare **array** |
| 8 | `config snapshot/list/status/diff/restore/prune` | `config.ts:30, 42, 65, 88, 122, 138` | `if (ctx.jsonMode) printJson({ snapshot: summary });` (`config.ts:30`) | `{snapshot}`, `{head, drifted, snapshots}`, the raw `report`, the raw `result` |
| 9 | `run show`, `run list` | `run.ts:62, 75` | `printJsonPluck(summary, pluck);` (`run.ts:62`) | the persisted `summary.json` object as-is; a bare array for `list` |
| 10 | `sanitize check-repo` | `sanitize.ts:56` | `if (ctx.jsonMode) printJson({ findings, count: findings.length });` (`sanitize.ts:56`) | `{findings, count}` |
| 11 | `daemon start` only | `daemon.ts:65` | `if (ctx.jsonMode) printJson({ started: true, status: res.data });` (`daemon.ts:65`) | `{started, status}` — while `daemon status`/`stop` in the same file emit a full envelope |

A twelfth case sits between bare and enveloped: `discover` emits `ok` as a **sibling** of the payload
fields rather than a wrapper.

```ts
          printJson({ ok: true, source: 'kb', applied: false, proposals, skipped });
```
`src/commands/discover.ts:67`

Its failure form is worse: `error` is a plain string, not `{code, message, details}`.

```ts
        if (ctx.jsonMode) printJson({ ok: false, source: 'kubectl', error: fetched.detail });
```
`src/commands/discover.ts:136` (same at `:166`), with `process.exitCode = 1` at `:138`.

---

## 4. Blast radius

### 4a. Docs promise things the code does not do

| # | Doc promise | Code reality | Severity |
|---|---|---|---|
| 1 | `references/porcelain-plumbing-contract.md:13` — "`--json` (or `TAPROOT_JSON=1`) switches a command into plumbing mode" | `TAPROOT_JSON` appears **nowhere** in `src/`. Only `--json` works (`src/index.ts:77`, `src/index.ts:127`). The string exists in exactly one place in the repo: that doc line. | Documented feature does not exist |
| 2 | `porcelain-plumbing-contract.md:19` and `json-envelope-contract.md:9-22` — "Stable envelope shape (`ok`, `data`, `meta`, `error`)" for every **L** command | 10 families plus `daemon start` emit none of the four keys (section 3). `datasource`, `connector status`, `bench` emit `ok`+`data` with no `meta`. | The central promise is false for the majority of L commands |
| 3 | `porcelain-plumbing-contract.md:55` — `creds set/show/list/unset/migrate-to-fallback` marked `P | —`, i.e. **no plumbing mode** | All five implement `--json` (`creds.ts:49, 60, 68, 78, 100`), and two tests pin that output (`test/output-mode.test.ts:86-90`, `test/creds-lifecycle.test.ts:50-52`) | Doc says a surface does not exist; it exists and is tested |
| 4 | `porcelain-plumbing-contract.md:55` — "credential material never returned in plumbing JSON" | `creds show --json` returns every non-`password`, non-`token` key in the clear, including `user` and connector command strings (`creds.ts:57-60`). `test/output-mode.test.ts:89` asserts `parsed.values.user === 'qa_user'`. | Partially false, and the test locks it in |
| 5 | `json-envelope-contract.md:57` — "Human mode: no raw JSON blobs by default" | `datasource export` prints raw JSON in the **human** branch (`datasource.ts:271` `else printJson(all);`). `run show` prints JSON in both modes because it never checks `ctx.jsonMode` (`run.ts:62`). | Two live violations |
| 6 | `porcelain-plumbing-contract.md:49` — `doctor` is `L+pluck`; `:21` says pluck "projects a subtree of **the envelope**" | `doctor`'s payload has no envelope, so `--pluck data.checks` returns `undefined`. The working path is `--pluck checks`. Same for `kb`, `learn`, `run`. | Pluck path semantics differ per command |
| 7 | `porcelain-plumbing-contract.md:20` — "Stable exit code taxonomy: `0` success, non-zero failure with `error.code` set" | `discover kubectl` fails with `exitCode = 1` and `error` as a **string**, no `error.code` (`discover.ts:136-138`). `sanitize` exits 1 with a payload that has no `ok` and no `error` (`sanitize.ts:56-58`). `doctor` sets `exitCodeForClass(...)` with a bare payload (`doctor.ts:424`). `self-check` sets `EXIT_CODES.NOT_READY` with a bare payload (`self-check.ts:59`). | Exit code and envelope are wholly decoupled today |
| 8 | `porcelain-plumbing-contract.md:96-103` — "For every command listed with **L**: one success-shape test and one failure-shape test" | See 4c. Roughly half the L commands have no output test at all, and no L command except `query` has both a success-shape and a failure-shape assertion. | Stated coverage target is not met |
| 9 | `porcelain-plumbing-contract.md:44-63` command matrix lists `template run` / `onboard` | No `template` or `onboard` command is registered in `src/index.ts:84-102`. `onboard` appears in the matrix at `:61`. | Matrix lists a command that does not exist |
| 10 | `porcelain-plumbing-contract.md:23` — "`meta.requestId` is included for any command that goes through the daemon" | True for `query`, `session`, `daemon status`/`stop`. **`bench` routes through the daemon** (`skills/taproot/references/output.md:41`) and emits `{ok, data}` with no `meta` at all (`bench.ts:223-233`). | One counter-example |

### 4b. The doc that will actually break agents

`skills/taproot/references/output.md` is the shipped skill reference. It does not describe the ideal
contract; it describes the current mess, path by path, and agents are instructed to follow it.

- `:5` asserts "Stable envelope shape: `{ ok, data, meta, error }`" as a blanket statement. False per 4a#2.
- `:20-27` is an explicit per-command pluck-path table. Every line of it is a hard dependency on the
  current heterogeneity:
  - `:23` `learn ensure-schema ... --pluck tables`, **NOT** `meta.schemaContext.tables` — explicitly
    tells agents the bare shape.
  - `:24` `learn tables ... --pluck rows`, `learn joins ... --pluck rows`.
  - `:25` `datasource ... wrap output in {ok,data}, so paths need the data. prefix`.
  - `:22` `query ... --pluck data.rows`.

  A `respond()` seam that wraps everything invalidates `:23` and `:24` outright and makes `:25`
  the universal rule. That file must change in the same PR.
- `:21` and `README.md:290-292` both pin the `--pluck` failure routing: error envelope to **stderr**,
  empty stdout, non-zero exit. This behaviour is implemented in `src/index.ts:135-138` and pinned by
  `test/query-pluck-failure.test.ts:44-56`. It is currently a **global** behaviour keyed on
  `process.argv` containing `--pluck`, not on whether the command supports pluck.

### 4c. Test coverage: what is pinned, and to which shape

Output-shape tests are subprocess tests against `dist/index.js`. Issue #17 (closed) asked for exactly
this; the delivered coverage is `test/output-mode.test.ts` (4 assertions) plus scattered assertions in
command-specific suites. `test/output-format.test.ts` is **not** an output-contract test; it covers
`renderTable` / `renderTableSmart` string formatting only.

**Pinned to the BARE shape (these tests break if `respond()` wraps them):**

| Command | Test citations |
|---|---|
| `self-check` / `self-check --agent` | `test/cli-contract.test.ts:99`; `test/init.test.ts:469-472, 515-527, 575-584, 632-634, 646-647`; `test/datasource-improvements.test.ts:56, 65` |
| `init`, `init datasource` | `test/init.test.ts:104-107, 125-126, 160, 180, 213, 229, 244-248, 267-269, 309-311, 352-353, 416-421` |
| `kb resolve-connection/-credentials/-database-name`, `kb tables`, `kb related`, `kb list-services` | `test/kb-resolution.test.ts:117, 124, 131, 138, 146, 173, 181, 188, 198, 205, 231`; `test/cli-contract.test.ts:171`; `test/runtime-policy-cache.test.ts:97` |
| `learn tables`, `learn schema` | `test/learn-empty-state.test.ts:45, 81, 132, 173` |
| `learn status` | `test/runtime-policy-cache.test.ts:73` |
| `learn replay` | `test/learn-replay.test.ts:42-46` |
| `cache show` | `test/runtime-policy-cache.test.ts:60` |
| `creds show` | `test/output-mode.test.ts:88-90`; `test/creds-lifecycle.test.ts:52`; `test/init.test.ts:433` |
| `creds list` | `test/creds-lifecycle.test.ts:95-96` |
| `config snapshot/status/restore/list/diff` | `test/config-snapshots.test.ts:35, 44, 55, 70, 72, 83` |
| `doctor` | `test/doctor-executor-codes.test.ts:51-60, 98-103, 138-144, 185-192`; `test/connector-ux.test.ts:127-132, 160-161` |

The sharpest single line: `test/output-mode.test.ts:89` reads `parsed.values.user`. The file is named
"output mode contract" and it pins the **absence** of an envelope.

**Pinned to the ENVELOPE shape (these constrain what `respond()` may emit):**

| Command | Test citations | Notes |
|---|---|---|
| `datasource show/list/resolve/export/import` | `test/datasource-crud.test.ts:77, 85, 117, 135, 170, 200, 234, 244`; `test/datasource-improvements.test.ts:79, 89` | `.data` only, never `.meta` |
| `daemon status` | `test/agent-contract.test.ts:57-60` | zod `successEnvelopeSchema` (`:34-38`) requires `meta.requestId` non-empty |
| `session open`, `session ls` | `test/agent-contract.test.ts:76-82` | same zod schema |
| `query` success | `test/query-present.test.ts:66-71`; `test/query-parity.test.ts:111-151, 193-194` | in-process, asserts `ok`, `data.columns`, `meta.requestId`, `meta.runId` |
| `query` failure | `test/agent-contract.test.ts:104-106, 129-131`; `test/query-pluck-failure.test.ts:54, 67` | zod `errorEnvelopeSchema` (`:40-48`); stderr routing under `--pluck` |
| `connector setup`, `connector status` | `test/connector-ux.test.ts:69-71, 94-96` | asserts `ok` and `data`, not `meta` |

**Not pinned at all (no `--json` output assertion anywhere in `test/`):**

`bench`; `discover kb/kubectl/teleport` (`test/discover.test.ts` has zero `--json`);
`grpc describe/list/search` (`test/grpc-introspect.test.ts` is a unit test of the core module);
`run show`, `run list`; `sanitize check-repo` (`test/sanitize.test.ts` has zero `--json`);
`daemon start`, `daemon stop`; `session inspect/close/close-all`; `cache prune`, `cache clear`;
`learn compact/joins/ensure-schema/refresh-schema/relations`; `kb relations import`;
`creds set/unset/migrate-to-fallback`; `config prune`; `datasource add/remove`.

That is more than half the plumbing surface with no regression net. A `respond()` rewrite would land
on it blind.

---

## 5. Interaction with ADR-0001

ADR-0001 (`docs/adr/0001-one-query-execution-module.md`, accepted 2026-08-11) drew the boundary at
`:72-74`:

> "a query local `presentQueryOutcome(outcome, ctx, opts)` replaces the two renderers. The broader
> single envelope seam across all command families is a separate change and is not attempted here."

and closes at `:171` with the cost admission: "Rendering duplication is reduced but not eliminated
across the wider CLI."

### What `presentQueryOutcome` does today

`src/commands/query-present.ts:25-68`. Signature takes a single object:
`{ outcome: QueryOutcome; ctx: AppContext; opts: PresentOptions; progress: ProgressReporter; requestId: string }`.
Returns `void`. Eight responsibilities, in order:

1. **Failure conversion by throwing** (`:33-36`). On `!outcome.ok` it calls `progress.fail(...)` then
   `throw queryFailureError({...outcome, meta: {...outcome.meta, requestId}})`. It never prints an
   error itself. The throw unwinds to `program.parseAsync(...).catch` → `emitError`
   (`src/index.ts:158-177`) which does the actual error rendering and stream choice. This is the only
   printer path in the repo that renders success and delegates failure.
2. **Error message prefixing** (`queryFailureError`, `:15-23`): prepends `CODE: ` unless the message
   already starts with it, then hangs `details` and `meta` off the `Error` object so `emitError` can
   read them at `src/index.ts:129, 134`.
3. **`requestId` injection into `meta`** (`:35, :40`) on both the failure and the success path.
4. **Envelope trimming** (`:40`): `trimQueryJsonEnvelope` (`output.ts:94-114`) deletes empty
   `data.queryMemory`, empty `data.warnings`, empty `meta.queryMemory`, and an all-empty
   `meta.schemaContext`. Query-specific key knowledge, not generic.
5. **Envelope construction and pluck** (`:40-42`): `{ok: true, data, meta}` then `printJsonPluck`.
6. **Progress terminal state on success** (`:51`): `progress.succeed(...)` with row count, duration,
   and an optional `--verbose` phase split from `meta.phases`.
7. **Warning surfacing** (`:52`) via `progress.warn` — this is the ADR-0001 behaviour change #4
   ("warnings render on TTY on both paths", `:86`).
8. **Human rendering** (`:54-67`): the `resolved via=` line (ADR change #5, `:87`), `rowToObject`
   projection unless `--rows-object`, `renderTableSmart`, `renderSchemaContextFooter`,
   `renderQueryMemoryTty`.

### What absorbing it would mean

Six things a generic `respond(ctx, result)` would have to grow, each of which is currently
query-only:

1. **A failure mode that throws rather than prints.** Every other printer prints its own payload.
   Either `respond()` gains an escape hatch that throws to `emitError`, or the query path stops
   throwing and `emitError` loses the only caller that supplies `details` and `meta` on the `Error`.
   The second option touches `src/index.ts:129-140`, which is the shared error path for all 19
   families.
2. **A trim hook.** `trimQueryJsonEnvelope` knows `queryMemory`, `warnings`, `schemaContext`. Either
   it becomes a generic "drop empty" rule applied to every command (behaviour change for
   `learn`, `doctor`, `kb`, which currently emit empty arrays), or `respond()` takes a per-command
   trimmer and is no longer one seam.
3. **A progress handle.** `presentQueryOutcome` owns `progress.succeed/warn/fail`. `respond(ctx,
   result)` as written in the issue has no `progress` parameter. Three other families
   (`daemon`, `doctor`, `query`) pass a `ProgressReporter` around for the same reason.
4. **A human renderer per command.** Steps 6-8 are entirely query-shaped. Either `respond()` takes a
   render callback, at which point the "one seam" is one JSON seam plus 19 render callbacks, or human
   mode stays outside it and the `ctx.jsonMode` branch survives at every call site — which is the
   thing the issue set out to delete.
5. **`requestId` provenance.** Query gets it from the caller. `session`/`daemon` read it off the RPC
   response (`session.ts:32`, `daemon.ts:92`). Everything else has none. `respond()` must decide
   whether it mints one, threads one, or omits the key.
6. **The `rowsForm` / `--rows-object` contract.** Pinned in `test/query-parity.test.ts:114` and
   documented at `skills/taproot/references/output.md:10`. It lives inside step 8.

ADR-0001's stated reason for deferring holds: the seam is orthogonal to execution, and the parity
test (`test/query-parity.test.ts`) asserts envelope equality between adapters **below**
`presentQueryOutcome`, so it does not protect a rendering change.

---

## 6. Open questions for the designer

Ranked by rework cost if answered wrong. I am not answering these.

### 1. Do the eleven bare-payload families get wrapped, or does `respond()` learn to emit bare? **ONE-WAY DOOR.**

This is the whole issue. Wrapping changes the JSON root for `init`, `self-check`, `doctor`, `kb`,
`learn`, `cache`, `creds`, `config`, `run`, `sanitize`, `daemon start` — every documented pluck path
in `skills/taproot/references/output.md:20-27` moves, and roughly 60 existing test assertions
(section 4c) break. Not wrapping means `respond()` owns a per-command shape flag and stops being one
seam. Once shipped either way, external agent prompts and saved pluck paths are written against it.
Nothing else on this list costs more to reverse.

### 2. Does `respond()` own the exit code? **ONE-WAY DOOR** for the taxonomy.

Today `ok` and exit code are independent. `sanitize` exits 1 with no `ok` field (`sanitize.ts:56-58`).
`doctor` exits via `exitCodeForClass` with no `ok` field (`doctor.ts:424`). `self-check` exits
`NOT_READY` with no `ok` field (`self-check.ts:59`). `bench` exits 1 **with** `ok:false`
(`bench.ts:224, 238`). `discover` exits 1 with `ok:false` and a string `error` (`discover.ts:136-138`).
If `respond()` derives the exit code from `ok`, four commands change their exit code. If it does not,
`porcelain-plumbing-contract.md:20` stays false.

### 3. Is `meta` mandatory, and where does `requestId` come from when there is no daemon?

Three current behaviours: always `{}` (`respondOk`), absent entirely (`printEnvelopePluck`,
`printEnvelope` on the error path), or fully populated (`query`, `session`, `daemon`). The zod schema
at `test/agent-contract.test.ts:27-38` requires `meta.requestId` to be a non-empty string on
success. A universal `meta` means minting a request id for `cache clear`. An optional `meta` means the
contract doc's shared-envelope block (`json-envelope-contract.md:11-22`) needs a caveat.

### 4. Does `presentQueryOutcome` keep throwing on failure, or start printing?

Section 5 item 1. If it starts printing, `emitError` (`src/index.ts:121-146`) loses its only source of
`error.details` and `error.meta`, and `test/agent-contract.test.ts:131` (`error.details.nextAction`)
plus `test/query-pluck-failure.test.ts:53-55` are the tests that will catch it. If it keeps throwing,
`respond()` has a success-only signature and the issue's "owns error routing" claim shrinks.

### 5. Does the `--pluck` stderr rule generalise, and does it stay keyed on `process.argv`?

Documented twice (`README.md:290-292`, `skills/taproot/references/output.md:21`) and pinned once
(`test/query-pluck-failure.test.ts:44-56`). Implemented globally at `src/index.ts:135-138` by
scanning `process.argv` for `--pluck`, which fires even for commands that do not declare the flag. If
`respond()` owns stdout/stderr routing, this argv scan should move inside it, and the rule must be
stated for the nine commands that accept `--pluck` versus the ten that do not.

### 6. Does `discover`'s flat `{ok, source, applied, ...}` become `{ok, data:{source, applied, ...}}`?

Six call sites (`discover.ts:67, 84, 136, 166, 186, 199`). Zero tests pin it (`test/discover.test.ts`
has no `--json`). Cheapest of the eleven-ish to change, and its failure form (`error` as a bare
string, `:136`) is the single clearest contract violation in the tree.

### 7. Is `respondErr` deleted in this change or kept as the seam's implementation?

Zero call sites today (`src/core/output.ts:142`). Keeping it because "the seven printers become its
implementation" preserves dead code inside the new module. Cheap either way, but worth deciding
explicitly so it does not survive by accident.

### 8. Does the `trimQueryJsonEnvelope` empty-drop rule become universal?

`output.ts:94-114`, pinned by `test/trim-query-envelope.test.ts`. Applying it to every command changes
`learn`, `doctor`, and `kb` payloads (empty arrays start disappearing). Not applying it means
`respond()` carries a query-specific branch on day one.

### 9. Does `TAPROOT_JSON=1` get implemented or removed from the doc?

`references/porcelain-plumbing-contract.md:13` promises it; no code reads it. Either way it is a
one-line change, but it must be decided in the same PR, because a `respond()` seam is the natural
place for mode detection to live and `src/index.ts:127` currently re-derives the mode from
`process.argv` independently of `ctx.jsonMode` (`src/index.ts:77`). That double source of truth is a
latent bug regardless of the outcome.

### 10. Do `run show` and `datasource export` stop emitting JSON in human mode?

`run.ts:62` never checks `ctx.jsonMode`; `datasource.ts:271` deliberately prints JSON in the human
branch. Both violate `json-envelope-contract.md:57`. A `respond()` seam forces the question. `run
show`'s human output has no table renderer to fall back to, so fixing it means designing one.

---

## Appendix: files a designer will need open

| Path | Why |
|---|---|
| `src/core/output.ts:57-149` | the seven printers |
| `src/index.ts:121-177` | the shared error path, `emitError`, the argv-based mode and pluck detection |
| `src/commands/query-present.ts:15-68` | `presentQueryOutcome`, the model for what a seam must do |
| `skills/taproot/references/output.md:20-27` | the shipped per-command pluck-path table, the real contract |
| `references/porcelain-plumbing-contract.md:36-63` | the command matrix, 3 known errors in it |
| `references/json-envelope-contract.md:9-57` | the frozen shape and the output-discipline rules |
| `test/output-mode.test.ts:86-91` | the test that pins the absence of an envelope |
| `test/agent-contract.test.ts:27-48` | the zod schemas, the only formal envelope definition in code |
| `test/query-pluck-failure.test.ts:44-56` | the stderr routing pin |
| `docs/adr/0001-one-query-execution-module.md:72-74, 171` | the deferral this issue reverses |
