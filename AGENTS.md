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
