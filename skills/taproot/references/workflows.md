# TapRoot Workflows

## Config
- Runtime config lives at `~/.taproot/config/deterministic-config.json`.
- Use `environmentPolicies` to define which envs are deterministic, discovery-friendly, and which access methods/targets are preferred.
- Use `serviceAliases` to normalize legacy service names to canonical TapRoot service names.

## First Successful Query (Happy Path)
```bash
taproot --json init
taproot --json init datasource --env qa --service orders
taproot --json creds set --ref qa:orders --user reader --password <password>
taproot --json self-check --agent --datasource qa-orders
taproot --json doctor --datasource qa-orders --connect
taproot --json query --datasource qa-orders --query "SELECT 1 AS ok"
```

## Setup And Credentials
- Runtime self-check:
```bash
taproot --json self-check
taproot --json self-check --agent
taproot --json self-check --agent --datasource <name>
taproot --json self-check --agent --env <env> --service <service>
```

- For `init --json` and `self-check --agent --json`, read both:
```bash
# ordered compatibility list
nextActions

# structured records with command, priority, checks, codes, reasons
nextActionDetails
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
# 1) known datasource + known intent
taproot --json query --datasource <name> --intent "<intent>" --param key=value

# 2) known datasource + saved template
taproot --json query --datasource <name> --template <id> --param key=value

# 3) explicit SQL only when no reusable intent/template exists
taproot --json query --datasource <name> --query "<sql>"
```

- Avoid this by default:
```bash
# don't start routine reads with doctor
taproot --json doctor --datasource <name> --connect

# don't rediscover routing if datasource is already known
taproot --json datasource resolve --env <env> --service <service>
taproot --json kb resolve-connection --service <service> --env <env>
```

- Doctor known datasource:
```bash
taproot --json doctor --datasource <name> --connect
taproot --json doctor --datasource <name> --connect --all --verbose-detail
```

- If `doctor --json` fails, read both:
```bash
# ordered compatibility list
nextActions

# structured records with command, priority, checks, codes, reasons
nextActionDetails
```

- Resolve from env/service:
```bash
taproot --json datasource resolve --env <env> --service <service>
taproot --json kb resolve-connection --service <service> --env <env>
taproot --json kb list-services
```

- Query explicit SQL:
```bash
taproot --json query --datasource <name> --query "SELECT 1 AS ok"
taproot --json query --env <env> --service <service> --query "SELECT 1 AS ok"
taproot --json query --env <env> --service <service> --allow-discovery --query "SELECT 1 AS ok"
```

- Query timeout:
```bash
# default is 5000ms; raise only when a slower query is intentional
taproot --json query --datasource <name> --timeout-ms 5000 --query "SELECT 1 AS ok"
```

- MySQL/TiDB schema discovery:
```bash
taproot --json query --datasource <name> --query "SHOW TABLES"
taproot --json query --datasource <name> --query "SHOW TABLES FROM <database>"
taproot --json query --datasource <name> --query "SHOW CREATE TABLE <table>"
taproot --json query --datasource <name> --query "SHOW FULL COLUMNS FROM <table>"
```

- Query by intent:
```bash
taproot --json query --datasource <name> --intent "latest rows" --param id=42
taproot --json cache resolve-query --service <service> --intent "latest rows"
```

- Query by saved template:
```bash
taproot --json query --datasource <name> --template <id> --param id=42
taproot --json template run --id <id> --param id=42
```

- Template management:
```bash
taproot --json template list
taproot --json template validate --id <id>
taproot --json template save --id <id> --intent "latest rows" --query "SELECT * FROM sample WHERE id = :id"
```

- Explicit cache operations:
```bash
taproot --json cache lookup-target --env <env> --service <service> --intent "latest rows"
taproot --json cache save-target --env <env> --service <service> --intent "latest rows" --engine tidb --target <target> --database <database>
taproot --json cache save-query --service <service> --intent "latest rows" --sql-template "SELECT * FROM sample WHERE id = :id"
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
taproot --json learn shapes --datasource <name> --limit 50
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
- Prefer `query --intent` and `query --template` before writing raw SQL.
- Use `doctor` for diagnosis, not as a mandatory pre-query ritual.
- For MySQL/TiDB introspection, prefer `SHOW TABLES` and `SHOW CREATE TABLE` before reaching for `information_schema`.
- Never use `LIKE`-based table discovery. Enumerate tables first and inspect exact names.
- Reserve `information_schema` queries for explicit cross-table metadata search, audits, or machine-readable bulk inspection.
