# TapRoot Runtime Architecture

## 1) Purpose
This document defines TapRoot's runtime structure end-to-end.

Focus:
- System shape and lifecycle.
- State ownership and safety boundaries.
- Failure behavior and recovery.
- Performance model.
- Proposed session-based runtime (`taprootd`) for high-throughput usage.

This document is intentionally implementation-oriented (not a feature checklist).

## 2) Operating Constraints
- Pre-release mode: optimize for the cleanest architecture now. No backward-compatibility guarantees unless explicitly requested.
- Local-first operation: state and secrets live on the local machine.
- Deterministic execution: same inputs should produce same resolution decisions.
- Safe-by-default: read-only behavior unless explicitly permitted.
- Reuse-first: wrap proven tools/libraries; do not reimplement protocols when avoidable.

## 3) Current Runtime (As Implemented)

### 3.1 Process Model
Current TapRoot is a stateless one-shot CLI process:
1. Parse command + flags.
2. Build fresh context.
3. Read stores from disk.
4. Resolve datasource/query path.
5. Run connector checks/connectors.
6. Execute query.
7. Exit.

Implication:
- Each query command repeats setup work.
- No persistent connections.
- No in-memory warm caches across invocations.

### 3.2 Component Map
- CLI entrypoint: `src/index.ts`
- Context + stores + registry wiring: `src/core/app.ts`
- State pathing: `src/core/paths.ts`
- Command handlers: `src/commands/*`
- Plugin registry + builtins: `src/plugins/*`, `src/plugins-builtins/*`
- Persistent stores:
  - datasources: `src/store/datasources.ts`
  - credentials: `src/store/credentials.ts`
  - KB adapters: `src/store/kb.ts`
  - schema catalog: `src/core/schema-refresh.ts`

### 3.3 Query Lifecycle (Current)
`taproot query ...`:
1. Resolve datasource from explicit profile, datasource store by env/service, KB bootstrap, then discovery when allowed.
2. Resolve query from `--sql`.
3. Enforce mutation policy (`src/core/safety.ts`).
4. Execute connector `connect` hooks.
5. Execute datasource plugin query.
6. Attach `meta.schemaContext` from the cached schema catalog.
7. Return the JSON envelope.

### 3.4 State Layout (Current)
Default root: `~/.taproot`

Subpaths:
- `config/datasources.json`
- `config/credentials.json.enc`
- `cache/`
- `cache/schema/<datasource>.json`

### 3.5 Credential Storage
- Preferred: OS keychain (`keytar`).
- Fallback: encrypted local JSON (`AES-256-GCM`, PBKDF2-derived key).
- Credential references are stored in datasource profiles.
- Secret values are never printed in command output.

### 3.6 Plugin Topology (Current)
Plugin contract (`src/types/core.ts`):
- kinds: `connector`, `executor`, `resolver`
- capabilities: `doctor`, `executeRead`, `executeMutate`, etc.
- optional hooks: `doctor`, `connect`, `disconnect`, `resolve`, `execute`

Current builtins:
- Executors: `mysql`, `teleport-mysql`, `redis`, `grpc`
- Connectors: `teleport`, `kubectl-portforward`

### 3.7 Schema Catalog (Current)
Catalog is one JSON file per SQL datasource (`mysql`, `teleport-mysql`) at `~/.taproot/cache/schema/<datasource>.json`:
- `information_schema` columns, indexes and partitions.
- Fresh for `TAPROOT_CATALOG_TTL_HOURS` (default 24).

Behavior:
- The first query against a datasource starts the catalog fetch in the background, bounded by `TAPROOT_CATALOG_TIMEOUT_MS`; no query waits for it, and concurrent queries share one fetch.
- A stale catalog keeps serving while the refetch runs.
- A failed fetch never fails the query.
- The partition guard and range warnings read the cached catalog.
- An `UNKNOWN_COLUMN` or `UNKNOWN_TABLE` error forces a refetch.

### 3.8 Current Performance Shape
Dominant latency today (for transport-backed queries):
- Connector checks/connect each invocation.
- New external process spawn per query (`tsh db exec` path).
- New DB connection per query outside the daemon.

Consequences under bursty workload:
- 15 back-to-back queries multiply preflight overhead.
- Multiple envs/datasources repeat setup transitions.

### 3.9 Current Failure Modes
- Connector command failure causes query fail-fast.
- Missing credential values can trigger runtime errors.
- Stateless mode can leave externally spawned helpers if connector scripts are not robust.
- No global process owner for session-scoped resources.

## 4) Target Runtime (Proposed): Session-Aware `taprootd`

