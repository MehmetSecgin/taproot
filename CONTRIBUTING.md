# Contributing to TapRoot

Thanks for your interest in contributing. TapRoot is a prerelease CLI; the surface is still moving, but the contracts under `references/` are stable and PRs should respect them.

## Quick Start

```bash
git clone https://github.com/MehmetSecgin/taproot.git
cd taproot
npm install
npm run check   # tsc --noEmit
npm test        # vitest
```

A successful PR run passes both `npm run check` and `npm test` locally.

## Development Loop

- Source: `src/`
- Tests: `test/` (vitest, colocated by feature)
- Built CLI: `taproot` (entrypoint wrapper)
- Build: `npm run build` (tsup; only needed for distribution)

Edit, run `npm test`, commit. Tests should pass before every commit. If a test is intentionally skipped, leave a comment explaining why and link an issue.

## Code Style

- TypeScript strict mode is on. Do not loosen it.
- No new `any` casts in production code unless you justify it in a comment.
- Prefer narrow imports (`import { foo } from '...'`) over namespace imports.
- One feature per commit; one logical concern per file.
- No comments that restate the code. Comments explain *why*, not *what*.

## Tests

- Every behavioral change ships with a test (passing path + at least one failure mode).
- Tests live under `test/` and follow the existing naming pattern (`<feature>.test.ts`).
- Use real files via `os.tmpdir()` rather than mocking `fs`; state and credential paths assume real I/O.
- Daemon-touching tests start a daemon on a per-test socket path (see `test/daemon-deterministic.test.ts`).

## Contracts You Must Not Break Silently

Changes to these require a doc update in the same PR:

- JSON envelope shape — `references/json-envelope-contract.md`
- Plugin contract — `references/plugin-contract.md`
- Daemon RPC shape — `references/phase1-runtime-contract.md`

If you have to break a contract during prerelease, bump the version field referenced by the doc and call it out in the PR body.

## Commits and PRs

- Imperative commit subjects under ~70 characters (`Add foo`, `Fix bar`, `Refactor baz`).
- Body explains *why* and any non-obvious tradeoff.
- One coherent change per PR. Refactors and feature changes go in separate PRs.
- Reference the issue in the PR body (`Closes #N`) when applicable.

## Pre-Push Security Checks

CI runs `gitleaks` and `trufflehog` on every push and PR. To catch findings locally before pushing, install both and run them against your working tree:

```bash
# gitleaks — scan tracked files + uncommitted changes
brew install gitleaks
gitleaks detect --source . --verbose

# trufflehog — scan committed history for verified secrets only
brew install trufflehog
trufflehog filesystem . --only-verified
```

For a quick repo-tree check using TapRoot's own scanner (catches common cred/topology patterns):

```bash
taproot sanitize check-repo
```

If a finding is a false positive, document the exemption rather than disabling the scanner.

## Reporting Issues

- Bug reports: include the failing command, the JSON envelope output, the TapRoot version, and the platform.
- Feature requests: describe the use case and the agent or operator workflow it unblocks.
- Security issues: do not file publicly. See [SECURITY.md](SECURITY.md).

## License

By submitting a contribution you agree that it will be licensed under the [MIT License](LICENSE).
