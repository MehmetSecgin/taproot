# Architecture Decisions

## Reuse-first policy
For each capability:
1. Reuse stable OSS library / existing CLI
2. Wrap existing tool with deterministic adapter
3. Custom code only when no viable tool exists

## v1 chosen dependencies
- CLI framework: `commander`
- Validation: `zod`
- Logging: `pino`
- DB client protocols:
  - MySQL: `mysql2`
  - Postgres: `pg`
- Connector tooling (reuse existing CLIs):
  - OpenVPN: `openvpn3` CLI (adapter only, no protocol reimplementation)
  - Teleport DB access: `tsh db exec` (adapter only)
- Build/test toolchain: `tsup`, `typescript`, `vitest`, `tsx`

## Why plugin runtime (vs backend-specific monolith)
- Enables future backends without core rewrites.
- Provides capability-level safety policies (`executeRead`, `executeMutate`, etc.).
- Supports heterogeneous query languages through plugin-native execution.

## Secrets approach
- Preferred path: OS keychain via optional `keytar` when available.
- Fallback: encrypted local credential file (AES-GCM with PBKDF2-derived key).
- Secret values are redacted in output and excluded from learning/artifacts.

## Learning model
- Deterministic local caches only (`resolution-cache`, `schema-catalog`, `schema-observations`, `schema-joins`, `grpc-schemas`).
- Upsert by stable keys; avoid append-only duplicates.

## Config boundaries
- Datasource profiles own connection topology (`host`, `port`, `database`, `target`).
- Credential refs own authentication and connector command material.
- Query template params are derived from SQL placeholders to avoid drift.
