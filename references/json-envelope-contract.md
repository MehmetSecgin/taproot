# TapRoot JSON Envelope Contract (v1)

This is the frozen prerelease JSON contract for agent-facing CLI outputs.

## Version
- `v1`
- Backward compatibility is **not required** in prerelease mode, but any schema change must update this file and tests in the same PR.

## Shared Envelope

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "uuid",
    "runId": "optional-string",
    "sessionId": "optional-string",
    "timings": { "durationMs": 123 }
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "STRING_CODE",
    "message": "human-readable message",
    "details": {}
  },
  "meta": {
    "requestId": "optional-uuid",
    "runId": "optional-string",
    "sessionId": "optional-string",
    "timings": { "durationMs": 123 }
  }
}
```

## Command-Specific Requirements
- `query`
  - Success must include `data.columns`, `data.rows`, `data.datasource`, `data.plugin`, `data.classification`
  - Success/failure via daemon must include `meta.requestId`
  - Successful daemon execution should include `meta.runId` and `meta.sessionId`
- `daemon status`
  - Must use shared envelope with `meta.requestId`
  - `data` includes daemon runtime status payload
- `session *` (`open`, `ls`, `inspect`, `close`, `close-all`)
  - Must use shared envelope with `meta.requestId`
  - `open`/`inspect` should include `meta.sessionId` when available

## Output Discipline
- stdout contains only one JSON payload, or one JSON value per line under `--jsonl`.
