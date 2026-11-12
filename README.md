# TapRoot

CLI for querying MySQL/TiDB, Redis and gRPC datasources. Every command prints one line of JSON. Learn commands with `taproot --help` and `taproot <command> --help`.

## Install

Requires Node.js 20 or later. Install only the clients your datasources use: `redis-cli` (redis), `tsh` (teleport-mysql), `kubectl` (port-forwarded datasources).

```bash
git clone https://github.com/MehmetSecgin/taproot.git
cd taproot
npm ci
npm run build
npm link
taproot init
```

`taproot init` creates `~/.taproot/` and prints readiness checks. Rerun it any time.

Credentials go to the OS keychain through the optional `keytar` dependency. If `keytar` did not build, they go to an encrypted file under `~/.taproot/config/` instead; npm versions that gate install scripts build it only after `npm approve-scripts keytar` and a reinstall.

| Variable | Effect | Default |
|---|---|---|
| `TAPROOT_STATE_ROOT` | State directory | `~/.taproot` |
| `TAPROOT_MASTER_KEY` | Key for the encrypted credentials file | derived from `$USER` |
| `TAPROOT_NO_KEYCHAIN` | Use the encrypted file even when the keychain works | unset |
| `TAPROOT_CATALOG_TTL_HOURS` | Hours a cached schema catalog stays fresh | `24` |
| `TAPROOT_CATALOG_TIMEOUT_MS` | Timeout of one schema catalog fetch | `20000` |
| `TAPROOT_MAX_RANGE_DAYS` | Widest date range before a range warning | `90` |
| `TAPROOT_ALLOW_PARTITION_SCAN` | `1` allows partition scans on every query | unset |
| `TAPROOT_QA_CONTEXT` | kubectl context for `qa-portforward` | the env name |
| `TAPROOT_QA_LOCAL_PORT` | Local port for every `qa-portforward` profile | one port in 20000-29999 per env, namespace and service |

## Agent skill

`skills/taproot/` holds the rules agents follow when using TapRoot. For Claude Code:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/taproot" ~/.claude/skills/taproot
```

## First query

```bash
taproot datasource add --name dev-orders --kind mysql --env dev --service orders \
  --host 127.0.0.1 --port 3306 --database orders
taproot creds set --ref dev --user reader --password '***'
taproot query --datasource dev-orders --sql "SELECT id, status FROM orders LIMIT 3"
```

`--credential-ref` defaults to `--env`, so the profile above reads the `dev` ref.

### Teleport

```bash
taproot creds set --ref tsh:work --status-command "tsh status" \
  --login-command "tsh login --proxy <proxy> --auth <connector>"
taproot creds set --ref prod:analytics --db-user analytics_reader
taproot datasource add --name prod-analytics --kind teleport-mysql --env prod --service analytics \
  --credential-ref prod:analytics --database analytics --target <teleport-db-name> \
  --connector teleport --teleport-ref tsh:work
```

## Knowledge base

With a KB, `taproot init datasource --env <env> --service <service>` creates the profile for you. Save the KB directory once with `taproot init --kb-dir <path>`. It must hold a `services.json`:

```json
[
  {
    "service": "orders",
    "connections": [
      {
        "env": "dev",
        "engine": "mysql",
        "host": "127.0.0.1",
        "port": 3306,
        "database": "orders",
        "db_user": "reader",
        "access_method": "native"
      }
    ]
  }
]
```

`access_method` is `native`, `tsh` or `qa-portforward`. Queries use an existing datasource profile over the KB; `init datasource` rewrites a profile that conflicts with it.

## License

[MIT](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
