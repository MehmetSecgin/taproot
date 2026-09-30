# gRPC

Treat `kind: grpc` datasources as RPC endpoints, not databases. Unary, server-streaming, client-streaming, and bidi methods are all callable. A streaming call is a batch: TapRoot sends every request message, half-closes, and collects every response before it returns. Persistent learning for calls is deferred.

## Introspection is offline
`grpc list`, `grpc find`, and `grpc describe` read the local proto root only. They need no network, no VPN, no running server, and no credentials. Use them to explore an API and build a request before connectivity exists. Only `doctor` and `query` open a channel.

When a gRPC call fails, first establish which half is broken: if introspection also fails it is a proto problem, if introspection works and `doctor` fails it is connectivity. Do not guess.

## Commands
- `taproot grpc list --datasource <name>` is a compact services-plus-methods table, no message expansion. Add a substring to filter methods.
- `taproot grpc find --datasource <name> <text>` searches across service, method, request, and response names. Ambiguous input returns candidate suggestions rather than a guess.
- `taproot grpc describe --datasource <name>` lists every service and rpc and expands request/response messages (fields, types, repeated/optional/oneof, enums). Flags: `--service <fq>` to scope, `--method <name>` to scope expansion further, `--max-depth <n>` for transitive expansion (default 4).
- `--service` and `--method` accept a short name or an unambiguous substring, so `--service ProfileService` works without the package.
- `--skeleton` is the fastest path to a working call: `taproot grpc describe --datasource <name> --service <s> --method <m> --skeleton` emits a filled request body plus the exact `taproot query` command to run. Prefer it over hand-writing `--request-json`.
- All of these honor `--proto-root <dir>` when no datasource is registered yet.

## Calling
- Query syntax: `--query "<fully.qualified.package.Service/Method>"`, mirroring `grpcurl`. The slash separates service from method, and method casing must match the `.proto` rpc declaration.
- Request payload: full JSON via `--request-json '{...}'` (takes precedence), or built from `--param key=value` pairs (numeric strings become numbers, `true`/`false` become bools, everything else stays string). The shape must match the request message exactly. Use `grpc describe` rather than grepping `.proto` by hand.
- Streaming request: for a client-streaming or bidi method, pass a JSON array in `--request-json`, one element per message. A single object is sent as a one-message stream. An array on a unary or server-streaming method is `BAD_INPUT`. Validation errors name the element: `request[2]: unknown field ...` with `field: [2].<name>`. `grpc describe --skeleton` emits the array form for these methods.
- Stream limits: at most 1000 request messages per call (`BAD_INPUT` above it). A response stream stops at 1000 messages and adds a warning. `TAPROOT_GRPC_STREAM_MESSAGE_LIMIT` changes both. `--timeout` covers the whole stream.
- Stream failure: if the server fails the stream, the query fails. `error.details.stream` holds `sent`, `received`, and `grpcCode`, and `error.details.receivedRows` holds the rows that arrived before the failure (first 100). Treat the call as failed. Resend what is missing.
- Streaming response: one row per response message, columns `seq` and `value`, in arrival order. gRPC does not pair responses with requests, so pair them by a field the service echoes, or by `seq` when the service answers one per request in order.
- Unary response: single row, `value` is the full decoded message object. Pluck nested fields with `--pluck data.rows.0.0.<field>`. int64 comes back as strings (`longs: String`). Oneofs carry a sibling key naming the active branch.
- `meta.schemaContext.services` (the called service) plus `meta.schemaContext.messages` and `.enums` (request and response shapes, transitively expanded) ride on every grpc query result. Read those instead of re-running `grpc describe` after a successful call.

## Configuration
- `resolverHints.protoRoot` is required. It is a local directory, or a comma-separated list, loaded recursively, so pointing it at the parent of several checkouts works. Service protos usually import shared protos from other repos, so those checkouts must sit under the root too. `google/protobuf/*` well-known types are bundled. A missing import names both the absent file and the proto that imports it, which tells you which repo to clone. If your build emits a bundled proto tree, that directory is the easiest single root.
- `resolverHints.probeService` (optional) overrides which service `doctor` exercises. Default is the first service in the loaded proto package. Doctor always opens a real channel via `waitForReady` when a proto root is configured.
- Auth: gRPC datasources need **no stored credentials** by default. `--credential-ref` is still required by `datasource add`, so pass any label and leave it unpopulated. The credential-ref audit skips gRPC kinds, and readiness reports `credentials: not required by the configured datasource kinds` when every profile is auth-free. Do not run `creds set` for a plain gRPC endpoint. When the service does need auth: bearer JWT via credential ref (`taproot creds set --ref <ref> --token '<jwt>'`) adds `authorization: Bearer <token>` metadata, and static headers come from `--hint metadata.<key>=<value>` on `datasource add`.
- TLS: pass `--ssl` (a boolean flag, no value). `--ssl true` is rejected with `error: too many arguments`. Plaintext h2c is the default and matches in-cluster grpc-server deployments.

## Safety
- No mutate or flush tier yet: the plugin treats every method as `executeRead`. If a method might write, gate the datasource itself with `policy.allowMutate=false` (the default).
- Do not bypass with direct `grpcurl`. The plugin handles cluster DNS, openvpn preflight, deadlines, and decoding consistently with the rest of TapRoot.

## Example
A service-mesh gRPC endpoint registered as `qa-catalog-grpc` (`catalog-grpc.develop:6565`, plaintext h2c, openvpn) with proto package `com.example.catalog.v1`. The pattern repeats for any service-mesh endpoint reachable via cluster DNS.
