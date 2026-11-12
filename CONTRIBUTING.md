# Contributing

```bash
npm ci
npm run check
npm test
```

Both must pass before a PR.

## Rules

- Every behaviour change ships with a test covering the passing path and at least one failure.
- Tests use real files under `os.tmpdir()`, not a mocked `fs`.
- Commit subjects follow Conventional Commits (`feat(query): ...`, `fix(cli): ...`). Releases are cut from them: `feat` bumps minor, `fix` and `perf` bump patch, and `!` or `BREAKING CHANGE:` bumps major.
- Agents and scripts depend on the JSON envelope, command names and flags. A change that breaks any of them is a breaking commit.
- CI runs `gitleaks` and `trufflehog` on every push. Report a false positive in the PR rather than disabling the scanner.

## Issues

Include the failing command, its JSON output, `taproot --version` and your platform. Report security issues privately: see [SECURITY.md](SECURITY.md).
