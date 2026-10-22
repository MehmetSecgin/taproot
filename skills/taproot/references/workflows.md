# TapRoot Workflows

## Config
- Runtime config lives at `~/.taproot/config/deterministic-config.json`.
- Use `environmentPolicies` to define which envs are deterministic, discovery-friendly, and which access methods/targets are preferred.
- Use `serviceAliases` to normalize legacy service names to canonical TapRoot service names.

## Brand-New Machine
```bash
# creates ~/.taproot/ and prints the readiness checks.
# On an initialized but unconfigured machine: all checks ok/warn, never fail, exit 0.
# warn on kb_dir / datasources / credentials means "not configured yet", not broken.
taproot init

# whole-install health. `doctor` alone is NOT a health check: it needs a target and
# exits non-zero without --datasource or --env+--service.
taproot self-check --agent
```

## First Successful Query (Happy Path)
```bash
taproot init
taproot init datasource --env qa --service orders
taproot creds set --ref qa:orders --user reader --password <password>
taproot self-check --agent --datasource qa-orders
taproot doctor --datasource qa-orders --connect
taproot query --datasource qa-orders --sql "SELECT 1 AS ok"
```

## Setup And Credentials
- Runtime self-check:
```bash
taproot self-check
taproot self-check --agent
taproot self-check --agent --datasource <name>
taproot self-check --agent --env <env> --service <service>
```

- KB-backed datasource create/repair:
```bash
taproot init datasource --env <env> --service <service>
```

- Store and inspect credentials:
```bash
taproot creds set --ref <ref> --user <user> --password <password>
taproot creds show --ref <ref>
taproot creds unset --ref <ref>
```

- Configure and inspect connectors:
```bash
taproot connector setup --datasource <name> --connector <name> --ref <ref>
taproot connector status --datasource <name>
taproot connector status --datasource <name> --connector teleport
```

## Common Commands
- Preferred order for routine query tasks:
```bash
# known datasource + explicit SQL
taproot query --datasource <name> --sql "<sql>"
```

- Avoid this by default:
```bash
# don't start routine reads with doctor
taproot doctor --datasource <name> --connect

# don't rediscover routing if datasource is already known
taproot datasource resolve --env <env> --service <service>
taproot kb resolve --service <service> --env <env>
```

- Doctor known datasource:
```bash
taproot doctor --datasource <name> --connect
taproot doctor --datasource <name> --connect
```

- If `doctor` fails, read the failing checks: `code` classifies the failure and `detail` names the cause.

- Resolve from env/service:
```bash
taproot datasource resolve --env <env> --service <service>
taproot kb resolve --service <service> --env <env>
taproot kb list-services
```

- Query explicit SQL:
```bash
taproot query --datasource <name> --sql "SELECT 1 AS ok"
taproot query --env <env> --service <service> --sql "SELECT 1 AS ok"
taproot query --env <env> --service <service> --allow-discovery --sql "SELECT 1 AS ok"
```

- Query timeout:
```bash
# default is 15000ms; raise only when a slower query is intentional
taproot query --datasource <name> --timeout 30000 --sql "SELECT 1 AS ok"
```

- Redis / Dragonfly read commands:
```bash
# register (one-time). No auth example; for AUTH add `taproot creds set --ref ... --password ...`.
# Bake proto defaults via --hint so future queries auto-decode.
taproot datasource add \
  --name qa-cache-redis --kind redis \
  --env qa --namespace develop --service cache-redis \
  --host my-redis.develop --port 6379 --database 0 \
  --credential-ref qa:redis:cache \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/proto/<service> \
  --hint protoMessage=<MessageName>

# health check (PING -> PONG)
taproot doctor --datasource qa-cache-redis

# basic reads. Pass the raw Redis command verbatim.
taproot query --datasource qa-cache-redis --sql "DBSIZE"
taproot query --datasource qa-cache-redis --sql "INFO keyspace"
taproot query --datasource qa-cache-redis --sql "TYPE <key>"
taproot query --datasource qa-cache-redis --sql "GET <key>"
taproot query --datasource qa-cache-redis --sql "HGETALL <key>"
taproot query --datasource qa-cache-redis --sql "LRANGE <key> 0 -1"
taproot query --datasource qa-cache-redis --sql "SCAN 0 MATCH 'prefix:*' COUNT 100"

# proto decode without baked defaults (per-query override)
taproot query --datasource qa-cache-redis \
  --sql "GET <key>" \
  --proto <MessageName> \
  --proto-root /path/to/proto/src

# rows shape: columns=["value"], one row per reply line. Access via rows[i][0].
# With --proto active, rows[i][0] is the decoded message object (JSON). SCAN keys and (nil)
# fall through as text.
```

