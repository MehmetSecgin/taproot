# TapRoot

Node/TypeScript CLI for deterministic querying across plugin-backed datasources.

v1 ships executor plugins (`mysql`, `postgres`, `redis`, `grpc`) and connector adapters for `openvpn`, `teleport`, `teleport-mysql`, `kubectl-portforward`, while architecture supports any queryable backend (kafka, rabbitmq, loki, k8s, etc.) via plugin modules.

## Principles
- Datasource-centric UX.
- Plugin-native query syntax + intent/template layer.
- Operator mode with explicit mutation gates.
- Agent-safe secrets and minimal output exposure.
- Self-learning/documenting local runtime.
- Reuse-first: prefer preexisting tools/libs over custom reinvention.

---

## Getting Started

### 1. Prerequisites

**Required**
- Node.js `>= 20`
- `git`

**Optional (install only what your datasources need)**
- `mysql` CLI — for `mysql`/`teleport-mysql` datasources
- `psql` — for `postgres` datasources
- `redis-cli` — for `redis` datasources (Redis or Dragonfly endpoints)
- _(`grpc` plugin needs no extra CLI — `@grpc/grpc-js` is bundled)_
- `kubectl` — for `qa-portforward` connector
- `tsh` (Teleport client) — for `teleport`/`teleport-mysql` datasources
- `openvpn3` or `openvpn` — for `openvpn` connector
- OS keychain (macOS Keychain / libsecret on Linux) — picked up automatically via the optional `keytar` dependency. If `keytar` fails to build, credentials fall back to an encrypted file in `~/.taproot/config/`.

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
taproot --version   # 0.6.0
```

> No npm registry release yet. `npm link` is the supported install path.

### 3. Initialize local state

```bash
taproot init
```

Creates `~/.taproot/` (config, cache, runs, learning). Idempotent.

### 4. Create a datasource, store credentials, query

```bash
# native MySQL example (substitute --kind postgres / teleport-mysql as needed)
taproot datasource add \
  --name dev-orders \
  --kind mysql \
  --env dev \
  --service orders \
  --credential-ref dev:orders \
  --host 127.0.0.1 \
  --port 3306 \
  --database orders

taproot creds set --ref dev:orders --user reader --password '***'

# preflight: confirm the datasource resolves and connects
taproot doctor --datasource dev-orders --connect

# read query
taproot query --datasource dev-orders --query "SELECT 1 AS ok"
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
  --database 0 \
  --connector openvpn \
  --openvpn-ref vpn:work

# no auth required? leave the cred ref empty. With AUTH set user/password via creds:
taproot creds set --ref qa:redis:cache --user default --password '***'

# doctor runs PING -> PONG
taproot doctor --datasource qa-cache-redis

# read query: pass any Redis read command as the query string
taproot --json query --datasource qa-cache-redis --query "DBSIZE"
taproot --json query --datasource qa-cache-redis --query "GET user:session:abc123"
taproot --json query --datasource qa-cache-redis --query "SCAN 0 COUNT 10"
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
- No schema cache, no card promotion, no partition checks — Redis bypasses the MySQL/Postgres learning paths.
- Discovery (`taproot discover`) does **not** yet propose Redis datasources; register them with `datasource add`.
- TLS: pass `--ssl true` on the datasource to add `--tls` to `redis-cli`.

Write + flush example:

```bash
# 1) profile must opt in to mutate
taproot datasource add \
  --name qa-cache-redis --kind redis \
  --env qa --namespace develop --service cache-redis \
  --host my-redis.develop --port 6379 --database 0 \
  --credential-ref qa:redis:cache \
  --connector openvpn --openvpn-ref vpn:work \
  --allow-mutate

# 2) write requires --allow-mutate at query time too
taproot --json query --datasource qa-cache-redis --query "SET taproot:test:key hello" --allow-mutate
taproot --json query --datasource qa-cache-redis --query "DEL taproot:test:key" --allow-mutate

# 3) FLUSHDB requires --allow-flush AS WELL AS --allow-mutate
taproot --json query --datasource qa-cache-redis --query "FLUSHDB" --allow-mutate --allow-flush
```

Proto-decoding example:

```bash
# Per-query
taproot --json query --datasource qa-order-cache \
  --query "GET order:v2:1001" \
  --proto OrderProto \
  --proto-root ~/proto/order-cache

# Bake defaults into the datasource (no flags needed on subsequent queries)
taproot datasource add \
  --name qa-order-cache --kind redis \
  --env qa --namespace develop --service order-cache \
  --host my-cache.develop --port 6379 --database 14 \
  --credential-ref qa:redis:order-cache \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/proto/order-cache \
  --hint protoMessage=OrderProto

taproot --json query --datasource qa-order-cache \
  --query "MGET order:v2:1001 order:v2:1002"
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

```bash
taproot datasource add \
  --name qa-catalog-grpc --kind grpc \
  --env qa --namespace develop --service catalog-grpc \
  --host catalog-grpc.develop --port 6565 \
  --credential-ref qa:grpc:catalog \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/repos/catalog-service,$HOME/repos/shared-protos

