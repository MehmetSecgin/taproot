# ADR-0002: The schema catalog replaces the learning system

Status: accepted
Date: 2026-10-22

## Context

TapRoot kept three stores that grew with every query: a learning store (resolution cache, schema observations, join observations, gRPC schema cache), a runs ledger, and per-run artifacts. Usage data showed most of it went unread:

- `--reason` was a ledger note nobody read back.
- Learned datasource resolution, `run show`, `run list` and the repeat-failure short-circuit were never used.
- `meta.queryMemory` fired on 63 of 2,265 queries.
- Relations were attached to query output 3 times.
- `meta.schemaContext` tables and the partition guard were used.

The stores held 4.8 MB of learning files and 18 MB of run artifacts, and every query loaded the 4.8 MB observations file.

## Decision

Keep the schema catalog, drop the rest.

- The catalog is one cached file per SQL datasource at `~/.taproot/cache/schema/<datasource>.json`, fetched on the first query and refetched in the background when older than `TAPROOT_CATALOG_TTL_HOURS`.
- The partition guard, range warnings and `meta.schemaContext.tables` read the cached catalog.
- Removed: `taproot learn *`, `taproot run *`, `kb relations validate`, `cache prune`, `cache clear --kind`, `query --reason`, `query --allow-schema-introspection`, `TAPROOT_ALLOW_SCHEMA_INTROSPECTION`, the `REDUNDANT_INTROSPECTION` error code, the runs ledger, run artifacts, `meta.runId`, `meta.queryMemory`, relations auto-injection, the repeat-failure short-circuit, the learned resolution fallback, the gRPC schema cache, and the config keys `defaults.learning`, `defaults.ledger` and `environmentPolicies.<env>.ledgerRedactionTier`.
- Datasource resolution runs: explicit profile, datasource store by env and service, KB bootstrap, then discovery when allowed.
- `kb relations list`, `kb relations import` and `kb related` stay as curated KB data. Query output no longer carries them.
- gRPC queries still return `meta.schemaContext.services`, `messages` and `enums` from the plugin.

## Consequences

Good:

- Query startup no longer loads a multi-megabyte file, and state stays bounded by one small file per datasource.
- `SHOW CREATE TABLE`, `DESCRIBE` and `SHOW COLUMNS` run like any other read.
- Less surface to document and test.

Costs:

- No query history. Callers that need one keep their own.
- Join relations are no longer inferred from executed SQL. Curated KB relations are the only source.
- Existing `~/.taproot/learning` and `~/.taproot/runs` directories are ignored and can be deleted by hand.
