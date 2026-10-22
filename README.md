# TapRoot

Node/TypeScript CLI for deterministic querying across plugin-backed datasources.

v1 ships executor plugins (`mysql`, `teleport-mysql`, `redis`, `grpc`) and connector adapters for `teleport` and `kubectl-portforward`, while architecture supports any queryable backend (kafka, rabbitmq, loki, k8s, etc.) via plugin modules.

## Principles
- Datasource-centric UX.
- Plugin-native query syntax with explicit SQL only.
- Operator mode with explicit mutation gates.
- Agent-safe secrets and minimal output exposure.
- Schema-aware local runtime: each SQL query returns the columns, keys and indexes of the tables it touches.
- Reuse-first: prefer preexisting tools/libs over custom reinvention.

---

## Getting Started

### 1. Prerequisites

**Required**
- Node.js `>= 20`
- `git`

**Optional (install only what your datasources need)**
- `mysql` CLI — for `mysql`/`teleport-mysql` datasources
- `redis-cli` — for `redis` datasources (Redis or Dragonfly endpoints)
- _(`grpc` plugin needs no extra CLI — `@grpc/grpc-js` is bundled)_
- `kubectl` — for `qa-portforward` connector
- `tsh` (Teleport client) — for `teleport`/`teleport-mysql` datasources
- OS keychain (macOS Keychain / libsecret on Linux) — picked up automatically via the optional `keytar` dependency. If `keytar` fails to build, credentials fall back to an encrypted file in `~/.taproot/config/`. On npm versions that gate install scripts, `npm ci` prints `allow-scripts` warnings and skips building `keytar`, so the fallback file is used. That is a supported setup; to use the OS keychain instead, run `npm approve-scripts keytar` and reinstall.

### 2. Install from source

```bash
git clone https://github.com/MehmetSecgin/taproot.git
cd taproot
npm ci
npm run build
npm link            # puts `taproot` and `taprootd` on your PATH
```

Verify:

```bash
taproot --version   # prints the installed version
```

> No npm registry release yet. `npm link` is the supported install path.

### 3. Initialize local state

```bash
taproot init
```

Creates `~/.taproot/` (config, cache) and prints the readiness checks. Idempotent; rerun it to reprint the checks.

### 4. Create a datasource, store credentials, query

```bash
# native MySQL example (substitute --kind teleport-mysql as needed)
taproot datasource add \
  --name dev-orders \
  --kind mysql \
  --env dev \
  --service orders \
  --host 127.0.0.1 \
  --port 3306 \
  --database orders

# --credential-ref defaults to --env (here: dev); pass it when the ref differs
taproot creds set --ref dev --user reader --password '***'

# preflight: confirm the datasource resolves and connects
taproot doctor --datasource dev-orders --connect

# read query
taproot query --datasource dev-orders --sql "SELECT 1 AS ok"
```

### Redis (read-only)

```bash
# add a redis datasource — works against Redis or Redis-compatible (Dragonfly, KeyDB)
taproot datasource add \
  --name qa-cache-redis \
  --kind redis \
  --env qa \
  --namespace develop \
  --service cache-redis \
  --credential-ref qa:redis:cache \
  --host my-redis.develop \
  --port 6379 \
  --database 0

# no auth required? leave the cred ref empty. With AUTH set user/password via creds:
taproot creds set --ref qa:redis:cache --user default --password '***'

# doctor runs PING -> PONG
taproot doctor --datasource qa-cache-redis

# read query: pass any Redis read command as the query string
taproot query --datasource qa-cache-redis --sql "DBSIZE"
taproot query --datasource qa-cache-redis --sql "GET user:session:abc123"
taproot query --datasource qa-cache-redis --sql "SCAN 0 COUNT 10"
```

