# TapRoot Workflows

## Config
- Runtime config lives at `~/.taproot/config/deterministic-config.json`.
- Use `environmentPolicies` to define which envs are deterministic, discovery-friendly, and which access methods/targets are preferred.
- Use `serviceAliases` to normalize legacy service names to canonical TapRoot service names.

## Brand-New Machine
```bash
# creates ~/.taproot/ and prints an ordered, runnable next-actions list.
# On an initialized but unconfigured machine: all checks ok/warn, never fail, exit 0.
# warn on kb_dir / datasources / credentials means "not configured yet", not broken.
taproot init

# tailor the setup steps to the engine being configured
taproot init --kind grpc
taproot init --kind mysql|postgres|redis

# whole-install health. `doctor` alone is NOT a health check: it needs a target and
# exits non-zero without --datasource or --env+--service.
taproot --json self-check --agent
```

## First Successful Query (Happy Path)
```bash
taproot --json init
taproot --json init datasource --env qa --service orders
taproot --json creds set --ref qa:orders --user reader --password <password>
taproot --json self-check --agent --datasource qa-orders
taproot --json doctor --datasource qa-orders --connect
taproot --json query --datasource qa-orders --sql "SELECT 1 AS ok"
```

## Setup And Credentials
- Runtime self-check:
```bash
taproot --json self-check
taproot --json self-check --agent
taproot --json self-check --agent --datasource <name>
taproot --json self-check --agent --env <env> --service <service>
```

- For `init --json` and `self-check --agent --json`, read the structured records. There is no `nextActions` string array on these payloads.
```bash
# structured records with command, priority, checks, codes, reasons; sorted by ascending priority
nextActionDetails
nextActionDetails[0].command      # top action for init and doctor

# self-check --agent only: a separate top-action hint
nextCommand
```

- KB-backed datasource create/repair:
```bash
taproot --json init datasource --env <env> --service <service>
```

- Store and inspect credentials:
```bash
taproot --json creds set --ref <ref> --user <user> --password <password>
taproot --json creds show --ref <ref>
taproot --json creds unset --ref <ref>
```

- Configure and inspect connectors:
```bash
taproot --json connector setup --datasource <name> --connector <name> --ref <ref>
taproot --json connector status --datasource <name>
taproot --json connector status --datasource <name> --connector teleport --all --verbose-detail
```

## Common Commands
- Preferred order for routine query tasks:
```bash
# known datasource + explicit SQL. --reason is a ledger note, not a query source.
taproot --json query --datasource <name> --sql "<sql>" --reason "<why>"
```

- Avoid this by default:
```bash
# don't start routine reads with doctor
taproot --json doctor --datasource <name> --connect

# don't rediscover routing if datasource is already known
taproot --json datasource resolve --env <env> --service <service>
taproot --json kb resolve --service <service> --env <env>
```

- Doctor known datasource:
```bash
taproot --json doctor --datasource <name> --connect
taproot --json doctor --datasource <name> --connect --all --verbose-detail
```

- If `doctor --json` fails, read the structured records (`doctor` emits no `nextActions` array and no `nextCommand`):
```bash
# structured records with command, priority, checks, codes, reasons
nextActionDetails
nextActionDetails[0].command
```

- Resolve from env/service:
```bash
taproot --json datasource resolve --env <env> --service <service>
taproot --json kb resolve --service <service> --env <env>
taproot --json kb list-services
```

- Query explicit SQL:
```bash
taproot --json query --datasource <name> --sql "SELECT 1 AS ok"
taproot --json query --env <env> --service <service> --sql "SELECT 1 AS ok"
taproot --json query --env <env> --service <service> --allow-discovery --sql "SELECT 1 AS ok"
```

- Query timeout:
```bash
# default is 15000ms; raise only when a slower query is intentional
taproot --json query --datasource <name> --timeout 30000 --sql "SELECT 1 AS ok"
```

