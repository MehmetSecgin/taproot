# Phase 1 Runtime Contract

This contract is the implementation baseline for the first `taprootd` PR.

## 1) Daemon RPC Contract (Pinned)

Transport:
- Unix socket: `~/.taproot/run/taprootd.sock`
- Request/response: newline-delimited JSON messages (`NDJSON`)

All requests:
- `protocolVersion: 1`
- `requestId: string` (uuidv7 suggested)
- `method: string`
- `params: object`

All responses:
- `protocolVersion: 1`
- `requestId: string`
- `ok: boolean`
- `data?: object`
- `error?: { code: string; message: string; details?: object }`
- `meta: { sessionId?: string; timings?: { durationMs: number } }`

Required methods (Phase 1):
- `daemon.status`
- `query.execute`
- `session.open`
- `session.list`
- `session.inspect`
- `session.close`
- `session.closeAll`

### `query.execute`
Request:
```json
{
  "protocolVersion": 1,
  "requestId": "01H...",
  "method": "query.execute",
  "params": {
    "datasource": "qa-sample",
    "env": "qa",
    "service": "sample",
    "query": "SELECT 1 AS ok;",
    "intent": "optional",
    "allowMutate": false,
    "jsonMode": false
  }
}
```

Response success:
```json
{
  "protocolVersion": 1,
  "requestId": "01H...",
  "ok": true,
  "data": {
    "columns": ["ok"],
    "rows": [{"ok": 1}]
  },
  "meta": {
    "sessionId": "sess_...",
    "timings": {"durationMs": 124}
  }
}
```

Response failure:
```json
{
  "protocolVersion": 1,
  "requestId": "01H...",
  "ok": false,
  "error": {
    "code": "ACCESS_DENIED",
    "message": "Access denied for user ...",
    "details": {"datasource": "qa-orders"}
  },
  "meta": {
    "sessionId": "sess_..."
  }
}
```

## 2) Session Checkpoint Schema (`sessions.json`)

Path:
- `~/.taproot/run/sessions.json`

Top-level:
```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-03-02T20:00:00.000Z",
  "sessions": []
}
```

Session entry:
```json
{
  "sessionId": "sess_abc123",
  "fingerprintVersion": "fpv1",
  "fingerprint": "sha256:...",
  "datasourceName": "qa-sample",
  "env": "qa",
  "service": "sample",
  "kind": "mysql",
  "state": "recovering",
  "createdAt": "2026-03-02T20:00:00.000Z",
  "lastUsedAt": "2026-03-02T20:00:04.000Z",
  "idleTtlMs": 2700000,
  "hardTtlMs": 21600000,
  "leaseCount": 1,
  "resources": [
    {
      "id": "res_kpf_1",
      "type": "process",
      "kind": "kubectl-portforward",
      "status": "ready",
      "pid": 12345,
      "pgid": 12345,
      "createdAt": "2026-03-02T20:00:00.000Z"
    }
  ],
  "metrics": {
    "queryCount": 12,
    "successCount": 11,
    "failureCount": 1,
    "p50DurationMs": 192
  },
  "degraded": {
    "attempts": 0,
    "nextRevalidateAt": "2026-03-02T20:00:00.000Z",
    "lastErrorCode": ""
  }
}
```

Valid `state` values in checkpoint:
- `recovering`
- `opening`
- `ready`
- `degraded`
- `closing`
- `closed`

Rules:
- No secret values in checkpoint data.
- Checkpoint writes are atomic (temp file + rename).
- Unknown `schemaVersion` must fail-fast with explicit error.

## 3) Sweeper Contract

Cadence:
- Tick interval: `15s`

Responsibilities per tick:
1. Reclaim orphan leases:
  - detect dead owner PID / stale heartbeat
  - decrement lease count
2. Handle TTL:
  - close idle sessions
  - close hard-TTL sessions
3. Degraded probing:
  - if `nextRevalidateAt <= now` and attempts remaining, run revalidation
  - transition state accordingly
4. Resource reconciliation:
  - verify process-backed resources still alive
  - transition session to `degraded` on missing required resources
5. Checkpoint hygiene:
  - persist current session snapshot
  - remove terminal closed sessions

Never in sweeper:
- never disconnect Class A resources (VPN / Teleport global auth)

Lease heartbeat contract:
- Daemon updates each active lease heartbeat at `leaseHeartbeatIntervalMs`.
- Sweeper treats lease as stale when `now - heartbeatAt > leaseStaleThresholdMs`.
- Phase 1 constants:
  - `leaseHeartbeatIntervalMs = 5000`
  - `leaseStaleThresholdMs = 20000`

## 4) Runtime Constants Source-of-Truth

All daemon timing constants must come from:
- `src/core/constants.ts`

No duplicated literal values in daemon/session/sweeper code.
