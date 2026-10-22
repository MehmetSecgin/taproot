# Plugin Contract

Each plugin exports:
- `manifest`
- optional `doctor()`
- optional `connect()`
- optional `execute()`

Manifest fields:
- `name`
- `kind`: connector|executor|resolver
- `capabilities`: doctor|resolveConnection|resolveCredentials|resolveDatabase|executeRead|executeMutate|discoverSchema|normalizeIds
- `priority` (optional)

Routing uses only `name` and `capabilities`: a datasource's `kind` selects the executor plugin of that name, and each entry in its `connectors` selects a connector plugin by name.

Execution output must match TapRoot query result envelope.
