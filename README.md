# TapRoot

CLI for querying MySQL/TiDB, Redis and gRPC datasources. Every command prints one line of JSON. Learn commands with `taproot --help` and `taproot <command> --help`.

## Install

Requires Node.js 20 or later. Install only the clients your datasources use: `redis-cli` (redis), `tsh` (teleport-mysql), `kubectl` (port-forwarded datasources).

```bash
git clone https://github.com/MehmetSecgin/taproot.git
cd taproot
npm ci
npm link
taproot init
```

`taproot init` creates `~/.taproot/` and prints readiness checks. Rerun it any time.

Credentials go to the OS keychain through the optional `keytar` dependency. If `keytar` did not build, they go to an encrypted file under `~/.taproot/config/` instead.

| Variable | Effect | Default |
|---|---|---|
| `TAPROOT_STATE_ROOT` | State directory | `~/.taproot` |
| `TAPROOT_MASTER_KEY` | Key for the encrypted credentials file | derived from `$USER` |
| `TAPROOT_NO_KEYCHAIN` | Use the encrypted file even when the keychain works | unset |
| `TAPROOT_CATALOG_TTL_HOURS` | Hours a cached schema catalog stays fresh | `24` |
| `TAPROOT_CATALOG_TIMEOUT_MS` | Timeout of one schema catalog fetch | `20000` |
| `TAPROOT_MAX_RANGE_DAYS` | Widest date range before a range warning | `90` |
| `TAPROOT_ALLOW_PARTITION_SCAN` | `1` allows partition scans on every query | unset |
| `TAPROOT_CONFINE_TO_DATABASE` | `1` confines every SQL datasource to its `--database` | unset |

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

### Confine SQL datasources to their schema

On a server that holds many schemas, `TAPROOT_CONFINE_TO_DATABASE=1` limits every mysql and teleport-mysql datasource to the schema in its `--database`. Before a query runs, TapRoot parses it and refuses with `DATABASE_CONFINED` any statement that names another schema, in joins, subqueries, CTEs, `UNION`, `EXPLAIN`, `DESCRIBE` and the `SHOW` forms that take a schema. Its tables may be bare or qualified with the exact spelling of the datasource's schema. `schema` answers from the catalog of that schema alone.

- The system schemas count as other schemas, and so does `SHOW DATABASES`. TapRoot's own catalog reads still run.
- It refuses what it cannot check: statements it cannot parse, executable comments (`/*! */`, `/*T! */`), `--` with no ASCII space after it, backslashes (escape `LIKE` wildcards with `ESCAPE '!'`), sequence functions, `USE`, `SET`, and `SHOW` forms other than `TABLES`, `TABLE STATUS`, `COLUMNS`, `INDEX` and `CREATE TABLE`/`VIEW`, which may carry `LIKE` but not `WHERE`.
- A SQL datasource with no `--database` refuses every query.
- The process that runs the query reads the variable: the daemon, which `taproot` starts on its first query. Restart it with `taproot daemon stop` after changing the variable.

The check is parser-based, and the server follows views and routines of the confined schema wherever they lead. A database user granted only that schema is the hard limit.

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

`access_method` is `native`, `tsh` or `kubectl-portforward`. `kubectl-portforward` uses the connection's `k8s_context` as the kubectl context, or the env name when it is unset, and gives each env, namespace and service its own local port in 20000-29999. Queries use an existing datasource profile over the KB; `init datasource` rewrites a profile that conflicts with it.

## Build your own daemon or CLI

`taproot` and `taprootd` are assembled from the package's public entry points: `/core`, `/daemon`, `/cli` and one `/plugins/<kind>` per plugin. Install a tag with `npm install github:MehmetSecgin/taproot#<tag>`; the `prepare` script builds it. npm versions that gate dependency install scripts need the installing project's `package.json` to allow them:

```json
"allowScripts": { "github:MehmetSecgin/taproot#<tag>": true, "keytar": true, "protobufjs": false }
```

TapRoot is keyed by the same spec as in `dependencies`. `keytar` builds the OS keychain module, which `useKeychain: false` does without. The `protobufjs` script only prints a version warning.