Redis plugin notes:
- Three-tier command classification:
  - **read** (`GET/MGET/HGETALL/LRANGE/SMEMBERS/ZRANGE/KEYS/SCAN/INFO/DBSIZE/TYPE/TTL/...` + safe `OBJECT/CONFIG GET/CLIENT/MEMORY/COMMAND/LATENCY` subcommands) — runs by default.
  - **mutate** (`SET/SETEX/SETNX/MSET/DEL/UNLINK/EXPIRE/RENAME/COPY/INCR/HSET/HDEL/LPUSH/RPUSH/SADD/SREM/ZADD/ZREM/XADD/XDEL/PFADD/BITOP/...`) — requires `--allow-mutate` AND `datasource.policy.allowMutate=true` (set via `taproot datasource add ... --allow-mutate`) AND `executeMutate` in the policy capability list.
  - **flush** (`FLUSHDB/FLUSHALL/SWAPDB/MIGRATE`) — requires `--allow-flush` on top of the mutate gates.
- `SORT` without `STORE` is read; `SORT ... STORE` is mutate. Use `SORT_RO` on replicas.
- Unknown commands are rejected by default.
- Output shape: single column `value`, one row per reply line (multi-bulk replies → multiple rows).
- Protobuf decoding (Redis only): pass `--proto <MessageName> --proto-root <dir>` to decode binary replies with `protobufjs`. `--proto-root` is loaded recursively; all `.proto` files inside are registered and imports resolve by basename. Decoded rows carry the message object as `value`; text replies (`SCAN` keys, `(nil)`, integers, `INFO` blocks) pass through unchanged. Printable-ASCII fallback prevents `SCAN`/`KEYS` from being misdecoded. Per-datasource defaults via `resolverHints.protoRoot` / `resolverHints.protoMessage` (set with `--hint key=value` on `datasource add`).
- Without `--proto`, binary payloads pass through raw — `redis-cli` is not asked to decode them.
- No schema catalog, no partition checks: Redis bypasses the MySQL schema catalog.
- TLS: pass `--ssl true` on the datasource to add `--tls` to `redis-cli`.

Write + flush example:

```bash
# 1) profile must opt in to mutate
taproot datasource add \
  --name qa-cache-redis --kind redis \
  --env qa --namespace develop --service cache-redis \
  --host my-redis.develop --port 6379 --database 0 \
  --credential-ref qa:redis:cache \
  --allow-mutate

# 2) write requires --allow-mutate at query time too
taproot query --datasource qa-cache-redis --sql "SET taproot:test:key hello" --allow-mutate
taproot query --datasource qa-cache-redis --sql "DEL taproot:test:key" --allow-mutate

# 3) FLUSHDB requires --allow-flush AS WELL AS --allow-mutate
taproot query --datasource qa-cache-redis --sql "FLUSHDB" --allow-mutate --allow-flush
```

Proto-decoding example:

```bash
# Per-query
taproot query --datasource qa-order-cache \
  --sql "GET order:v2:1001" \
  --proto OrderProto \
  --proto-root ~/proto/order-cache

# Bake defaults into the datasource (no flags needed on subsequent queries)
taproot datasource add \
  --name qa-order-cache --kind redis \
  --env qa --namespace develop --service order-cache \
  --host my-cache.develop --port 6379 --database 14 \
  --credential-ref qa:redis:order-cache \
  --hint protoRoot=$HOME/proto/order-cache \
  --hint protoMessage=OrderProto

taproot query --datasource qa-order-cache \
  --sql "MGET order:v2:1001 order:v2:1002"
# rows: [[{order_id:"1001", status:"OPEN"}], [{order_id:"1002", status:"OPEN"}]]
```

---

### gRPC (read-only)

