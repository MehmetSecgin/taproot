# Architecture Decisions

This file is the v1 record. Decisions from ADR-0001 onward live in `docs/adr/`.

## Reuse-first policy
For each capability:
1. Reuse stable OSS library / existing CLI
2. Wrap existing tool with deterministic adapter
3. Custom code only when no viable tool exists

## v1 chosen dependencies
- CLI framework: `commander`
- Validation: `zod`
- DB client protocols:
  - MySQL: `mysql2`
- Connector tooling (reuse existing CLIs):
  - Teleport DB access: `tsh db exec` (adapter only)
- Build/test toolchain: `tsup`, `typescript`, `vitest`, `tsx`

## Why plugin runtime (vs backend-specific monolith)
- Enables future backends without core rewrites.
- Provides capability-level safety policies (`executeRead`, `executeMutate`, etc.).
- Supports heterogeneous query languages through plugin-native execution.

## Secrets approach
- Preferred path: OS keychain via optional `keytar` when available.
- Fallback: encrypted local credential file (AES-GCM with PBKDF2-derived key).
- Secret values are redacted in output and excluded from the schema catalog.

## Schema catalog
- One cached catalog per SQL datasource at `~/.taproot/cache/schema/<datasource>.json`.
- Fetched in the background on the first query and refreshed when older than `TAPROOT_CATALOG_TTL_HOURS`; no query waits for it.

## Config boundaries
- Datasource profiles own connection topology (`host`, `port`, `database`, `target`).
- Credential refs own authentication and connector command material.
- Query template params are derived from SQL placeholders to avoid drift.
