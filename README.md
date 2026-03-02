# Telequery

Extensive Node/TypeScript CLI for deterministic querying across plugin-backed datasources.

v1 ships DB plugins (`mysql`, `postgres`) and connector/executor adapters for `openvpn`, `teleport`, `teleport-mysql`, while architecture supports any queryable backend (redis, kafka, rabbitmq, loki, k8s, etc.) via plugin modules.

## Principles
- Datasource-centric UX.
- Plugin-native query syntax + intent/template layer.
- Operator mode with explicit mutation gates.
- Agent-safe secrets and minimal output exposure.
- Self-learning/documenting local runtime.
- Reuse-first: prefer preexisting tools/libs over custom reinvention.

## Commands
- `telequery self-check`
- `telequery doctor --datasource <name>` or `--env --service` (`--connect` to run connector login/connect actions)
- `telequery query --datasource <name> [--query | --template | --intent] [--param k=v]`
- `telequery datasource <list|show|add|remove|resolve>`
- `telequery template <list|save|validate|run>`
- `telequery kb <resolve-connection|resolve-credentials|resolve-database-name|resolve-query|tables|related>`
- `telequery cache <show|prune|clear>`
- `telequery learn <status|compact|replay>`
- `telequery creds <set|show|unset>`
- `telequery completion <zsh|bash|fish>`
- `telequery sanitize check-repo`

## Quickstart
```bash
npm ci
npm run build

# store credentials under a reference key
node dist/index.js creds set --ref prod:orders --user sample_reader --password '***'

# create datasource profile
node dist/index.js datasource add --name prod-orders --kind mysql --env prod --service orders --credential-ref prod:orders --host db.internal.example --port 3306 --database orders

# preflight checks
node dist/index.js doctor --datasource prod-orders

# execute read query
node dist/index.js query --datasource prod-orders --query \"SELECT 1 AS ok\"
```

## OpenVPN + Teleport setup
```bash
# connector credential refs (local encrypted state, not repository files)
node dist/index.js creds set --ref vpn:work --status-command "openvpn3 sessions-list" --connect-command "openvpn3 session-start --config /absolute/path/to/profile.ovpn"
node dist/index.js creds set --ref tsh:work --status-command "tsh status" --login-command "tsh login --proxy your.teleport.proxy --auth your-sso"
node dist/index.js creds set --ref prod:events --db-user analytics_reader

# datasource using teleport mysql executor + connectors
node dist/index.js datasource add \
  --name prod-events \
  --kind teleport-mysql \
  --env prod \
  --service events \
  --credential-ref prod:events \
  --database events \
  --target primary-tidb \
  --connector openvpn \
  --connector teleport \
  --connector-ref openvpn=vpn:work \
  --connector-ref teleport=tsh:work

node dist/index.js doctor --datasource prod-events
node dist/index.js query --datasource prod-events --query "SELECT COUNT(*) AS row_count FROM sample_records WHERE event_id = 12345;"
```

## Build
```bash
npm ci
npm run build
npm test
```

## State
Default runtime state path:
- `~/.telequery/`

Expected structure:
- `config/` (datasources/templates/credentials)
- `cache/`
- `runs/`
- `learning/`

## Notes
- Built-in DB plugins only expose `executeRead` in v1.
- Mutating queries require `--allow-mutate` **and** datasource policy with `executeMutate`.
- Secrets are never printed and are redacted from JSON output envelopes.
- Learning uses deterministic local caches (`resolution-cache`, `query-library`, `query-stats`) and excludes secret values.
- Connection commands for connectors are provided via local credential refs (`--connect-command`, `--login-command`) and never committed to repo by default.
- Credentials contain auth/connector material; connection topology (`host`, `port`, `database`, `target`) lives in datasource profiles.
- Learning contract: `references/learning-contract.md`
- Runtime architecture: `references/runtime-architecture.md`
