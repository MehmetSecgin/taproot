# Issue #46 dossier: carry `accessMethod`, or delete the unread manifest fields

Survey of the tree at `7ecd5fb`, produced 2026-08-13 by a read-only agent for issue #46. Every claim is cited to `file:line`.

This is a snapshot, not a living document. It records what was true at `7ecd5fb` and is kept as a primary source for the Option A / Option B decision, so it is not updated as the code moves.

**Line-number drift since the survey.** `af8f3b6` (#50), `343e65b` (#51) and `332749a` (#52) landed afterwards. Of the files cited below, these changed: `src/commands/doctor.ts` (+86 lines), `src/core/readiness.ts`, `src/core/execute-query.ts`, `src/core/app.ts`, `test/init.test.ts`, `test/doctor-bootstrap.test.ts`, `test/query-resolution.test.ts`. Line numbers in those two heavily cited files have moved substantially; locate by symbol name instead.

**One finding partly superseded.** `332749a` (#52) added a third state, `AUTH_OPTIONAL_KINDS`, alongside the two sets discussed in D2. The `teleport-postgres` observation in D2 still stands: that string still has no producer anywhere in the tree.

---

## 1. Where access method dies

`accessMethod` is never a field on a datasource. It exists only as a KB record key (`access_method`) and as a plugin manifest array (`accessMethods`).

| Step | Location | What happens |
| --- | --- | --- |
| Defined | `src/types/core.ts:22-27` | `AccessMethod` const: `native`, `qa-portforward`, `tsh` |
| Read from KB | `src/core/bootstrap.ts:201` | `const accessMethod = str(kb.access_method).toLowerCase();` |
| Used to pick a builder | `src/core/bootstrap.ts:202` | `BOOTSTRAP_STRATEGIES.find((s) => s.accessMethod === accessMethod)` |
| Discarded | `src/core/bootstrap.ts:101-126`, `:134-149`, `:159-179` | All three builders return a `profile` object. None writes the access method onto it. |
| Not in the type | `src/types/core.ts:66-86` | `DatasourceProfile` has `kind`, `connection`, `connectors`, `resolverHints`. No access method field. |
| Not in the schema | `src/store/schemas.ts:9-28` | `DatasourceProfileSchema` has no such key. Zod strips unknown keys, so an ad-hoc field added at a call site would be silently dropped on every `DatasourceStore.list()` (`src/store/datasources.ts:10-13`). |
| Not a CLI flag | `src/commands/datasource.ts:112-131` | `datasource add` has `--kind`, `--host`, `--port`, `--target`, `--connector`. No `--access-method`. |
| Not in the learning store | `src/store/learning-types.ts:3-18` | `ResolutionEntry` mirrors the profile fields and also omits it. |

The death point is one line: `src/core/bootstrap.ts:202`. After that `find`, the access method is a local variable inside `buildKbBootstrapCandidate` and reaches the persisted profile only as three indirect encodings:

- `kind`: `teleport-mysql` for tsh (`bootstrap.ts:163`), `mysql`/`postgres` otherwise (`bootstrap.ts:105`, `:137`).
- `connectors[]`: `['openvpn','kubectl-portforward']` for qa-portforward (`bootstrap.ts:112`), `['openvpn','teleport']` for tsh (`bootstrap.ts:170`), `['openvpn']` for native (`bootstrap.ts:144`).
- `connection.host === '127.0.0.1'` plus port 4406 for qa-portforward (`bootstrap.ts:96`, `:110`).

Those three encodings are what the rest of the codebase decodes back.

---

## 2. Where it is guessed back

The issue says four modules. I found **five** sites that re-derive routing after the profile has lost it. I list all five rather than force a count of four.

### Site 1: `src/core/execute-query.ts:399` (KB re-read, per query)

```ts
accessMethod: str(ctx.kbStore.resolveConnection(request.service, request.env, request.namespace || undefined)?.access_method),
```

Not a name or port heuristic. It is a second KB lookup on every successful query, purely to fill the `resolved.accessMethod` output field (`src/types/core.ts:163`).

**When it is wrong**: a datasource created by `taproot datasource add` (`src/commands/datasource.ts:112`) or by `taproot discover` (`src/core/discover-datasources.ts:262-278`) has no KB row. `resolveConnection` returns undefined, `str(undefined)` returns `''`, and the field is emitted as an empty string. `skills/taproot/references/workflows.md:273` tells agents to read `resolved.accessMethod` first. No test asserts this field (grep of `test/` for `accessMethod` returns zero hits; every `access_method` hit is a KB fixture).

### Site 2: `src/core/conflicts.ts:4-10` and `:32-56` (KB re-read plus a host literal)

```ts
export function expectedKindFromKb(kb: Record<string, unknown>): DatasourceKind {
  const accessMethod = str(kb.access_method).toLowerCase();
  const engine = String(kb.engine || DatasourceKind.Mysql).toLowerCase();
  if (accessMethod === AccessMethod.Tsh) return DatasourceKind.TeleportMysql;
  if (engine.includes('postgres')) return DatasourceKind.Postgres;
  return DatasourceKind.Mysql;
}
```

and the host literal at `src/core/conflicts.ts:51`:

```ts
if (host && host !== '127.0.0.1' && host !== 'localhost') critical.push(...conflicts.filter((c) => c.startsWith('host=')));
```

**When it is wrong**: `expectedKindFromKb` maps tsh to `teleport-mysql` unconditionally, ignoring `engine`. A KB row with `access_method: tsh, engine: postgres` expects kind `teleport-mysql`. This drives the doctor gate at `src/commands/doctor.ts:395-425`, which emits `MISCONFIGURED_DATASOURCE` and skips every plugin and connectivity check.

### Site 3: `src/core/resolve-datasource.ts:101-128` (policy order, not the target)

```ts
const accessMethod = accessMethods[0] || kbAccessMethod;
const syntheticKb = {
  access_method: accessMethod,
  ...
  ...(kb || {}),
};
```

`accessMethods` comes from `preferredAccessMethods` (`resolve-datasource.ts:29-33`): the environment policy list, then the KB value appended. `discoverTargets` (`:35-53`) walks the same list and concatenates targets from whichever branch produced any.

**When it is wrong**: the index-0 pick is not tied to the branch that produced the target. With `policy.preferredAccessMethods = ['tsh','qa-portforward']` and no KB row, `discoverTeleportTargets` returns `[]` (see section 5a), `discoverKubernetesTargets` returns kubectl service names, and `accessMethods[0]` is still `'tsh'`. The synthetic KB then carries `access_method: 'tsh'` with a Kubernetes service name as `target`, and `buildTshCandidate` (`bootstrap.ts:157`) writes a `teleport-mysql` profile pointed at a k8s service. The `...(kb || {})` spread at `:119` means the real KB wins when present, so this only bites when no KB row exists, which is exactly the case this branch exists to serve. Reasoned from the code; I did not run it.

### Site 4: `src/core/discover-datasources.ts:62-74` and `:99-140`, `:176-213` (port numbers and name regexes)

```ts
const DB_SERVICE_PATTERNS: Array<{ pattern: RegExp; engine: DbEngine }> = [
  { pattern: /(mysql|mariadb|maria|tidb|percona|aurora)/i, engine: DatasourceKind.Mysql },
  { pattern: /(postgres|postgresql|pgbouncer|^pg-)/i, engine: DatasourceKind.Postgres },
];

const DB_PORT_MAP: Record<number, DbEngine> = {
  3306: DatasourceKind.Mysql,
  4000: DatasourceKind.Mysql, // tidb
  6000: DatasourceKind.Mysql, // tiproxy (mysql wire)
  6033: DatasourceKind.Mysql, // alternate mysql proxy port
  5432: DatasourceKind.Postgres,
  6432: DatasourceKind.Postgres, // pgbouncer
};
```

Port wins over name (`:110-129`). The tsh side uses protocol strings instead (`:184-193`):

```ts
const kind: DiscoveryProposalKind = engine === DatasourceKind.Mysql ? DatasourceKind.TeleportMysql : DatasourceKind.Postgres;
```

**When it is wrong**: `DB_PORT_MAP` has no entry for `4406`, the default local port-forward port written by `bootstrap.ts:96`. A `kubectl get svc` sweep over a namespace that exposes 4406 classifies nothing on port and falls back to the name regex. More significant is the tsh branch: a postgres database behind Teleport gets kind `postgres`, never `teleport-postgres`, and never `teleport-mysql`.

### Site 5: `src/commands/doctor.ts:107-113`, `:127` and `src/core/readiness.ts:222-239` (label name prefixes)

`src/commands/doctor.ts:107-113`:

```ts
function connectorNameFromCheck(check: string): string {
  const label = str(check).toLowerCase();
  if (label.startsWith('openvpn')) return 'openvpn';
  if (label.startsWith('teleport')) return 'teleport';
  if (label.startsWith('kubectl-portforward')) return 'kubectl-portforward';
  return str(label.match(/^connector:([^ ]+)/)?.[1]).trim();
}
```

`src/core/readiness.ts:225-233` repeats the same three prefix tests with a different fallback regex and different flag sets. `src/commands/doctor.ts:284-305` repeats them a third time via `CONNECTOR_ACTION_STRATEGIES` (`:76-95`).

`src/commands/doctor.ts:126-131` uses `kind` as the tsh proxy:

```ts
function credentialRepairHint(datasource: DatasourceProfile): string {
  if (datasource.kind === DatasourceKind.TeleportMysql) {
    return `taproot --json creds set --ref ${datasource.credentialRef} --db-user <user> --password <password>`;
  }
  return `taproot --json creds set --ref ${datasource.credentialRef} --user <user> --password <password>`;
}
```

**When it is wrong**: the prefix match runs against a free-text check label. `teleportPlugin.doctor` emits the label `'teleport status'` (`src/plugins-builtins/teleport/index.ts:75`), so `startsWith('teleport')` also matches the `teleport-mysql` executor if it ever emits a label starting with `teleport`, and the hint would point at the connector setup flow instead of the executor. The `kind` proxy at `doctor.ts:127` breaks for any tsh-backed profile whose kind is not `teleport-mysql`, which is precisely the postgres-over-tsh case from sites 2 and 4.

### Are the five consistent?

No. Three concrete disagreements:

**D1: tsh + postgres has two answers.**

| Module | Kind for tsh + postgres |
| --- | --- |
| `src/core/conflicts.ts:7` | `teleport-mysql` (tsh wins, engine ignored) |
| `src/core/bootstrap.ts:163` | `teleport-mysql` (hardcoded in `buildTshCandidate`) |
| `src/core/discover-datasources.ts:193` | `postgres` |

Consequence: a profile created by `taproot discover` from a Teleport postgres database gets kind `postgres`. If a KB row exists for the same env and service with `access_method: tsh`, `expectedKindFromKb` returns `teleport-mysql`, `criticalDatasourceKbConflicts` (`conflicts.ts:39-40`) marks the kind mismatch critical, and `doctor` blocks with `MISCONFIGURED_DATASOURCE` (`doctor.ts:396-425`) before running any check. Reasoned from the code; not reproduced.

**D2: a fourth kind exists in exactly one place.**

`src/core/readiness.ts:161`:

```ts
const AUTH_REQUIRED_KINDS = new Set(['mysql', 'postgres', 'teleport-mysql', 'teleport-postgres']);
```

`teleport-postgres` appears nowhere else in `src/`, `test/`, `references/` or `docs/`. It is not in `DatasourceKind` (`src/types/core.ts:13-19`), no plugin registers it (`src/plugins/load-builtins.ts:11-20`), and no builder produces it. `readiness.ts` guards against a kind the rest of the system cannot create.

**D3: credential key names diverge by builder, and the hint follows kind not builder.**

`bootstrap.ts:181` stores the tsh credential default under `dbUser`. `bootstrap.ts:122` and `:151` store `user` for qa-portforward and native. `doctor.ts:127` picks between `--db-user` and `--user` from `kind === 'teleport-mysql'`. Consistent for the mysql-over-tsh path, wrong for any tsh profile that landed on kind `postgres` via D1.

Consistent where they agree: `conflicts.ts:51` accepts `127.0.0.1` and `localhost` for qa-portforward, and `bootstrap.ts:110` always writes `127.0.0.1`. That pair does not disagree.

---

## 3. The unread contract

**Confirmed.** `resolveByKind` and `resolveByCapability` are defined at `src/plugins/registry.ts:18` and `:22`. A repo-wide grep across `*.ts`, `*.md` and `*.js`, excluding `node_modules` and `.claude/worktrees`, returns only those two definition lines. Zero call sites, zero tests, zero doc mentions.

`resolveByKind` is also a weaker duplicate of `get`. Its predicate is `p.manifest.name === kind || p.manifest.kind === kind` (`registry.ts:19`), where `manifest.kind` is `connector|executor|resolver` (`src/types/core.ts:11`). So `resolveByKind('connector')` would return whichever connector happens to sort first by priority.

### What plugin selection actually does

One map lookup keyed on the datasource kind, relying on plugin `name` equalling datasource `kind`:

| Plugin name | manifest.kind | Matches datasource kind |
| --- | --- | --- |
| `mysql` | executor | `mysql` |
| `postgres` | executor | `postgres` |
| `redis` | executor | `redis` |
| `grpc` | executor | `grpc` |
| `teleport-mysql` | executor | `teleport-mysql` |
| `openvpn` | connector | none (selected by `connectors[]`) |
| `teleport` | connector | none |
| `kubectl-portforward` | connector | none |

Executors are looked up by `registry.get(datasource.kind)`. Connectors are looked up by `registry.get(name)` while iterating `datasource.connectors` (`src/core/app.ts:153`, `:161`).

### The hand-rolled guard, four call sites

**Confirmed, four sites.** Each does `get(kind)` then a hand-written method-presence test with its own error string:

| Site | Guard |
| --- | --- |
| `src/core/execute-query.ts:281-288` | `!plugin?.execute`, then `!plugin.manifest.capabilities.includes(capability)` |
| `src/core/schema-refresh.ts:150-151` | `!plugin?.execute` |
| `src/commands/doctor.ts:387-391` | `!plugin \|\| !plugin.doctor` |
| `src/commands/datasource.ts:169-173` | `!plugin?.doctor` |

A fifth, connector-only variant lives at `src/core/app.ts:161-163` (`!plugin`, no capability test).

One instance, `src/core/execute-query.ts:281-288`:

```ts
const plugin = ctx.pluginRegistry.get(datasource.kind);
if (!plugin?.execute) {
  return failure(new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`), { schemaContext, queryMemory });
}
const execute = plugin.execute;
if (!plugin.manifest.capabilities.includes(capability as any)) {
  return failure(new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`), { schemaContext, queryMemory });
}
```

`execute-query.ts:286` is the only place in `src/` that reads `manifest.capabilities` outside the dead `resolveByCapability`. The other three sites test the method reference and ignore the declared capability list entirely, so a plugin that implements `execute()` but omits `executeRead` from its manifest passes `schema-refresh.ts:151` and fails `execute-query.ts:286`. Note also the `as any` cast at `:286`, needed because `capability` is a narrowed string union that TypeScript will not accept against `Capability[]`.

---

## 4. What the docs promise

`references/plugin-contract.md` is 17 lines. It documents four exports and six manifest fields.

### Exports (`references/plugin-contract.md:3-7`)

| Export | Status | Evidence |
| --- | --- | --- |
| `manifest` | READ | `src/plugins/registry.ts:7` |
| `doctor()` | READ | `src/commands/doctor.ts:452`, `src/commands/datasource.ts:189`, `src/core/app.ts:168` |
| `resolve()` | **UNREAD** | declared `src/types/core.ts:340`, never invoked; no builtin implements it |
| `execute()` | READ | `src/core/execute-query.ts:341`, `src/core/schema-refresh.ts:162` |

The contract does not document `connect()` or `disconnect()`, which are declared (`src/types/core.ts:338-339`) and are read (`src/core/app.ts:174`, `:180`). The doc is behind the code there.

### Manifest fields (`references/plugin-contract.md:9-15`)

| Field | Status | Evidence |
| --- | --- | --- |
| `name` | READ | `src/plugins/registry.ts:7`, `:11`; printed at `src/commands/doctor.ts:413`, `:451`, `:468`; `src/core/readiness.ts:487` |
| `version` | **UNREAD** | zero hits for `manifest.version` in `src/` and `test/` |
| `kind` | READ | `src/commands/completion.ts:37` filters connectors by it. Also `src/plugins/registry.ts:19` (dead). |
| `capabilities` | READ | `src/core/execute-query.ts:286`, the single live read |
| `accessMethods` | **UNREAD** | zero hits for `manifest.accessMethods`. Declared by all 8 builtins: `mysql/index.ts:28`, `postgres/index.ts:33`, `redis/index.ts:278`, `grpc/index.ts:166`, `openvpn/index.ts:81`, `teleport/index.ts:69`, `teleport-mysql/index.ts:223`, `kubectl-portforward/index.ts:17` |
| `priority` | READ, ordering only | `src/plugins/registry.ts:15` sorts `list()`. `list()` has two consumers: `src/core/readiness.ts:487`, which joins names into a display string, and `src/commands/completion.ts:37`, which re-sorts alphabetically via `uniqueSorted`. So priority changes one line of readiness output and nothing else. |

### Field in the type but not in the doc

| Field | Status | Evidence |
| --- | --- | --- |
| `configSchema` | **UNREAD**, undocumented | declared `src/types/core.ts:56`; zero hits anywhere else; no builtin sets it |

### Size of the delete

Option B removes, in total:

- 2 of 6 documented manifest fields: `version`, `accessMethods`
- 1 undocumented type field: `configSchema`
- 1 documented and unread export hook: `resolve()`
- 2 dead registry methods: `resolveByKind`, `resolveByCapability`

Physical footprint: 8 `accessMethods:` lines plus 8 `version:` lines across the builtin plugins, 6 lines in `src/types/core.ts` (`PluginManifest.version`, `.accessMethods`, `.configSchema`, `TapRootPlugin.resolve`, and the `AccessMethod` const if the KB stays the only consumer, which it does not; see below), 7 lines in `src/plugins/registry.ts`, and 3 lines in `references/plugin-contract.md`.

Caveat on `AccessMethod` the const: deleting the manifest field does **not** let the const go. It is still read for KB values at `src/core/bootstrap.ts:189-191`, `src/core/conflicts.ts:7`, `:39`, `:49`, and `src/core/resolve-datasource.ts:41`, `:43`, `:121`. Only `types/core.ts:55` (`PluginManifest.accessMethods`) and the 8 manifest declarations go.

Also note `test/helpers/fake-plugin.ts:19-24` already omits `accessMethods` and casts `kind` and `capabilities` with `as never`. The test fixture treats the manifest as mostly optional today.

---

## 5. Adjacent dead weight

### (a) `discoverTeleportTargets` is a permanent `return []` with three unused parameters

**Confirmed.** `src/core/discovery.ts:58-60`:

```ts
export function discoverTeleportTargets(service: string, env: string, policy: EnvironmentPolicy): string[] {
  return [];
}
```

Three parameters, none referenced. `tsconfig.json` does not set `noUnusedParameters`, and the repo has no eslint config, so nothing flags them.

The single call site is `src/core/resolve-datasource.ts:44`, inside the `AccessMethod.Tsh` branch of `discoverTargets` (`:43-45`). So the tsh discovery branch contributes nothing to `targets`. When `preferredAccessMethods` is tsh-only (as in `test/runtime-policy-cache.test.ts:27`), `targets.length` is 0 at `resolve-datasource.ts:105` and the entire discovery block is skipped. "Unreachable in effect" is accurate. `src/core/discover-datasources.ts:238-250` (`fetchTshDatabases`) is the real tsh lister and is used only by `taproot discover`, not by resolution.

Note the default: `preferredAccessMethods` defaults to `[]` (`src/store/runtime-config.ts:9`, `src/store/schemas.ts:36`) and no init path writes it. So out of the box `accessMethods` is `[kbAccessMethod]` only.

No test covers `src/core/discovery.ts`. Grep of `test/` for `discoverTeleportTargets`, `discoverKubernetesTargets`, `inferDatabaseCandidates` and `sortTargets` returns zero hits.

### (b) `inferDatabaseCandidates` duplicates `inferDatabaseName`

**Confirmed.**

`src/core/discovery.ts:62-66`:

```ts
export function inferDatabaseCandidates(service: string, explicit?: string): string[] {
  if (explicit) return [explicit];
  const base = service.replace(/-/g, '_');
  return [...new Set([base].filter(Boolean))];
}
```

`src/core/discover-datasources.ts:87-89`:

```ts
function inferDatabaseName(service: string): string {
  return service.replace(/-/g, '_');
}
```

Same transform. `inferDatabaseCandidates` has one call site, `src/core/resolve-datasource.ts:107`, which passes no `explicit` and takes `[0]`:

```ts
const database = str(kb?.database || inferDatabaseCandidates(service)[0]);
```

So the `explicit` parameter, the `Set`, the `filter(Boolean)` and the array wrapper are all unexercised. `inferDatabaseName` has two call sites, `discover-datasources.ts:148` and `:205`.

### (c) Two `tsh status` parsers with different regexes, neither tested

**Confirmed.**

Parser 1, `src/plugins-builtins/teleport/index.ts:10-18`:

```ts
const want = /^\s*(Cluster|Logged in as|Valid until|Profile URL):/;
const lines = text.split(/\r?\n/).filter((line) => want.test(line)).map((line) => line.trim());
```

Four labels, line filter, no normalization pass.

Parser 2, `src/commands/connector.ts:23-41`:

```ts
const text = detail.replace(/^\>\s*/gm, '').trim();
const line = (label: string): string => {
  const m = text.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
  return m?.[1]?.trim() || '';
};
```

Eight labels (`Profile URL`, `Logged in as`, `Cluster`, `Roles`, `Kubernetes`, `Databases`, `Valid until`, `Extensions`), case-insensitive, unanchored, and it strips a leading `> ` from every line first.

The divergence is concrete. `tsh status` marks the active profile block with a leading `>` on its first line. Parser 2 strips that prefix at `connector.ts:24` before matching. Parser 1 anchors on `^\s*`, and `>` is not whitespace, so a `> Profile URL: ...` line fails `want.test` and is dropped from the summary. Parser 1 also matches only at line start; parser 2 matches anywhere in the text, so a label appearing inside a value would be picked up.

Test coverage: zero. Grep of `test/` for `parseTeleportStatus`, `summarizeTshStatus`, `teleport status` and `Logged in as` returns only `test/creds-lifecycle.test.ts:109` and `:112`, which pass `'tsh status'` as a literal `--status-command` string and assert it round-trips through the credential store. Neither parser is exercised. `test/connector-ux.test.ts` has four tests, all on setup, codes and next-action hints.

---

## 6. The case for each option

### Files touched

| | Option A: carry `accessMethod` | Option B: delete unread fields | True either way |
| --- | --- | --- | --- |
| Types | `src/types/core.ts` add to `DatasourceProfile` | `src/types/core.ts` drop `version`, `accessMethods`, `configSchema`, `resolve?` | `src/types/core.ts` is touched |
| Schema | `src/store/schemas.ts` add key, or zod strips it silently | none | |
| Registry | new dispatch module, plus `registry.ts` cleanup | `src/plugins/registry.ts` drop 2 methods | `registry.ts` is touched |
| Bootstrap | `src/core/bootstrap.ts` 3 builders write the field | none | |
| Producers | `src/core/discover-datasources.ts` (`DiscoveryProposal` + `proposalToProfile`), `src/core/resolve-datasource.ts` learning save at `:73-87`, `src/core/datasource-import.ts`, `src/commands/datasource.ts` add `--access-method` | none | |
| Consumers | `src/core/execute-query.ts:399` reads the profile, `src/core/conflicts.ts` reads the profile, `src/commands/doctor.ts:127`, `src/core/readiness.ts:161` | none | |
| Learning | `src/store/learning-types.ts` `ResolutionEntry`, `src/store/learning-resolution.ts` | none | |
| Dead weight | | | `src/core/discovery.ts:58` and `:62`, one of the two tsh parsers |
| Docs | `references/plugin-contract.md`, `references/kb/README.md:23`, `skills/taproot/references/workflows.md:273` | `references/plugin-contract.md` | `docs/adr/0002-*.md`, `CHANGELOG.md` |
| Tests | new: profile round-trip, dispatch table, `resolved.accessMethod` for a non-KB datasource. Touch: `test/datasource-crud.test.ts`, `test/init.test.ts`, `test/query-resolution.test.ts`, `test/doctor-bootstrap.test.ts`, `test/conflicts.test.ts` (25 lines, 1 test) | none required by the delete itself | new tests for the two tsh parsers and for `resolve-datasource.ts:111` |
| Rough file count | 13 to 16 source and test files | 10 files, almost all deletion | 6 to 8 files |

### What each buys

| Option A | Option B | True either way |
| --- | --- | --- |
| `resolved.accessMethod` becomes correct for hand-added and discovered datasources (today it is `''`) | The published contract stops advertising routing the code does not do | The `resolve-datasource.ts:111` cross-wiring gets fixed |
| One dispatch module replaces the four hand-rolled guards and the three prefix ladders | 8 plugin manifests shrink by 2 lines each; the type shrinks by 4 fields | The postgres-over-tsh kind gap (D1) gets a decision |
| tsh + postgres becomes expressible without inventing `teleport-postgres` | `manifest.capabilities` becomes the one honest routing input, checked at one place | `teleport-postgres` at `readiness.ts:161` gets deleted or gets a producer |
| `conflicts.ts` compares stored value to stored value instead of re-reading the KB | Nothing new to keep in sync, nothing new to migrate | The duplicate tsh parser and `inferDatabaseCandidates` go |
| `execute-query.ts` drops a KB lookup from every query | No persisted-state migration for existing `~/.taproot` datasource files | |

### What each forecloses

| Option A | Option B |
| --- | --- |
| Adds a persisted field. Existing datasource files have no value for it, so every consumer needs an undefined branch, or a backfill runs. The repo rule against back-compat shims means every call site changes in one go and unknown values are explicit. | Gives up the declared `accessMethods` routing hint permanently. A future third-party plugin cannot say "I speak tsh"; the only way to route to it stays the `name === kind` convention. |
| Two sources of truth appear: the profile field and `kb.access_method`. `conflicts.ts` gains a fourth pair to compare, and the two can drift when a KB row is edited after bootstrap. | Does not fix `resolved.accessMethod` returning `''` for non-KB datasources. Either the field gets deleted from the output envelope (a documented output, `workflows.md:273`, and a public envelope field, `types/core.ts:163`) or it stays wrong. |
| `datasource add --access-method` is a new public flag, and combinations that contradict `--kind` need validating. | Leaves the three prefix ladders (`doctor.ts:109-111`, `doctor.ts:284-305`, `readiness.ts:225-232`) in place. They are a separate cleanup either way. |

### Which option is the code closer to today

**Option B.** No storage layer carries the value: not the type (`types/core.ts:66-86`), not the zod schema (`schemas.ts:9-28`), not the learning entry (`learning-types.ts:3-18`), not the CLI (`datasource.ts:112-131`), not any test. The routing decision is already fully collapsed into `kind` and `connectors[]` at `bootstrap.ts:101-186`, and dispatch is already a single `Map.get` on `kind`. The only live consumer of the concept outside bootstrap is one KB re-read at `execute-query.ts:399` that returns an empty string whenever the KB is not the source. Option A is net new persisted state and a net new module; Option B is deletion of things nothing calls.

That is a statement about distance, not about which is right. The bugs in section 2 (D1, D3, and the `resolve-datasource.ts:111` cross-wiring) are real under both options, and none of them requires Option A to fix.

---

## 7. ADR scope

House format, from `docs/adr/0001-one-query-execution-module.md`: `# ADR-NNNN: <sentence-length decision>`, then `Status: accepted`, `Date: YYYY-MM-DD`, then sections `## Context`, `## Decision`, `## Behaviour changes`, `## Scope boundaries`, `## Deletions`, `## Verification`, `## Departures found during implementation`, `## Follow-ups settled after acceptance`, `## Consequences` split into `Good:` and `Costs:`.

Traits worth copying from 0001: it names files and line numbers in Context; it states the drift as shipped facts, not risks; it records departures rather than editing the decision text; it lists deletions by name; it names the specific test that proves the change and the specific manual run before merge; it states costs plainly, including a rejected stacked split and why.

An ADR-0002 needs, under each option:

**Common to both**

- Context: the five re-derivation sites from section 2, the three disagreements D1 to D3, and the zero call sites for `resolveByKind` / `resolveByCapability`.
- Decision on `teleport-postgres` (`readiness.ts:161`): delete the string, or give it a producer.
- Decision on the two tsh parsers: which one survives, and where it lives.
- Deletions section listing `discoverTeleportTargets`, `inferDatabaseCandidates`, `resolveByKind`, `resolveByCapability`, and the losing tsh parser.
- Verification: the two parsers and `resolve-datasource.ts:111` are untested today, so the ADR names the first tests over them.
- `CHANGELOG.md` entry, since `references/plugin-contract.md` is a published contract.

**Option A only**

- The persisted-field decision: field name, whether it is required or optional on `DatasourceProfile`, and the zod schema addition (without it, zod strips the field on every read).
- Migration for existing `~/.taproot` datasource files, stated as explicit values at each producer rather than a default, per the repo rule against back-compat shims.
- The dispatch module's boundary: what goes inside (kind to plugin, capability check, connector selection) and what stays outside, mirroring 0001's inside/outside split.
- Whether `manifest.accessMethods` becomes the dispatch input, or stays advisory. If it becomes the input, the `name === kind` convention is replaced and that is the real contract change.
- Behaviour change: `resolved.accessMethod` stops being `''` for hand-added datasources. That is visible to agents reading the envelope.

**Option B only**

- The exact delete list from section 4, and the statement that `manifest.capabilities` plus `name === kind` is the whole routing contract.
- What happens to `resolved.accessMethod` (`types/core.ts:163`, documented at `workflows.md:273`): keep the KB re-read and document that it is KB-only, or remove the field. Removing it is a breaking envelope change and needs a `CHANGELOG.md` entry.
- Whether `AccessMethod` (`types/core.ts:22-27`) stays. It must, because KB parsing reads it at seven places, so the ADR should say so explicitly to prevent a later reader from deleting it.
- The scope boundary that the prefix ladders in `doctor.ts` and `readiness.ts` are a separate change.

---

## Claims I could not verify

- The issue's count of "four modules". I found five re-derivation sites (section 2). The four hand-rolled capability guards (section 3) are exactly four, so the issue may be conflating the two counts.
- D1 (the postgres-over-tsh doctor block) and the `resolve-datasource.ts:111` cross-wiring are read off the code paths. I did not run the CLI or construct fixtures to reproduce either.
