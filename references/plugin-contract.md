# Plugin Contract

Each plugin exports:
- `manifest`
- optional `doctor()`
- optional `resolve()`
- optional `execute()`

Manifest fields:
- `name`
- `version`
- `kind`: connector|executor|resolver
- `capabilities`: doctor|resolveConnection|resolveCredentials|resolveDatabase|executeRead|executeMutate|discoverSchema|normalizeIds
- `accessMethods` (optional): native|qa-portforward|tsh|... (plugin-declared routing hints)
- `priority`

Execution output must match Telequery query result envelope.