- Redis / Dragonfly read commands:
```bash
# register (one-time). No auth example; for AUTH add `taproot creds set --ref ... --password ...`.
# Bake proto defaults via --hint so future queries auto-decode.
taproot --json datasource add \
  --name qa-cache-redis --kind redis \
  --env qa --namespace develop --service cache-redis \
  --host my-redis.develop --port 6379 --database 0 \
  --credential-ref qa:redis:cache \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/proto/<service> \
  --hint protoMessage=<MessageName>

# health check (PING -> PONG)
taproot --json doctor --datasource qa-cache-redis

# basic reads. Pass the raw Redis command verbatim.
taproot --json query --datasource qa-cache-redis --sql "DBSIZE"
taproot --json query --datasource qa-cache-redis --sql "INFO keyspace"
taproot --json query --datasource qa-cache-redis --sql "TYPE <key>"
taproot --json query --datasource qa-cache-redis --sql "GET <key>"
taproot --json query --datasource qa-cache-redis --sql "HGETALL <key>"
taproot --json query --datasource qa-cache-redis --sql "LRANGE <key> 0 -1"
taproot --json query --datasource qa-cache-redis --sql "SCAN 0 MATCH 'prefix:*' COUNT 100"

# proto decode without baked defaults (per-query override)
taproot --json query --datasource qa-cache-redis \
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
taproot --json datasource add \
  --name qa-<svc>-grpc --kind grpc \
  --env qa --namespace develop --service <svc>-grpc \
  --host <svc>-grpc.develop --port 6565 \
  --credential-ref qa:grpc:<svc> \
  --connector openvpn --openvpn-ref vpn:work \
  --hint protoRoot=$HOME/proto/<svc>

# doctor opens channel against the first service in the proto (or --hint probeService=<fq> to override)
taproot --json doctor --datasource qa-<svc>-grpc

# discover what's callable before composing requests.
# list / find / describe read the local proto root ONLY: no network, no VPN, no creds.
# Run them before connectivity exists; only doctor and query open a channel.
taproot --json grpc list --datasource qa-<svc>-grpc                  # services + methods only
taproot --json grpc find --datasource qa-<svc>-grpc <text>            # search service/method/request/response
taproot --json grpc describe --datasource qa-<svc>-grpc \
  --service <package.Service> --method <Method>                       # expands request + response messages
# --service/--method accept a short name or unambiguous substring.

# fastest path to a working call: request body + the exact query line to run
taproot grpc describe --datasource qa-<svc>-grpc \
  --service <Service> --method <Method> --skeleton
# every grpc query also returns the called method's shape under
# meta.schemaContext.services / .messages / .enums — read that after the call
# instead of re-running describe.

# unary call. Either --request-json or --param.
taproot --json query --datasource qa-<svc>-grpc \
  --sql "<package.Service/Method>" \
  --request-json '{"value":1}'

taproot --json query --datasource qa-<svc>-grpc \
  --sql "<package.Service/Method>" \
  --param text=United

# response shape: single row, value = full message. pluck nested with:
taproot --json query --datasource qa-<svc>-grpc \
  --sql "..." --request-json '...' \
  --pluck data.rows.0.0.<field>

# example call:
taproot --json query --datasource qa-catalog-grpc \
  --sql "com.example.catalog.v1.CatalogService/getItemsByParent" \
  --request-json '{"value":1}' --pluck data.rows.0.0.items
```

- Redis writes + flushes (gated):
```bash
# enable mutate on the profile (one-time, off by default)
taproot --json datasource add --name qa-cache-redis ... --allow-mutate

# write — needs --allow-mutate at query time too
taproot --json query --datasource qa-cache-redis --sql "SET k v" --allow-mutate
taproot --json query --datasource qa-cache-redis --sql "DEL k" --allow-mutate
taproot --json query --datasource qa-cache-redis --sql "EXPIRE k 60" --allow-mutate

# FLUSH-tier requires --allow-flush IN ADDITION to --allow-mutate
taproot --json query --datasource qa-cache-redis --sql "FLUSHDB" --allow-mutate --allow-flush

# default behaviour: writes blocked
# - without --allow-mutate -> "redis command 'SET' is a mutate operation; re-run with --allow-mutate."
# - profile.allowMutate=false -> "datasource policy disallows mutate queries..."
# - FLUSHDB with only --allow-mutate -> "FLUSH-tier command 'FLUSHDB' requires --allow-flush..."
```

- MySQL/TiDB schema discovery:
```bash
taproot --json query --datasource <name> --sql "SHOW TABLES"
taproot --json query --datasource <name> --sql "SHOW TABLES FROM <database>"
taproot --json query --datasource <name> --sql "SHOW CREATE TABLE <table>"
taproot --json query --datasource <name> --sql "SHOW FULL COLUMNS FROM <table>"
```

- Cache maintenance:
```bash
taproot --json cache show
taproot --json cache prune --ttl-hours 168
```

- Session-backed repeated access:
```bash
taproot --json daemon start
taproot --json session open --datasource <name>
taproot --json session ls
```

- Learning inspection:
```bash
taproot --json learn status
taproot --json learn replay --run-id <id>
taproot --json learn refresh-schema --datasource <name>
taproot --json learn tables --datasource <name> --limit 50
taproot --json learn joins --datasource <name> --limit 50
```

- Repo safety and shell completion:
```bash
taproot --json sanitize check-repo
taproot completion zsh
taproot completion bash
taproot completion fish
```

## Output Expectations
- Prefer JSON output for automation and structured reporting.
- Read these fields first:
  - `ok`
  - `data`
  - `error.code`, `error.message`, `error.details`
  - `meta.requestId`, `meta.sessionId`, `meta.runId`
  - `resolved.source`, `resolved.accessMethod`, `resolved.target`, `resolved.database`, `resolved.engine`
  - `readiness`, `missing`, `nextCommand`, `target` from `self-check --agent`
  - `nextActions`, `nextActionDetails` from `init --json` and `self-check --agent --json`
  - `nextActions`, `nextActionDetails` from `doctor --json`

## Safety
- Keep DB operations read-only unless the user explicitly requests mutation and TapRoot policy allows it.
- Never read TapRoot’s learning, cache, or credential files directly.
- Let config decide which environments require deterministic resolution; do not assume special env names like `prod`, `stg`, or `qa`.
- Prefer canonical service names in saved artifacts; aliases from `serviceAliases` are for input normalization, not storage.
- If TapRoot is blocked, report the gap instead of falling back to direct `mysql`, `psql`, or `tsh` commands unless the user explicitly asks for that fallback.
- Prefer existing datasource/query knowledge over rediscovery. If the user already gave the datasource or query shape, use it.
- Use `doctor` for diagnosis, not as a mandatory pre-query ritual.
- For MySQL/TiDB introspection, prefer `SHOW TABLES` and `SHOW CREATE TABLE` before reaching for `information_schema`.
- Never use `LIKE`-based table discovery. Enumerate tables first and inspect exact names.
- Reserve `information_schema` queries for explicit cross-table metadata search, audits, or machine-readable bulk inspection.
