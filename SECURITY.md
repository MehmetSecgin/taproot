# Security Policy

## Supported Versions

Only the latest `main` branch and the latest tagged release receive security updates.

| Version | Supported |
|---------|-----------|
| `main` (HEAD) | yes |
| latest tag | yes |
| earlier tags | no |

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security reports.

Email: **mehmetascgn@gmail.com**

Include:
- A description of the vulnerability and the impact you believe it has.
- Steps to reproduce (proof-of-concept code, commands, or specific TapRoot input).
- The TapRoot version (`taproot --version`) and the platform you reproduced it on.
- Whether the issue is already public anywhere (issue tracker, blog post, etc.).

You should expect:
- An acknowledgement within 5 business days.
- A first-pass triage (confirmed / needs-more-info / not-a-vulnerability) within 10 business days.
- A target fix window communicated once the report is confirmed.

## Scope

In scope:
- The TapRoot CLI (`taproot` binary and `src/`).
- The `taprootd` daemon and its RPC surface.
- The built-in plugins under `src/plugins-builtins/`.
- The credential store, runtime config loader, and schema catalog cache.

Out of scope:
- Vulnerabilities in upstream dependencies. Report those to the dependency owner. We will track and bump them once a fix is upstream.
- Vulnerabilities that require pre-existing local root or write access to `~/.taproot/`. TapRoot trusts its own state directory.
- Vulnerabilities in third-party connectors (`tsh`, `kubectl`, etc.). Report those to the connector vendor.
- Social engineering, physical attacks, denial of service through resource exhaustion against the user's own machine.

## Sensitive Data Handling

TapRoot stores credentials in the OS keychain, or in `~/.taproot/config/credentials.json.enc` (encrypted with `TAPROOT_MASTER_KEY` when present, falling back to a machine-derived secret). Run `taproot creds list` to enumerate refs; values are redacted.

## Coordinated Disclosure

We follow standard coordinated-disclosure practice: fix first, publish advisory and patch release together, credit the reporter unless they prefer to remain anonymous.
