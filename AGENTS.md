# TapRoot

If a line here proves wrong, propose a fix to it.

## Output design

Agents read most TapRoot output, so every byte costs tokens on every call.

- New JSON output carries the essentials. Stats, provenance and timestamps go behind `--detailed`.
- Drop empty arrays, null fields and defaults the reader can infer (`unique: false`, `type: "BTREE"`, an echo of the input).
- Print through `printJson` so the global `--pluck <dot.path>` and `--lines` work on every command.
- Agent flows get JSON, not tables.
- Row sets default to an array of arrays keyed by `columns`.
- Add no field "for symmetry": agents pay for it on every call.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
