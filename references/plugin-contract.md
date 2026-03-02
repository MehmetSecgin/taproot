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
- `priority`

Execution output must match Telequery query result envelope.