# doctor: opens a channel against the first service in the loaded proto.
# Override with --hint probeService=<fq> on datasource add if you need a specific one.
taproot doctor --datasource qa-catalog-grpc

# introspect what's callable before composing a request:
taproot --json grpc list --datasource qa-catalog-grpc            # services + methods only
taproot --json grpc list --datasource qa-catalog-grpc items      # filter methods by substring

# don't know the exact name? search across all services:
taproot --json grpc find --datasource qa-catalog-grpc items      # matches service/method/request/response

# --service and --method accept partial names (short name or unambiguous substring):
taproot --json grpc describe --datasource qa-catalog-grpc \
  --service CatalogService \
  --method getItemsByParent                                      # expands request + response messages

# --skeleton emits a ready-to-edit request body + the exact query call line:
taproot grpc describe --datasource qa-catalog-grpc \
  --method getItemsByParent --skeleton

# unary call: --query is "<package.Service/Method>". Request body in JSON:
taproot --json query --datasource qa-catalog-grpc \
  --query "com.example.catalog.v1.CatalogService/getItemsByParent" \
  --request-json '{"value":1}'

# or build the request from --param key=value pairs (numbers/booleans coerced):
taproot --json query --datasource qa-catalog-grpc \
  --query "com.example.catalog.v1.CatalogService/findItemsByNameLike" \
  --param text=Widget
```

gRPC plugin notes:
- Discovery: `grpc find <pattern>` searches every service/method by substring; `grpc list [pattern]` filters the method table; `grpc describe --service/--method` accept short names or unambiguous substrings (no need to copy the fully-qualified name). `grpc describe --method <m> --skeleton` prints an editable request JSON plus the exact `query` call line.
- Learned schema cache (mirrors the SQL `learn` flow): `taproot learn refresh-schema --datasource <grpc>` introspects the proto root once and caches the full descriptor (services/methods/messages/enums) keyed by service. `taproot learn schema --datasource <grpc>` reads it back (no proto-root needed in cwd) and `taproot learn ensure-schema --datasource <grpc>` introspects on first use then serves cache; add `--refresh` after a proto change, `--detailed` to include message/enum shapes. The cache shows up in `learn status` as `grpc schema entries`.
- Service/method typos in a call return a "did you mean" suggestion and the list of available methods; method names are matched case-insensitively.
- Unary calls only in v1. Server/client/bidi streaming deferred.
- Plaintext h2c by default. Set `--ssl true` on the datasource to switch to TLS.
- `--request-json` takes precedence over `--param`. `--param key=value` builds a flat JSON object; numeric strings → numbers, `true`/`false` → bool.
- Response: single row, `value` = full decoded message (oneofs collapsed, `longs:String` for int64). Pluck nested fields with `--pluck data.rows.0.0.<field>`.
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

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `TAPROOT_STATE_ROOT` | Override state directory | `~/.taproot` |
| `TAPROOT_MASTER_KEY` | Symmetric key for the encrypted credential fallback file. **Set this for portable, deterministic secrets.** | derived from `$USER@$platform` |
| `TAPROOT_NO_KEYCHAIN` | Force the encrypted file even when `keytar` is available | unset |
| `TAPROOT_KB_DIR` | Path to the KB directory (the one containing `services.json`). TapRoot does not care how you author the KB — Obsidian, a git repo, a hand-edited folder, anything. | `<TAPROOT_STATE_ROOT>/kb` |
| `OBSIDIAN_MEMORY_ROOT` | **Deprecated.** Legacy alias. When set (and `TAPROOT_KB_DIR` is unset), TapRoot appends `domains/engineering/references/db-kb` to it. Prefer `TAPROOT_KB_DIR`. | unset |
| `TAPROOT_QA_CONTEXT` | Default `kubectl` context for `qa-portforward` | env-name |
| `TAPROOT_QA_LOCAL_PORT` | Default local port for `qa-portforward` | `4406` |
| `TAPROOT_DATETIME_FORMAT` | Render Date columns as `iso` / `js` / `epoch` | `iso` |
| `TAPROOT_LOG_LEVEL` | pino log level | `info` |
| `TAPROOT_ALLOW_SCHEMA_INTROSPECTION` | Allow heavy introspection queries | unset (gated) |
| `TAPROOT_ALLOW_PARTITION_SCAN` | Allow partition scans | unset (gated) |

---

## Knowledge base

TapRoot can auto-create datasources from a local KB — a plain directory containing `services.json` and friends. The KB is just files on disk: an Obsidian vault, a checked-out git repo, or any folder you maintain by hand all work.

Point TapRoot at it via `TAPROOT_KB_DIR` (or `--kb-dir <path>`):

```bash
export TAPROOT_KB_DIR="$HOME/work/team-kb"   # any directory you control
taproot init datasource --env qa --service orders
```

Expected layout:

```
$TAPROOT_KB_DIR/
  services.json       # required; service → connection metadata
  query-templates.json
  relations.json
