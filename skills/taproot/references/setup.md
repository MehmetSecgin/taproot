# Setup, Credentials, Operations

## Brand-new machine (nothing configured yet)
- `taproot init` creates `~/.taproot/` and prints the readiness summary and checks. On a correctly initialized but unconfigured machine every check is `ok` or `warn`, never `fail`, and the exit code is 0. `warn` on `kb_dir`, `datasources`, or `credentials` means "not configured yet", not broken. Do not treat those warns as errors or start repairing them.
- A gRPC datasource needs no `creds set` step. Run `grpc list` before `doctor`: introspection validates the proto root offline before any network access is needed.
- `taproot doctor` with no target is not a health check. It requires `--datasource <name>` or `--env <env> --service <service>` and exits non-zero without one. For whole-install health use `taproot init`.
- `readiness` reports the first unmet item and ranks `missing_kb` above datasources, so a machine with no KB reports `missing_kb` even when the KB is irrelevant. The KB is optional and only powers `--env`/`--service` routing. If datasources are addressed by name, skip it.
- `taproot init --kb-dir <dir>` saves the KB directory in TapRoot config, so shells without `TAPROOT_KB_DIR` still find it. Order: `--kb-dir`, `TAPROOT_KB_DIR`, saved `kbDir`, `<state-root>/kb`.

## Readiness payloads
- `taproot init` reports whole-install readiness; `taproot doctor --datasource <name>` checks one datasource's connectors and connection.
- A failing check carries a `code` that classifies it and a `detail` that names the cause. Decide the fix from those.
- `ok`-status checks omit the `detail` field. Only `warn` and `fail` checks carry it.

## Datasources
- `taproot init datasource --env <env> --service <service>` is the explicit KB-backed create/repair path for datasource profiles.
- When registering a new datasource, prefer `taproot datasource add --probe ...`. `--probe` runs a connect probe against the host/port/credential combo. On failure the profile stays saved and the command exits non-zero with `PROBE_FAILED: profile <name> saved, probe failed. <reason>`. Fix the cause (tunnel, credentials, proto root), then re-run the probe with `taproot doctor --datasource <name> --connect` instead of re-adding. Remove a bad profile with `taproot datasource remove <name>`. `--probe` needs credentials to already exist, so store them first.
- `--credential-ref` defaults to `--env`, so `--env qa` stores the profile under ref `qa`. Pass `--credential-ref` only when the ref differs from the env (per-service refs, tunnel refs). `datasource add` with neither flag fails with `BAD_INPUT`.
- `--ssl` is a boolean flag with no value. `--ssl true` is rejected with `error: too many arguments`.
- Every command, `datasource` included, wraps output in the `{ok,data}` envelope, so pluck and jq paths need the `data.` prefix.

## Credentials
- `taproot creds set --ref <ref> --user <u> --password <p>` stores credentials. Connector-specific keys use `--status-command`, `--connect-command`, `--disconnect-command`, `--login-command`. Teleport-style datasources take the DB user via `--db-user`.
- `taproot creds list` enumerates every saved credential ref (source plus key set, secrets redacted). Run it before guessing a ref name or registering a duplicate.
- `taproot creds show --ref <ref>` verifies a ref. Sensitive values are redacted.
- `taproot creds unset --ref <ref>` only when the user explicitly wants the ref removed.

## Connectors
- The connectors are `teleport` and `kubectl-portforward`. `init datasource` wires them from the KB; by hand, `datasource add --connector <name> --connector-ref <name>=<ref>` and then `creds set --ref <ref> --status-command "<cmd>" --connect-command "<cmd>"`.
- `taproot doctor --datasource <name>` runs each connector's status check; `--connect` also runs its connect command.

## First successful call (gRPC, no database access needed)

Steps 1 to 3 need no network, no VPN, and no credentials. Only step 4 onward touches the service.

```bash
# 1. register the endpoint. protoRoot is a LOCAL dir of .proto sources, loaded recursively.
taproot datasource add \
  --name pilot-grpc --kind grpc \
  --env qa --service profile \
  --host <host> --port <port> \
  --hint protoRoot=$HOME/repos

# 2. validate the proto root offline. Non-empty output proves protoRoot is correct.
taproot grpc list --datasource pilot-grpc

# 3. get a runnable call, request body included.
taproot grpc describe --datasource pilot-grpc \
  --service ProfileService --method GetProfile --skeleton

# 4. first call needing connectivity. Failure here with step 2 passing means network, not proto.
taproot doctor --datasource pilot-grpc

# 5. the call itself, as printed by --skeleton.
taproot query --datasource pilot-grpc \
  --query "taproot.test.ProfileService/GetProfile" \
  --request-json '{"id":"<id>"}' \
  --pluck data.rows.0.0
```

## First successful query (SQL)
```bash
taproot init
taproot init datasource --env qa --service orders
taproot creds set --ref qa:orders --user reader --password <password>
taproot doctor --datasource qa-orders --connect
taproot query --datasource qa-orders --sql "SELECT 1 AS ok"
# data.rows is positional: data.rows[i][data.columns.indexOf("ok")] === 1
```

## Smoke test against an existing Teleport datasource

The first query starts caching the datasource's table catalog in the background; a query a moment later returns the referenced table's schema:

```bash
taproot query --env prod --service order-processor --sql "SHOW CREATE TABLE order_items" --pluck meta.schemaContext.tables.order_items
```