### 4.1 Why
Need higher throughput, lower repeated latency, and strict cleanup semantics for agent-heavy usage.

### 4.2 High-Level Model
Introduce a local daemon:
- `taproot` CLI: user/client front-end.
- `taprootd`: long-lived local runtime managing sessions/resources.

Transport:
- Unix domain socket (`~/.taproot/run/taprootd.sock`).
- 0600 permissions.
- single-user trust boundary.

Daemon runtime decision (locked for v1):
- `taprootd` stays in Node/TypeScript (same ecosystem as CLI/plugins).
- No sidecar process boundary in v1.
- If CPU-bound paths appear, isolate with `worker_threads` before considering multi-runtime sidecar design.

### 4.3 Session Abstraction
Session = runtime context for one datasource fingerprint.

Session identity:
- fingerprint over: `env`, `service`, `kind`, `connection target/database`, `connector plan`.
- fingerprint is versioned (`fpv1`).
- fingerprint input is canonicalized JSON with sorted keys and normalized connector order.
- any structural fingerprint change requires explicit `fingerprintVersion` bump.
- daemon may keep multiple fingerprint versions concurrently; it must never silently reinterpret old fingerprints.

Session fields:
- `sessionId`
- `fingerprint`
- `fingerprintVersion`
- `state` (`opening`, `ready`, `degraded`, `closing`, `closed`)
- `createdAt`, `lastUsedAt`
- `idleTtlMs`, `hardTtlMs`
- `leaseCount`
- `resources[]`
- `metrics` (query count, failures, p50 latency)

### 4.4 Lease Model
Each operation acquires a lease:
1. `acquire(sessionId)`
2. execute operation
3. `release(sessionId)`

Crash safety:
- lease has owner PID + heartbeat epoch.
- sweeper reclaims orphaned leases.

### 4.5 Resource Classes
Class A (global/shared, not daemon-owned teardown):
- VPN login/session state.
- Teleport auth state.

Class B (session-owned, daemon must clean):
- `kubectl port-forward` process groups.
- DB pools/connections.
- temporary command subprocesses.

Cleanup contract for Class B:
- terminate process group on session close.
- escalate TERM -> KILL with bounded timeout.
- mark unreaped processes as incident metrics.

### 4.6 Session State Machine
States:
- `opening`: connector checks + resource creation.
- `ready`: query-capable.
- `degraded`: session exists but health is below query-ready threshold.
- `closing`: cleanup running.
- `closed`: terminal.

Transitions:
- `opening -> ready`: all required resources healthy.
- `opening -> degraded`: non-fatal connector warnings.
- `ready -> degraded`: runtime failures.
- `degraded -> ready`: successful revalidation probe (connectors + executor ping).
- `* -> closing -> closed`: explicit close, idle timeout, hard TTL, shutdown.

Degraded semantics (explicit):
- Entry triggers:
  - connector failure during query path,
  - executor connectivity/auth failures,
  - repeated timeout threshold breaches.
- Revalidation triggers:
  - on next lease acquire when `nextRevalidateAt <= now`,
  - periodic sweeper probe.
- Retry budget:
  - `maxRevalidateAttempts=3` per degradation window.
  - backoff: `2s -> 5s -> 15s`.
- Queue behavior while degraded:
  - if retry budget remains: first queued request can trigger revalidation.
  - if budget exhausted: fail fast with a classified error.

### 4.7 Query Path with Daemon
1. CLI sends request (`datasource`, query, mode).
2. Daemon resolves or creates session by fingerprint.
3. Daemon ensures required resources.
4. Query executes on warm resource path.
5. Result + timings returned.

### 4.8 Feedback Model (User + Agent Friendly)
Default (compact):
- `preparing datasource...`
- `ensuring connectivity...`
- `executing query...`
- `done (rows, ms)`

Long phase behavior:
- heartbeat every N seconds with elapsed time.

Verbose mode:
- per-connector detail + command-level diagnostics.

JSON mode:
- machine envelope only; no progress chatter.

### 4.9 Caching Layers
Layer 1 (process memory, short TTL):
- connector health checks
- session lookup
- recent datasource resolution

Layer 2 (persistent deterministic):
- schema catalog files (`cache/schema/<datasource>.json`)

Rule:
- memory cache is optimization only.
- persistent cache is source for cross-process reuse.

### 4.10 Concurrency and Throughput
Target pattern:
- many sequential queries across multiple datasources/envs.

Policy:
- one session per datasource fingerprint.
- bounded concurrent sessions per user.
- bounded concurrent queries per session.
- queue with fair scheduling to prevent one agent starvation.