```

If you do not have a KB, use `taproot datasource add ...` directly (see [Getting Started](#4-create-a-datasource-store-credentials-query) above). Skip this section if you do not use one.

> Legacy: setups that previously used `OBSIDIAN_MEMORY_ROOT` keep working — when set, TapRoot appends `domains/engineering/references/db-kb` to it. New setups should set `TAPROOT_KB_DIR` to the KB directory directly.

---

## Discover datasources

`taproot discover` materializes datasource profiles from your local sources of truth — preferring the KB when present, falling back to live `kubectl`/`tsh` scans.

### From KB (preferred when you have one)

```bash
# Read TAPROOT_KB_DIR/services.json, generate proposals for the env.
# Dry-run by default; nothing is saved.
taproot discover kb --env qa

# Limit by namespace or single service.
taproot discover kb --env qa --namespace develop
taproot discover kb --env prod --service orders

# Save proposals + seed connector credential defaults (vpn:work statusCommand, tsh:<env> statusCommand).
taproot discover kb --env qa --apply
taproot discover kb --env prod --apply
```

Output matches whatever the KB declares per service / env (host, port, database, target, access_method). Supported KB `access_method`s: `native`, `tsh`, `qa-portforward`. Other methods are reported as skipped.

### From kubectl

```bash
# Default: classify by service-name / port, wire `openvpn` connector + vpn:work hint.
taproot discover kubectl --env qa --namespace develop

# Match a tiproxy-style cluster: rewrites host to `tiproxy-<service>.<namespace>` and uses a shared env credential ref.
taproot discover kubectl --env qa --namespace develop --host-pattern tiproxy --shared-credential-ref

# Apply.
taproot discover kubectl --env qa --namespace develop --host-pattern tiproxy --shared-credential-ref --apply

# Drop VPN wiring if your team does not VPN.
taproot discover kubectl --env qa --namespace develop --no-vpn
```

Heuristics: service port (3306/4000/6000/6033/5432/6432) or service name (mysql/maria/tidb/percona/postgres/pg). System namespaces (`kube-system`, `cert-manager`, ...) are skipped.

### From Teleport

```bash
taproot discover teleport --env prod --apply
```

Reads `tsh db ls --format=json` and produces `teleport-mysql` / `postgres` profiles with `connectors: [openvpn, teleport]` and matching `resolverHints`. Use `--no-vpn` to skip the VPN wiring.

### Notes
- Credentials are **never** discovered or saved. After `--apply`, set them per credential ref printed by discover:
  ```bash
  taproot creds set --ref <env>:<service> --user <user> --password '<***>'
  taproot creds set --ref vpn:work --status-command '<vpn status command>' --connect-command '<vpn connect command>'
  taproot creds set --ref tsh:<env> --status-command 'tsh status' --login-command 'tsh login --proxy <proxy> --auth <auth>'
  ```
- `--force` overwrites datasources with the same name; without it, conflicts are reported and skipped.

---

## Commands
- `taproot init` and `taproot init datasource --env <env> --service <service>`
- `taproot discover <kb|kubectl|teleport> --env <env> [--namespace <ns>] [--service <s>] [--host-pattern service-name|tiproxy] [--shared-credential-ref] [--no-vpn] [--apply] [--force]`
- `taproot self-check` or `taproot self-check --agent [--datasource <name> | --env <env> --service <service>]`
- `taproot doctor --datasource <name>` or `--env --service` (`--connect` to run connector login/connect actions, `--all` for full check list)
- `taproot query --datasource <name> [--query | --template | --intent] [--param k=v] [--allow-discovery]`
- `taproot datasource <list|show|add|remove|resolve>`
- `taproot connector <setup|status>`
- `taproot template <list|save|validate|run>`
- `taproot kb <resolve-connection|resolve-credentials|resolve-database-name|resolve-query|tables|related|list-services>`
- `taproot cache <show|prune|clear>`
- `taproot learn <status|compact|replay|refresh-schema|schema|ensure-schema|tables|joins|shapes|relations>` — `refresh-schema`/`schema`/`ensure-schema` also handle `grpc` datasources (proto descriptor cached per service)
- `taproot creds <set|show|unset>`
- `taproot daemon <start|status|stop|restart>`
- `taproot session <open|ls|inspect|close|close-all>`
- `taproot completion <zsh|bash|fish>`
- `taproot sanitize check-repo`
- `taproot grpc describe [--datasource <name> | --proto-root <dir>] [--service <name>] [--method <name>] [--skeleton] [--max-depth <n>]` — `--service`/`--method` accept partial names
- `taproot grpc list [pattern] [--datasource <name> | --proto-root <dir>] [--service <name>]`
- `taproot grpc find <pattern> [--datasource <name> | --proto-root <dir>]`

---

## Agent-facing diagnostics

Use targeted readiness before deeper troubleshooting:

```bash
taproot --json self-check --agent --datasource <name>
taproot --json self-check --agent --env <env> --service <service>
```

Targeted readiness returns:

- `readiness`
- `missing`
- `nextCommand`
- `nextActions`
- `nextActionDetails`
- `checks`
- `target`

For deeper diagnosis:

```bash
taproot --json doctor --datasource <name>
taproot --json doctor --datasource <name> --connect
```

`doctor --json` returns both `nextActions` (ordered command strings) and `nextActionDetails` (structured remediation with `command`, `priority`, `checks`, `codes`, `reasons`). `init --json` and `self-check --agent --json` expose the same `nextActionDetails` shape.

---

## OpenVPN + Teleport setup

```bash
# connector credential refs (local encrypted state, not repository files)
taproot creds set --ref vpn:work --status-command "openvpn3 sessions-list" --connect-command "openvpn3 session-start --config /absolute/path/to/profile.ovpn"
taproot creds set --ref tsh:work --status-command "tsh status" --login-command "tsh login --proxy your.teleport.proxy --auth your-sso"
taproot creds set --ref production:analytics --db-user analytics_reader

