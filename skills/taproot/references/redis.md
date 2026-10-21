# Redis / Dragonfly

Treat `kind: redis` datasources as cache lookups, not SQL queries. There is no learned schema, no `learn ensure-schema`, and no partition checks. Redis bypasses the relational learning paths entirely.

## Querying
- Pass the raw Redis command as `--sql`, for example `--sql "GET <key>"`, `--sql "HGETALL <key>"`, `--sql "SCAN 0 COUNT 50"`, `--sql "INFO keyspace"`. Quote keys with spaces or special characters; the plugin tokenizes shell-style.
- Result shape: `data.columns = ["value"]`, one row per reply line. Multi-bulk replies (`HGETALL`, `LRANGE`, `SCAN`) produce multiple rows, alternating field and value lines for hashes. Access via `data.rows[i][0]` (positional, `data.rowsForm: "array"`).
- `taproot doctor --datasource <name>` runs `PING -> PONG` plus any wired connectors (typically `openvpn`).

## Command tiers (self-gated)
Redis classifies commands into three tiers and gates itself, because the shared SQL safety regex does not understand Redis verbs.
- `read` (GET, HGETALL, LRANGE, SCAN, INFO, ...) runs by default.
- `mutate` (SET, DEL, EXPIRE, RENAME, HSET, LPUSH, SADD, ZADD, XADD, INCR, ...) requires `--allow-mutate` at query time AND `datasource.policy.allowMutate=true` on the profile.
- `flush` (FLUSHDB, FLUSHALL, SWAPDB, MIGRATE) requires `--allow-flush` on top of both.
- Unknown commands are rejected. Never bypass with direct `redis-cli`.

Default policy on `datasource add` is read-only (`allowMutate=false`). To enable writes, re-run `taproot datasource add --name <same> ... --allow-mutate`; the same flag flips the policy. Default to read-only for unattended and agent workflows. Only request mutate or flush when the user explicitly authorizes destructive work and confirms the target env. Do not enable mutate on production Redis.

## Protobuf payloads
- Many services store serialized protobuf in Redis/Dragonfly. Pass `--proto <Message> --proto-root <dir>` to decode. The plugin runs `redis-cli --no-raw`, parses the quoted bytes, and decodes via `protobufjs`. `--proto-root` is loaded recursively, so point it at the service's `.proto` source tree.
- Decoded rows carry the message object as `value`. Non-binary replies (SCAN keys, `(nil)`, integers, INFO blocks) fall through as text via a printable-ASCII heuristic, so one datasource serves both decoded GETs and plain SCANs.
- Bake per-datasource defaults with `taproot datasource add ... --hint protoRoot=<dir> --hint protoMessage=<Message>` so later queries need no flags. To find the message name, grep the service for its Redis serializer config.
- Payloads without a configured `--proto` pass through as raw bytes. If a binary cell shows up in output, add `--proto` rather than interpreting bytes by eye.

## Registration
- Discovery (`taproot discover kb|kubectl|teleport`) does not propose Redis datasources yet. Register them with `taproot datasource add --kind redis ...` or hand-edit the profile. Wire `--connector openvpn --openvpn-ref vpn:work` for cluster-DNS hosts on QA.
- No-auth Redis: leave the cred ref unset; TapRoot reads an empty cred map fine. For AUTH or ACL, set `password` (and optionally `user`) via `taproot creds set --ref <ref>`.
- TLS: pass `--ssl` (a boolean flag, no value) on `taproot datasource add` to add `--tls` to the `redis-cli` invocation. `--ssl true` is rejected with `error: too many arguments`.
