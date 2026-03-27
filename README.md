# TapRoot

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
- `taproot init` and `taproot init datasource --env <env> --service <service>`
- `taproot self-check` or `taproot self-check --agent [--datasource <name> | --env <env> --service <service>]`
- `taproot doctor --datasource <name>` or `--env --service` (`--connect` to run connector login/connect actions, `--all` for full check list)
- `taproot query --datasource <name> [--query | --template | --intent] [--param k=v] [--allow-discovery]`
- `taproot datasource <list|show|add|remove|resolve>`
- `taproot connector <setup|status>`
- `taproot template <list|save|validate|run>`
- `taproot kb <resolve-connection|resolve-credentials|resolve-database-name|resolve-query|tables|related|list-services>`
- `taproot cache <show|prune|clear>`
- `taproot learn <status|compact|replay|refresh-schema|tables|joins|shapes>`
- `taproot creds <set|show|unset>`
- `taproot daemon <start|status|stop|restart>`
- `taproot session <open|ls|inspect|close|close-all>`
- `taproot completion <zsh|bash|fish>`
- `taproot sanitize check-repo`

## Quickstart
```bash
npm ci
npm run build

# initialize local runtime state and starter config
node dist/index.js --json init

# create or repair a KB-backed datasource profile
node dist/index.js --json init datasource --env production --service sample

# store datasource credentials under the standard ref
node dist/index.js --json creds set --ref production:sample --user sample_reader --password '***'

# agent-facing readiness check for the specific datasource/query path
node dist/index.js --json self-check --agent --env production --service sample

# preflight checks
node dist/index.js --json doctor --datasource production-sample --connect

# execute read query
node dist/index.js --json query --datasource production-sample --query \"SELECT 1 AS ok\"
```

## Agent-Facing Diagnostics

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

For deeper diagnosis, use:

```bash
taproot --json doctor --datasource <name>
taproot --json doctor --datasource <name> --connect
```

`doctor --json` now returns both:

- `nextActions`: ordered command strings for compatibility
- `nextActionDetails`: structured remediation entries with `command`, `priority`, `checks`, `codes`, and `reasons`

`init --json` and `self-check --agent --json` now expose the same `nextActionDetails` shape for readiness/setup guidance, while keeping `nextActions` and `nextCommand` for compatibility.

## OpenVPN + Teleport setup
```bash
# connector credential refs (local encrypted state, not repository files)
node dist/index.js creds set --ref vpn:work --status-command "openvpn3 sessions-list" --connect-command "openvpn3 session-start --config /absolute/path/to/profile.ovpn"
node dist/index.js creds set --ref tsh:work --status-command "tsh status" --login-command "tsh login --proxy your.teleport.proxy --auth your-sso"
node dist/index.js creds set --ref production:analytics --db-user analytics_reader

# datasource using teleport mysql executor + connectors
node dist/index.js datasource add \
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

node dist/index.js doctor --datasource production-analytics
node dist/index.js query --datasource production-analytics --query "SELECT COUNT(*) AS row_count FROM sample_records WHERE record_id = 12345;"
```

## Build
```bash
npm ci
npm run build
npm test
```

## State
Default runtime state path:
- `~/.taproot/`

Expected structure:
- `config/` (datasources/templates/credentials)
- `cache/`
- `runs/`
- `learning/`

## Notes
- Built-in DB plugins only expose `executeRead` in v1.
- `prod` defaults to deterministic no-guess datasource resolution (profile/KB); use `--allow-discovery` only when explicitly needed.
- Mutating queries require `--allow-mutate` **and** datasource policy with `executeMutate`.
- `taproot init datasource --env <env> --service <service>` is the explicit KB-backed create/repair path for stale datasource profiles.
- `taproot self-check --agent` is the preferred machine-readable readiness contract, especially with `--datasource` or `--env` + `--service`.
- `taproot doctor --json` returns structured remediation metadata in `nextActionDetails` in addition to the legacy `nextActions` string list.
- `taproot init --json` and `taproot self-check --agent --json` now return structured readiness remediation in `nextActionDetails` too.
- Secrets are never printed and are redacted from JSON output envelopes.
- Learning uses deterministic local caches (`resolution-cache`, `query-library`, `query-stats`) and excludes secret values.
- Connection commands for connectors are provided via local credential refs (`--connect-command`, `--login-command`) and never committed to repo by default.
- Credentials contain auth/connector material; connection topology (`host`, `port`, `database`, `target`) lives in datasource profiles.
- `taprootd`/`session` commands are available for Phase 1 runtime scaffolding.
- Human mode uses compact progress on stderr; structured data stays on stdout.
- Use global `--verbose` for step-by-step diagnostics (also on stderr).
- Learning contract: `references/learning-contract.md`
- Runtime architecture: `references/runtime-architecture.md`
- Phase 1 runtime contract: `references/phase1-runtime-contract.md`
