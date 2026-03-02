# Learning Contract (Deterministic)

## Goal
Learning is a deterministic local cache for faster reuse, not a run transcript.

It must:
- Reduce repeated connection/query discovery.
- Prefer stable upserts over append-only growth.
- Avoid secret leakage.

## Files
All files are local under `~/.telequery/learning/`:
- `resolution-cache.json`
- `query-library.json`
- `query-stats.json`

Legacy file:
- `records.json` is migration-only input and should not be appended to.

## Data Models

### resolution-cache
Key: `env + service`

Fields:
- `env`, `service`
- `datasourceName`
- `kind`
- `connection` (host/port/database/target/ssl)
- `credentialRef` (name only, never secret values)
- `connectors`, `resolverHints`
- `lastVerifiedAt`
- `successCount`, `failureCount`
- `confidence`

Behavior:
- Upsert one winner per key.
- On success, refresh `lastVerifiedAt`, increment `successCount`, increase confidence.
- On failure, increment `failureCount`, decrease confidence.

### query-library
Key: `service + intentKey + sqlTemplate`

Fields:
- `id` (stable hash-like key from the deterministic tuple)
- `service`
- `intentKey` (normalized intent text; fallback `auto` when absent)
- `sqlTemplate` (normalized SQL with placeholders)
- `source` (`learned` or `kb`)
- `lastVerifiedAt`
- `successCount`

Behavior:
- SQL values are normalized to placeholders (`:num`, `:str`, `:bool`).
- Same query shape across different parameter values must map to one template.
- Upsert, do not append duplicates.

### query-stats
Key: `datasource + templateId`

Fields:
- `datasource`
- `templateId`
- `lastRunAt`
- `lastStatus` (`success`/`error`)
- `lastErrorClass` (optional)
- `successCount`, `failureCount`
- `latencyMsP50`

Behavior:
- Used for ranking and quick health signal.
- No secrets and no raw result payload required.

## Precedence Rules
Query path must resolve deterministically:
1. Explicit CLI args.
2. Datasource profile store.
3. Learning `resolution-cache`.
4. KB static resolvers.

Template resolution:
1. Explicit `--query` / `--template`.
2. Learning `query-library` exact `service + intentKey`.
3. KB templates.

## Retention
- `compact`: idempotent dedupe/upsert rewrite.
- `prune --ttl-hours N`: remove stale entries by `lastVerifiedAt`/`lastRunAt`.
- `clear`: clear all learning files.

## Redaction and Safety
- Never store credential values, tokens, passwords, cert/key material.
- `credentialRef` identifiers are allowed.
- Any sample payload storage must be explicitly gated and bounded (disabled by default).