# proto-root is a LOCAL directory (or comma-separated list) of .proto sources.
# It is loaded recursively, so the easiest setup is to clone the proto-bearing
# repos and point proto-root at the parent dir of your checkouts:
#   --hint protoRoot=$HOME/repos
# Service protos often import from OTHER modules/repos (e.g. a service .proto
# imports a shared common.proto that lives in a separate repo). Make sure those
# checkouts are under proto-root too, or comma-list each module dir:
#   --hint protoRoot=$HOME/repos/catalog-service,$HOME/repos/shared-protos
# google/protobuf/* well-known types are bundled — no checkout needed. If an
# import can't be found, the loader names the missing file + the proto that
# imports it so you know which repo to clone.
```

gRPC datasources need no stored credentials, so leave `--credential-ref` off (it defaults to `--env`). Add `--ssl` if the endpoint speaks TLS rather than plaintext h2c.

Everything under `grpc list` / `find` / `describe` reads the local proto root only, so you can explore an API and build a request skeleton before you have network access to the service. Only `doctor` and `query` need to reach it.

```bash
taproot datasource add \
  --name qa-catalog-grpc --kind grpc \
  --env qa --namespace develop --service catalog-grpc \
  --host catalog-grpc.develop --port 6565 \
  --hint protoRoot=$HOME/repos/catalog-service,$HOME/repos/shared-protos

# doctor: opens a channel against the first service in the loaded proto.
# Override with --hint probeService=<fq> on datasource add if you need a specific one.
taproot doctor --datasource qa-catalog-grpc

# introspect what's callable before composing a request:
taproot grpc list --datasource qa-catalog-grpc            # services + methods only
taproot grpc list --datasource qa-catalog-grpc items      # filter methods by substring

# don't know the exact name? search across all services:
taproot grpc find --datasource qa-catalog-grpc items      # matches service/method/request/response

# --service and --method accept partial names (short name or unambiguous substring):
taproot grpc describe --datasource qa-catalog-grpc \
  --service CatalogService \
  --method getItemsByParent                                      # expands request + response messages

# --skeleton emits a ready-to-edit request body + the exact query call line:
taproot grpc describe --datasource qa-catalog-grpc \
  --method getItemsByParent --skeleton

# unary call: --sql is "<package.Service/Method>". Request body in JSON:
taproot query --datasource qa-catalog-grpc \
  --sql "com.example.catalog.v1.CatalogService/getItemsByParent" \
  --request-json '{"value":1}'

# or build the request from --param key=value pairs (numbers/booleans coerced):
taproot query --datasource qa-catalog-grpc \
  --sql "com.example.catalog.v1.CatalogService/findItemsByNameLike" \
  --param text=Widget

# client-streaming or bidi call: one array element per request message.
# Returns one row per response message (columns seq, value):
taproot query --datasource qa-catalog-grpc \
  --sql "com.example.catalog.v1.CatalogService/lookupItems" \
  --request-json '[{"id":1},{"id":2},{"id":3}]'