A daemon that serves MySQL datasources over mutual TLS 1.3, rereading its certificates every 30 seconds:

```js
import { buildContext } from '@mehmetsecgin/taproot/core';
import { datasourceListMethod, queryMethod, schemaMethod, startDaemon } from '@mehmetsecgin/taproot/daemon';
import { mysqlPlugin } from '@mehmetsecgin/taproot/plugins/mysql';

await startDaemon({
  ctx: buildContext({ plugins: [mysqlPlugin], useKeychain: false }),
  listen: { kind: 'tls', host: '0.0.0.0', port: 7443, tls: { caFile: 'ca.crt', certFile: 'daemon.crt', keyFile: 'daemon.key' }, reloadMs: 30_000 },
  methods: [
    datasourceListMethod({ columns: ['name', 'kind', 'env', 'service'], filter: (profile) => profile.env !== 'prod' }),
    schemaMethod(),
    queryMethod({ shapeRequest: (request) => ({ ...request, allowMutate: false, maxRows: 1000 }) }),
  ],
  checkDatasource: async ({ datasource }) => {
    if (datasource.env === 'prod') throw new Error(`'${datasource.name}' is not served here.`);
  },
  checkDatasourceTtlMs: 10 * 60_000,
  log: (event) => console.log(JSON.stringify(event)),
});
```

`useKeychain: false` reads credentials only from the encrypted file under `TAPROOT_STATE_ROOT`. Fill that state root with the stock CLI (`taproot datasource add`, `taproot creds set`), run with the daemon's `TAPROOT_STATE_ROOT` and `TAPROOT_MASTER_KEY` and with `TAPROOT_NO_KEYCHAIN=1`.

`checkDatasource` vets each datasource before a query or schema read first uses it, again when its profile or credentials change, again `checkDatasourceTtlMs` after it passed, and again after it failed. It is cut off after the `timeoutMs` it is given, and its `signal` aborts then. A refusal reaches the client as `DATASOURCE_REFUSED`, unless the check throws a `TaprootError` or a system error with a `code`, such as a connection failure. `datasourceListMethod` returns only the columns it is given (`DATASOURCE_COLUMNS` holds them all) and only the profiles its `filter` keeps; the filter hides a profile, `checkDatasource` refuses it. `queryMethod({ shapeRequest })` gets each request with its defaults applied and returns the one to run. `maxRows` caps the rows: the mysql plugins stop reading at the cap, and the reply carries `truncated: true` when rows were cut.

`log` receives one object per event: `tlsReload`, `tlsClientError`, `requestFailed` (with code, message, request id, duration and peer) and `requestDropped`. `startDaemon` stops the daemon and exits the process on SIGINT and SIGTERM. A client must run the daemon's TapRoot version; another version gets `DAEMON_VERSION_MISMATCH`. The `unix` listen kind is `taprootd`'s transport: it exits after 30 idle minutes and stops when a client of another version calls, so the next `taproot` call starts a matching one.

A CLI for that daemon:

```js
import { buildCli, datasourceListCommand, queryCommandWith, remoteExecutor, schemaCommand } from '@mehmetsecgin/taproot/cli';

await buildCli({
  name: 'orders-cli',
  description: 'Read the orders databases.',
  commands: [datasourceListCommand, schemaCommand, queryCommandWith({ flags: ['datasource', 'sql', 'timeout'] })],
  executor: remoteExecutor({ host: 'daemon.example.com', port: 7443, tls: { caFile: 'ca.crt', certFile: 'client.crt', keyFile: 'client.key' } }),
}).run(process.argv);
```

`queryCommandWith({ flags })` offers only the given flags of `query`; `QUERY_FLAGS` holds them all, and `queryCommand` offers every one. Without `--timeout`, a remote query runs with the CLI's default, `TAPROOT_QUERY_TIMEOUT_MS` on the client. `localExecutor` and the other commands `/cli` exports are what `taproot` is built from: they work on the machine's own state root and start `taprootd`.

`node_modules/@mehmetsecgin/taproot/scripts/make-mtls-certs.sh <dir> IP:127.0.0.1` writes a CA plus daemon and client certificates for trying it out.

## License

[MIT](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