Default TTLs (initial):
- `idleTtlMs = 45m`
- `hardTtlMs = 6h`
- profile-level override allowed, bounded by daemon max policy.

### 4.11 Failure and Recovery Contracts
- Connector failure: explicit classified error.
- Session health failure: auto demote to `degraded`, retry strategy with cap.
- Hard failures: close session and surface deterministic failure code.
- Daemon crash: restart daemon, stale lock/socket cleanup, no silent reuse.

### 4.12 Safety Model in Session Runtime
- Mutation gating remains enforced server-side.
- Session capabilities derive from datasource policy; never widened at runtime.
- Secrets never written to schema catalog or session metadata.

### 4.13 Observability and Auditing
Daemon telemetry per session:
- lifecycle events
- resource acquire/release
- query timings
- connector durations
- failure classification
- request/session correlation IDs

Correlation contract:
- Every request gets `requestId` (uuidv7).
- If session-backed, response includes `sessionId`.
- Daemon logs and JSON responses must carry these IDs.

Persistent logs:
- bounded rotating logs under `~/.taproot/run/logs/`.

### 4.14 Session Persistence Across Daemon Restarts
Session metadata is checkpointed (no secrets):
- file: `~/.taproot/run/sessions.json`
- includes: `sessionId`, fingerprint(+version), state, timestamps, resource descriptors, counters.

Recovery behavior:
1. load checkpoint on daemon start.
2. mark loaded sessions as `recovering`.
3. validate resources and transition to:
  - `ready` if healthy,
  - `opening` if recoverable but not ready,
  - `closed` if irrecoverable/stale.
4. remove stale checkpoints on confirmed close.

Note:
- DB credentials and secret values are never serialized in checkpoint files.

### 4.15 Shutdown Semantics
`taprootd` shutdown:
1. stop accepting new leases
2. drain running operations (timeout-bounded)
3. force close remaining sessions
4. cleanup socket + lockfiles

Hard kill recovery on next start:
- detect stale PID/lock/socket
- reconcile orphaned children
- rebuild clean runtime state

## 5) JSON Envelope Contract (Pinned)
Even in pre-release, response shape for agents is treated as a contract.

Envelope (v1):
- `ok: boolean`
- `data?: object`
- `error?: { code, message, details? }`
- `meta:`
  - `envelopeVersion: 1`
  - `requestId`
  - `sessionId?`
  - `timings?`

Rules:
- Progress output goes to stderr as JSON lines, and only under `--verbose`.
- Correlation IDs are mandatory.
- Breaking shape changes require `envelopeVersion` bump.

## 6) Command Surface Impact (Structural)
- Existing `query` remains primary user entry.
- `daemon` namespace: `daemon status`, `daemon stop`. The first query starts the daemon.
- No session commands: `query` opens and leases sessions itself.

## 7) Security Boundaries
- Trust boundary: local user account.
- IPC boundary: Unix socket perms (0600).
- File boundary: state root owned by user.
- No outbound telemetry by default.
- No secret material in:
  - schema catalog files
  - datasource definitions
  - session checkpoint files

## 8) Performance Targets (Session Runtime)
Target shape after daemonization:
- Cold query: includes session open + connector validation.
- Warm query: no reconnect path, only execute path.
- Burst workloads: amortize setup cost over many queries.

Suggested internal SLOs:
- warm-path overhead (excluding DB latency): <100ms median
- session open p95: bounded and visible with phase heartbeats
- stuck session count: 0 after sweeper convergence window

## 9) Rollout Plan
Phase 1:
- daemon skeleton, IPC, session registry, sweeper, compact progress UX.

Phase 2:
- resource ownership model, process-group cleanup, TTL caches.

Phase 3:
- DB pooling for mysql, optimized teleport command path, batch execution mode.

Phase 4:
- operational hardening (metrics, stress tests, chaos tests for orphan cleanup).

## 10) Acceptance Criteria
- Repeated query runs do not repeat full cold setup when session is warm.
- No orphaned `kubectl port-forward` processes after idle timeout or daemon stop.
- Session metadata reflects true lease/resource state.
- JSON mode remains deterministic and clean.
- Mutation guardrails enforced identically in daemon and CLI paths.
- Schema catalog remains secret-safe.
- Correlation IDs (`requestId`, `sessionId`) are present and traceable end-to-end.
- Degraded sessions fail fast after retry budget exhaustion.

## 11) Open Design Decisions
- Queue fairness policy (global vs per-session weights).
- Teleport optimization path beyond `tsh db exec` process spawn.