```

gRPC plugin notes:
- Discovery: `grpc find <pattern>` searches every service/method by substring; `grpc list [pattern]` filters the method table; `grpc describe --service/--method` accept short names or unambiguous substrings (no need to copy the fully-qualified name). `grpc describe --method <m> --skeleton` prints an editable request JSON plus the exact `query` call line.
- Service/method typos in a call return a "did you mean" suggestion and the list of available methods; method names are matched case-insensitively.
- Streaming calls run as a batch: every request message is sent, the stream is half-closed, and every response is collected. Up to 1000 messages each way (`TAPROOT_GRPC_STREAM_MESSAGE_LIMIT`). A server-side stream failure fails the query; `error.details.receivedRows` keeps the rows that arrived first.
- Plaintext h2c by default. Set `--ssl true` on the datasource to switch to TLS.
- `--request-json` takes precedence over `--param`. `--param key=value` builds a flat JSON object; numeric strings → numbers, `true`/`false` → bool.
- Unary response: single row, `value` = full decoded message (oneofs collapsed, `longs:String` for int64). Pluck nested fields with `--pluck data.rows.0.0.<field>`.
- Every grpc query result carries `meta.schemaContext.services` + `.messages` + `.enums` for the called method (transitive expansion of request + response shapes) — read that to compose follow-up calls instead of re-running `grpc describe`.
- proto-root is loaded recursively via the shared proto loader (`@grpc/proto-loader` + `protobufjs`); all imports must be findable under `--proto-root` or beside the loaded files. Use the service repo's `build/extracted-protos/main` for one-shot self-contained loading.
- Doctor opens a real channel against the first service in the loaded package by default. Override with `--hint probeService=<fq>` on `datasource add` to pin a specific service.
- TLS bearer auth: store `token` on the credential ref (`taproot creds set --ref qa:grpc:region --token '<jwt>'`); the plugin adds `authorization: Bearer <token>` metadata when present. Static metadata via `--hint metadata.<key>=<value>`.
- No mutate gating yet — all gRPC methods run as `executeRead` regardless of side effects. If you need mutate distinction (because some RPCs write), gate the datasource by `policy.allowMutate` at registration time.

---

If you have a KB (see [Knowledge base](#knowledge-base) below), you can replace `datasource add` with the KB-backed shortcut:

```bash
taproot init datasource --env <env> --service <service>
```

For a clean-machine end-to-end check, see `scripts/smoke-onboard.sh`.

---

## Query semantics

### Time zones (UTC by default)

For MySQL/TiDB datasources TapRoot runs `SET time_zone = '+00:00'` on every connection. This means **`WHERE` timestamp literals are interpreted as UTC** and `TIMESTAMP`/`DATETIME` columns render as UTC (ISO-8601). Literal interpretation and display therefore agree on the same absolute instant:

```bash
# both the literals and the rendered rows are UTC
taproot query --datasource prod-orders \
  --sql "SELECT id, created_at FROM orders WHERE created_at BETWEEN '2026-06-24 17:00:00' AND '2026-06-24 17:05:00'"
```

Override the session zone with `--tz` (accepts an offset like `+05:30`/`-08:00` or an IANA name like `Europe/Berlin`), or per-datasource via `resolverHints.timeZone`, or globally via `defaults.query.timeZone` in runtime config. Resolution order: `--tz` > datasource hint > config default > UTC.

### Query timeout

Queries abort after `--timeout <ms>` (default `15000`; configurable via `defaults.query.timeoutMs` or `TAPROOT_QUERY_TIMEOUT_MS`). On timeout the error states the effective limit and suggests narrowing the scan (e.g. adding a partition/time predicate).

### Extracting JSON without engine-specific SQL

Prefer selecting raw JSON columns and extracting client-side with `--json-extract <column>:<dotpath>` (repeatable). It parses the raw JSON cell after fetching and adds a derived `<column>.<dotpath>` column, avoiding hand-written engine JSON functions:

```bash
taproot query --datasource prod-orders \
  --sql "SELECT id, payload FROM orders LIMIT 5" \
  --json-extract payload:order.status --json-extract payload:order.total