# datasource using teleport mysql executor + connectors
taproot datasource add \
  --name production-analytics \
  --kind teleport-mysql \
  --env production \
  --service analytics \
  --credential-ref production:analytics \
  --database analytics \
  --target primary-tidb \
  --connector openvpn \
  --connector teleport \
  --connector-ref openvpn=vpn:work \
  --connector-ref teleport=tsh:work

taproot doctor --datasource production-analytics
taproot query --datasource production-analytics --query "SELECT COUNT(*) AS row_count FROM sample_records WHERE record_id = 12345;"
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
    templates.json
  cache/
  runs/
  learning/
    runs-ledger/
```

---

## Notes
- Built-in DB plugins only expose `executeRead` in v1.
- The `redis` plugin classifies commands into three tiers (read / mutate / flush) and enforces gates in-process because the shared SQL safety regex does not understand Redis verbs. `--allow-mutate` gates mutates, `--allow-flush` (additive) gates `FLUSHDB`/`FLUSHALL`/`SWAPDB`/`MIGRATE`. Unknown commands are rejected.
- `prod` defaults to deterministic no-guess datasource resolution (profile/KB); use `--allow-discovery` only when explicitly needed.
- Mutating queries require `--allow-mutate` **and** datasource policy with `executeMutate`.
- `taproot init datasource --env <env> --service <service>` is the explicit KB-backed create/repair path for stale datasource profiles.
- `taproot self-check --agent` is the preferred machine-readable readiness contract, especially with `--datasource` or `--env` + `--service`.
- Secrets are never printed and are redacted from JSON output envelopes.
- Learning uses deterministic local caches (`resolution-cache`, `query-library`, `query-stats`) and excludes secret values.
- Connection commands for connectors are provided via local credential refs (`--connect-command`, `--login-command`) and never committed to repo by default.
- Credentials contain auth/connector material; connection topology (`host`, `port`, `database`, `target`) lives in datasource profiles.
- `taprootd`/`session` commands are available for Phase 1 runtime scaffolding.
- Human mode uses compact progress on stderr; structured data stays on stdout.
- Use global `--verbose` for step-by-step diagnostics (also on stderr).

### Contracts
- Learning contract: `references/learning-contract.md`
- Runtime architecture: `references/runtime-architecture.md`
- Phase 1 runtime contract: `references/phase1-runtime-contract.md`
- Porcelain vs plumbing contract: `references/porcelain-plumbing-contract.md`
- JSON envelope contract: `references/json-envelope-contract.md`

---

## Project governance
- License: [MIT](LICENSE)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Security: [SECURITY.md](SECURITY.md)