- gRPC unary calls:
```bash
# register. proto-root must contain the service .proto + transitive imports.
# build/extracted-protos/main is the single-root option for Java services.
taproot datasource add \
  --name qa-<svc>-grpc --kind grpc \
  --env qa --namespace develop --service <svc>-grpc \
  --host <svc>-grpc.develop --port 6565 \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/proto/<svc>

# doctor opens channel against the first service in the proto (or --hint probeService=<fq> to override)
taproot doctor --datasource qa-<svc>-grpc

# discover what's callable before composing requests.
# list / find / describe read the local proto root ONLY: no network, no VPN, no creds.
# Run them before connectivity exists; only doctor and query open a channel.
taproot grpc list --datasource qa-<svc>-grpc                  # services + methods only
taproot grpc find --datasource qa-<svc>-grpc <text>            # search service/method/request/response
taproot grpc describe --datasource qa-<svc>-grpc \
  --service <package.Service> --method <Method>                       # expands request + response messages
# --service/--method accept a short name or unambiguous substring.

# fastest path to a working call: request body + the exact query line to run
taproot grpc describe --datasource qa-<svc>-grpc \
  --service <Service> --method <Method> --skeleton
# every grpc query also returns the called method's shape under
# meta.schemaContext.services / .messages / .enums: read that after the call
# instead of re-running describe.

# unary call. Either --request-json or --param.
taproot query --datasource qa-<svc>-grpc \
  --sql "<package.Service/Method>" \
  --request-json '{"value":1}'

taproot query --datasource qa-<svc>-grpc \
  --sql "<package.Service/Method>" \
  --param text=United

# response shape: single row, value = full message. pluck nested with:
taproot query --datasource qa-<svc>-grpc \
  --sql "..." --request-json '...' \
  --pluck data.rows.0.0.<field>

# example call:
taproot query --datasource qa-catalog-grpc \
  --sql "com.example.catalog.v1.CatalogService/getItemsByParent" \
  --request-json '{"value":1}' --pluck data.rows.0.0.items
```

- Redis writes + flushes (gated):
```bash
# enable mutate on the profile (one-time, off by default)
taproot datasource add --name qa-cache-redis ... --allow-mutate

# write: needs --allow-mutate at query time too
taproot query --datasource qa-cache-redis --sql "SET k v" --allow-mutate
taproot query --datasource qa-cache-redis --sql "DEL k" --allow-mutate
taproot query --datasource qa-cache-redis --sql "EXPIRE k 60" --allow-mutate

# FLUSH-tier requires --allow-flush IN ADDITION to --allow-mutate
taproot query --datasource qa-cache-redis --sql "FLUSHDB" --allow-mutate --allow-flush

# default behaviour: writes blocked
# - without --allow-mutate -> "redis command 'SET' is a mutate operation; re-run with --allow-mutate."
# - profile.allowMutate=false -> "datasource policy disallows mutate queries..."
# - FLUSHDB with only --allow-mutate -> "FLUSH-tier command 'FLUSHDB' requires --allow-flush..."
```

- SQL schema discovery:
```bash
taproot query --datasource <name> --sql "SHOW TABLES"
taproot query --datasource <name> --sql "SHOW TABLES FROM <database>"
# columns, indexes, and partition key of one table, from the cached catalog
taproot query --datasource <name> --sql "SHOW CREATE TABLE <table>" --pluck meta.schemaContext.tables.<table>
# full DDL when the catalog fields are not enough
taproot query --datasource <name> --sql "SHOW CREATE TABLE <table>"
```

- Cache maintenance:
```bash
taproot cache show
taproot cache clear
```

- Session-backed repeated access:
```bash
taproot daemon start
taproot session open --datasource <name>
taproot session ls
```

- Repo safety:
```bash
taproot sanitize check-repo
```

## Output Expectations
- Prefer JSON output for automation and structured reporting.
- Read these fields first:
  - `ok`
  - `data`
  - `error.code`, `error.message`, `error.details`
  - `meta.requestId`, `meta.sessionId`
  - `resolved.source`, `resolved.accessMethod`, `resolved.target`, `resolved.database`, `resolved.engine`
  - `readiness`, `checks`, `target` from `self-check --agent`
  - `checks` from `init` and `doctor`

## Safety
- Keep DB operations read-only unless the user explicitly requests mutation and TapRoot policy allows it.
- Never read TapRoot’s cache or credential files directly.
- Let config decide which environments require deterministic resolution; do not assume special env names like `prod`, `stg`, or `qa`.
- Prefer canonical service names in saved artifacts; aliases from `serviceAliases` are for input normalization, not storage.
- If TapRoot is blocked, report the gap instead of falling back to direct `mysql`, `psql`, or `tsh` commands unless the user explicitly asks for that fallback.
- Prefer existing datasource/query knowledge over rediscovery. If the user already gave the datasource or query shape, use it.
- Never resend identical SQL that just failed; change the cause first.
- Use `doctor` for diagnosis, not as a mandatory pre-query ritual.
- For MySQL/TiDB introspection, prefer `meta.schemaContext`, `SHOW TABLES`, and `SHOW CREATE TABLE` before reaching for `information_schema`.
- Never use `LIKE`-based table discovery. Enumerate tables first and inspect exact names.
- Reserve `information_schema` queries for explicit cross-table metadata search, audits, or machine-readable bulk inspection.