```

### Schema catalog

The first query against a SQL datasource (`mysql`, `teleport-mysql`) starts a background read of `information_schema` columns, indexes and partitions, and caches them at `~/.taproot/cache/schema/<datasource>.json`. The fetch never delays a query: the daemon finishes it after replying, and concurrent queries share one fetch. Until it lands, responses carry no `meta.schemaContext.tables` and the partition guard has nothing to check. The cache is fresh for `TAPROOT_CATALOG_TTL_HOURS` (default 24); a stale catalog keeps serving while the refetch runs. A failed fetch never fails the query. An `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` error refetches the catalog and appends the closest cached names to the message (`Did you mean: orders.customer_id?`), also returned as `error.details.didYouMean`.

Each SQL query returns `meta.schemaContext.tables[<table>]` for the tables it references: `database`, `columns`, `primaryKey`, `indexes` (`unique` appears only when true, `type` only when not `BTREE`) and `partition`. `meta.schemaContext.catalog` carries `{ tables, fetchedAt }`.

The partition guard (`MISSING_PARTITION_PREDICATE`, bypass with `--allow-partition-scan`) and the range warnings (`TAPROOT_MAX_RANGE_DAYS`) read the same cached catalog.

### Output

Every command prints exactly one line of compact JSON on stdout: results, errors, `--help` and `--version` alike. `--pluck <dot.path>` is a global option that prints only that subtree of the envelope.

```bash
taproot query --datasource dev-orders --sql "SELECT id, status FROM orders LIMIT 3" --pluck data.rows
[[1,"open"],[2,"paid"],[3,"open"]]
```

- On failure the command prints the full error envelope (`{"ok":false,"error":{...}}`), even with `--pluck`, and exits non-zero.
- `--verbose` adds diagnostics on stderr as JSON lines (`{"verbose":"..."}`).

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `TAPROOT_STATE_ROOT` | Override state directory | `~/.taproot` |
| `TAPROOT_MASTER_KEY` | Symmetric key for the encrypted credential fallback file. **Set this for portable, deterministic secrets.** | derived from `$USER@$platform` |
| `TAPROOT_NO_KEYCHAIN` | Force the encrypted file even when `keytar` is available | unset |
| `TAPROOT_KB_DIR` | Path to the KB directory (the one containing `services.json`). Overrides the directory saved by `taproot init --kb-dir`. TapRoot does not care how you author the KB: Obsidian, a git repo, a hand-edited folder, anything. | saved `kbDir`, else `<TAPROOT_STATE_ROOT>/kb` |
| `TAPROOT_QA_CONTEXT` | Default `kubectl` context for `qa-portforward` | env-name |
| `TAPROOT_QA_LOCAL_PORT` | Default local port for `qa-portforward` | `4406` |
| `TAPROOT_QUERY_TIMEOUT_MS` | Default query statement timeout (ms). Override per-query with `--timeout`, or globally via `defaults.query.timeoutMs` in runtime config. | `15000` |
| `TAPROOT_CATALOG_TTL_HOURS` | Hours a cached schema catalog stays fresh | `24` |
| `TAPROOT_CATALOG_TIMEOUT_MS` | Timeout for one schema catalog fetch (ms) | `20000` |
| `TAPROOT_MAX_RANGE_DAYS` | Widest date range before the range warning | `90` |
| `TAPROOT_ALLOW_PARTITION_SCAN` | Allow partition scans | unset (gated) |

---

## Knowledge base

TapRoot can auto-create datasources from a local KB — a plain directory containing `services.json` and friends. The KB is just files on disk: an Obsidian vault, a checked-out git repo, or any folder you maintain by hand all work.

Save the KB directory once with `taproot init --kb-dir <path>`. It lands as `kbDir` in `deterministic-config.json`, so every shell, daemon and agent finds it without an env var:

```bash
taproot init --kb-dir "$HOME/work/team-kb"   # any directory you control
taproot init datasource --env qa --service orders
```

TapRoot picks the KB directory in this order: `--kb-dir`, then `TAPROOT_KB_DIR`, then the saved `kbDir`, then `<TAPROOT_STATE_ROOT>/kb`. When `TAPROOT_KB_DIR` is set and nothing is saved yet, `taproot init` saves it.

KB commands (`kb *`, `init datasource`) fail with `KB_MISSING` when that directory does not exist or lists no services. The message names the directory TapRoot looked in.

Expected layout:

```
<kb-dir>/
  services.json       # required; service → connection metadata
  relations.json
