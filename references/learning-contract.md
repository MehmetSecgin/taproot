# Learning Contract (Deterministic)

## Goal
Learning is a deterministic local cache for faster reuse, not a run transcript.

It must:
- Reduce repeated connection/query discovery.
- Prefer stable upserts over append-only growth.
- Avoid secret leakage.

## Files
All files are local under `~/.taproot/learning/`:
- `resolution-cache.json`
- `schema-catalog.json`
- `schema-observations.json`
- `schema-joins.json`
- `grpc-schemas.json`

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

### schema-catalog
Key: `datasource name`

Fields:
- `key` (the datasource name)
- `env`, `service`, `database`
- `fetchedAt`
- `tableCount`

Behavior:
- One row per datasource, written after a full `information_schema` catalog pass.
- Readers look the row up by datasource name to decide whether a cached catalog exists.
- The query path reads it to decide whether the catalog is still fresh. Default TTL is 24 h (`TAPROOT_CATALOG_TTL_HOURS`).
- A missing or stale row triggers exactly one unfiltered introspection on the next query. A failed fetch never fails the query.

### schema-observations
Key: `service + table`

Fields:
- `datasource`, `env`, `service`, `kind`, `database`, `target`, `table`
- `aliases`
- `columns` (per-column `selectedCount`, `filterCount`, `groupCount`, `orderCount`)
- `primaryKey`, `indexes`, `partition`
- `firstSeenAt`, `lastSeenAt`, `sightings`, `confidence`, `sources`

Behavior:
- Filled from observed queries and from `information_schema` refreshes.
- Upsert one row per key; refreshed metadata wins over observed inference.

### schema-joins
Key: `service + leftTable + rightTable + normalized condition`

Fields:
- `datasource`, `env`, `service`, `kind`, `database`
- `leftTable`, `rightTable`, `directionHint`
- `conditionRaw`, `conditionNormalized`
- `firstSeenAt`, `lastSeenAt`, `sightings`, `confidence`, `sources`

Behavior:
- Intra-service join edges only; cross-service edges live in KB `relations.json`.

### grpc-schemas
Key: `service` (falling back to the datasource name)

Fields:
- `key`, `datasource`, `env`, `service`, `kind`
- `protoRoot`
- `services`, `messages`, `enums`
- `firstSeenAt`, `lastSeenAt`, `sources`

Behavior:
- One row per gRPC service, written after a proto introspection pass.
- Serves `learn grpc-schema` from cache so a missing proto root does not break inspection.

## Precedence Rules
Query path must resolve deterministically:
1. Explicit CLI args.
2. Datasource profile store.
3. Learning `resolution-cache`.
4. KB static resolvers.

KB source-of-truth clarification is documented in `references/kb/README.md`.

Query resolution:
1. Explicit `--sql`. There is no other source.

## Retention
- `compact`: idempotent dedupe/upsert rewrite.
- `prune --ttl-hours N`: remove stale entries by `lastVerifiedAt`/`lastSeenAt`/`fetchedAt`.
- `clear`: clear all learning files.

## Redaction and Safety
- Never store credential values, tokens, passwords, cert/key material.
- `credentialRef` identifiers are allowed.
- Any sample payload storage must be explicitly gated and bounded (disabled by default).
