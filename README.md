# TapRoot

Node/TypeScript CLI for deterministic querying across plugin-backed datasources.

v1 ships DB plugins (`mysql`, `postgres`) and connector/executor adapters for `openvpn`, `teleport`, `teleport-mysql`, while architecture supports any queryable backend (redis, kafka, rabbitmq, loki, k8s, etc.) via plugin modules.

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
taproot --version   # 0.2.0
```

> No npm registry release yet. `npm link` is the supported install path.

### 3. First run — interactive onboarding

```bash
taproot onboard
```

`onboard` is the recommended first command. It:

1. Creates `~/.taproot/` state (config, cache, runs, learning).
2. Detects local tools (`kubectl`, `tsh`, `openvpn3`, keychain).
3. Optionally asks for an env/service target and creates a datasource:
   - From your KB if present (see [Knowledge base](#knowledge-base) below), or
   - From answers to a small interactive prompt (`native` / `qa-portforward` / `tsh` mode).
4. Runs a final readiness check.

Non-interactive form (CI / agents):

```bash
taproot --json onboard --yes-local --yes-access --yes-live --env <env> --service <service>
```

### 4. Add credentials and query

```bash
# store datasource credentials under the standard ref
taproot creds set --ref <env>:<service> --user <user> --password '***'

# preflight
taproot doctor --datasource <env>-<service> --connect

# read query
taproot query --datasource <env>-<service> --query "SELECT 1 AS ok"
```

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `TAPROOT_STATE_ROOT` | Override state directory | `~/.taproot` |
| `TAPROOT_MASTER_KEY` | Symmetric key for the encrypted credential fallback file. **Set this for portable, deterministic secrets.** | derived from `$USER@$platform` |
| `TAPROOT_NO_KEYCHAIN` | Force the encrypted file even when `keytar` is available | unset |
| `OBSIDIAN_MEMORY_ROOT` | Override KB root | `~/memory-root` or `~/.codex/memory` |
| `TAPROOT_QA_CONTEXT` | Default `kubectl` context for `qa-portforward` | env-name |
| `TAPROOT_QA_LOCAL_PORT` | Default local port for `qa-portforward` | `4406` |
| `TAPROOT_DATETIME_FORMAT` | Render Date columns as `iso` / `js` / `epoch` | `iso` |
| `TAPROOT_LOG_LEVEL` | pino log level | `info` |
| `TAPROOT_ALLOW_SCHEMA_INTROSPECTION` | Allow heavy introspection queries | unset (gated) |
| `TAPROOT_ALLOW_PARTITION_SCAN` | Allow partition scans | unset (gated) |

---

## Knowledge base

TapRoot can auto-create datasources from a local KB at:

```
$OBSIDIAN_MEMORY_ROOT/domains/engineering/references/db-kb/
  services.json
  ...
```

If you do not have a KB, `taproot onboard` falls back to interactive manual datasource entry. Skip this section if you do not use one.

---

## Commands
- `taproot onboard` — interactive first-run wizard
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