```

If you do not have a KB, use `taproot datasource add ...` directly (see [Getting Started](#4-create-a-datasource-store-credentials-query) above). Skip this section if you do not use one.

---

## Commands
- `taproot init` and `taproot init datasource --env <env> --service <service>`
- `taproot doctor --datasource <name>` or `--env --service` (`--connect` to run connector login/connect actions)
- `taproot query --datasource <name> --sql <sql> [--param k=v] [--allow-discovery]`
- `taproot datasource <list|show <name>|add|remove <name>|resolve|import>`
- `taproot kb <resolve|tables|list-services|relations list|relations import>`; `kb resolve` takes `--datasource <name>` or `--env <env> --service <service>`
- `taproot creds <set|show|list|unset>`
- `taproot daemon <status|stop>`: the first query starts the daemon, and it exits when idle
- `taproot grpc describe [--datasource <name> | --proto-root <dir>] [--service <name>] [--method <name>] [--skeleton] [--max-depth <n>]` — `--service`/`--method` accept partial names
- `taproot grpc list [pattern] [--datasource <name> | --proto-root <dir>] [--service <name>]`
- `taproot grpc find <pattern> [--datasource <name> | --proto-root <dir>]`

---

## Agent-facing diagnostics

`taproot init` reports whole-install readiness (`readiness`, `checks`). For one datasource:

```bash
taproot doctor --datasource <name>
taproot doctor --datasource <name> --connect
```

`doctor` returns `checks`, each with `status`, `code`, and a `detail` that names the cause.

---

## Teleport setup

```bash
# connector credential refs (local encrypted state, not repository files)
taproot creds set --ref tsh:work --status-command "tsh status" --login-command "tsh login --proxy your.teleport.proxy --auth your-sso"
taproot creds set --ref production:analytics --db-user analytics_reader

# datasource using the teleport-mysql executor and the teleport connector
taproot datasource add \
  --name production-analytics \
  --kind teleport-mysql \
  --env production \
  --service analytics \
  --credential-ref production:analytics \
  --database analytics \
  --target primary-tidb \
  --connector teleport \
  --connector-ref teleport=tsh:work

taproot doctor --datasource production-analytics
taproot query --datasource production-analytics --sql "SELECT COUNT(*) AS row_count FROM sample_records WHERE record_id = 12345;"
```

---

## Build & test

```bash
npm ci
npm run build
npm test
```

---

## State

Default runtime state path: `~/.taproot/`

Structure:

```
~/.taproot/
  config/
    deterministic-config.json
    datasources.json
    credentials.json.enc       # encrypted-file fallback when no keychain
  cache/
    schema/<datasource>.json
```

---

## Notes
- Built-in DB plugins only expose `executeRead` in v1.
- The `redis` plugin classifies commands into three tiers (read / mutate / flush) and enforces gates in-process because the shared SQL safety regex does not understand Redis verbs. `--allow-mutate` gates mutates, `--allow-flush` (additive) gates `FLUSHDB`/`FLUSHALL`/`SWAPDB`/`MIGRATE`. Unknown commands are rejected.
- `prod` defaults to deterministic no-guess datasource resolution (profile/KB); use `--allow-discovery` only when explicitly needed.
- Mutating queries require `--allow-mutate` **and** datasource policy with `executeMutate`.
- `taproot init datasource --env <env> --service <service>` is the explicit KB-backed create/repair path for stale datasource profiles.
- `taproot init` is the whole-install readiness check; `taproot doctor --datasource <name>` checks one datasource.
- Secrets are never printed and are redacted from JSON output envelopes.
- The schema catalog is a deterministic local cache and excludes secret values.
- Connection commands for connectors are provided via local credential refs (`--connect-command`, `--login-command`) and never committed to repo by default.
- Credentials contain auth/connector material; connection topology (`host`, `port`, `database`, `target`) lives in datasource profiles.
- `taprootd`/`session` commands are available for Phase 1 runtime scaffolding.
- Human mode uses compact progress on stderr; structured data stays on stdout.
- Use global `--verbose` for step-by-step diagnostics (also on stderr).

### Contracts
- Runtime architecture: `references/runtime-architecture.md`
- Phase 1 runtime contract: `references/phase1-runtime-contract.md`
- JSON envelope contract: `references/json-envelope-contract.md`

---

## Project governance
- License: [MIT](LICENSE)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Security: [SECURITY.md](SECURITY.md)
