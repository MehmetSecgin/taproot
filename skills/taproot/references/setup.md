# Setup, Credentials, Operations

## Brand-new machine (nothing configured yet)
- `taproot init` creates `~/.taproot/` and prints the readiness summary plus an ordered `next actions` list. On a correctly initialized but unconfigured machine every check is `ok` or `warn`, never `fail`, and the exit code is 0. `warn` on `kb_dir`, `datasources`, or `credentials` means "not configured yet", not broken. Do not treat those warns as errors or start repairing them.
- Pass `--kind mysql|postgres|redis|grpc` to tailor the setup steps to the engine being configured, for example `taproot init --kind grpc`. Each emitted action is a complete, runnable command with every required flag. Fill in the `<placeholders>` and run them in the order given. The list shrinks as steps complete, so re-run `init` (or `self-check`) to see what remains.
- The gRPC chain deliberately has no `creds set` step and adds `grpc list` before `doctor`, because introspection validates the proto root offline before any network access is needed.
- `taproot doctor` with no target is not a health check. It requires `--datasource <name>` or `--env <env> --service <service>` and exits non-zero without one. For whole-install health use `taproot init` or `taproot self-check --agent`.
- `readiness` reports the first unmet item and ranks `missing_kb` above datasources, so a machine with no KB reports `missing_kb` even when the KB is irrelevant. The KB is optional and only powers `--env`/`--service` routing. If datasources are addressed by name, skip it and read `nextActionDetails` for the real sequence.
- `taproot init --kb-dir <dir>` saves the KB directory in TapRoot config, so shells without `TAPROOT_KB_DIR` still find it. Order: `--kb-dir`, `TAPROOT_KB_DIR`, saved `kbDir`, `<state-root>/kb`.

## Readiness payloads
- `taproot self-check --agent` is the machine-readable readiness check. Prefer targeted runs with `--datasource <name>` or `--env <env> --service <service>` when checking a real query path.
- `nextActionDetails` carries remediation on `init`, `self-check --agent`, and `doctor`. Each entry has `command`, `priority`, `reasons`, `checks`, `codes`, sorted by ascending `priority` (lowest number first). There is no `nextActions` string array on these payloads.
- `nextCommand` is emitted by `self-check --agent` only, not by `init` or `doctor`. Use `nextActionDetails[0].command` for the top action on those two.
- `ok`-status checks omit the `detail` field. Only `warn` and `fail` checks carry it.
- `taproot self-check` (without `--agent`) validates the runtime environment before debugging higher-level failures.

## Datasources
- `taproot init datasource --env <env> --service <service>` is the explicit KB-backed create/repair path for datasource profiles.
- When registering a new datasource, prefer `taproot datasource add --probe ...`. `--probe` runs a connect probe against the host/port/credential combo. On failure the profile stays saved and the command exits non-zero with `PROBE_FAILED: profile <name> saved, probe failed. <reason>`. Fix the cause (tunnel, credentials, proto root), then re-run the probe with `taproot doctor --datasource <name> --connect` instead of re-adding. Remove a bad profile with `taproot datasource remove <name>`. `--probe` needs credentials to already exist, so store them first.
- `--credential-ref` defaults to `--env`, so `--env qa` stores the profile under ref `qa`. Pass `--credential-ref` only when the ref differs from the env (per-service refs, tunnel refs). `datasource add` with neither flag fails with `BAD_INPUT`.
- `--ssl` is a boolean flag with no value. `--ssl true` is rejected with `error: too many arguments`.
- `datasource list/show/add/resolve/remove/import/export` wrap output in the `{ok,data}` envelope, so pluck and jq paths need the `data.` prefix.

## Credentials
- `taproot creds set --ref <ref> --user <u> --password <p>` stores credentials. Connector-specific keys use `--status-command`, `--connect-command`, `--disconnect-command`, `--login-command`. Teleport-style datasources take the DB user via `--db-user`.
- `taproot creds list` enumerates every saved credential ref (source plus key set, secrets redacted). Run it before guessing a ref name or registering a duplicate.
- `taproot creds show --ref <ref>` verifies a ref. Sensitive values are redacted.
- `taproot creds unset --ref <ref>` only when the user explicitly wants the ref removed.
- `taproot creds migrate-to-fallback` moves every keychain-stored credential into the encrypted fallback file and deletes the keychain copy. This stops macOS keychain ACL prompts on rebuilt binaries. Set `TAPROOT_NO_KEYCHAIN=1` afterwards to keep new creds out of the keychain too.

## Connectors
- `taproot connector setup --datasource <name> --connector <name> --ref <ref>` wires a connector to a datasource.
- `taproot connector status --datasource <name>` checks connector health. Add `--connector <name>` to filter to one connector.

## Operations
- `taproot sanitize check-repo` scans tracked files for leaked secrets before committing or sharing the repo.
- `taproot completion zsh|bash|fish` prints or installs shell completion.
- `taproot config snapshot|list|status|diff|restore|prune` versions the local config. Snapshot a known-good state before risky config edits.

## First successful call (gRPC, no database access needed)

Steps 1 to 3 need no network, no VPN, and no credentials. Only step 4 onward touches the service.

```bash
taproot init --kind grpc                     # prints this sequence as next actions

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
  --sql "taproot.test.ProfileService/GetProfile" \
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

Cache read only, no `SHOW CREATE`, no DDL on the wire:

```bash
taproot daemon start
taproot learn ensure-schema --env prod --service order-processor
taproot learn ensure-schema --env prod --service order-processor | jq '.tables[] | select(.table=="order_items")'
```
