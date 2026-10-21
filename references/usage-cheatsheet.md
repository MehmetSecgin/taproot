# TapRoot Usage Cheatsheet

## Boot
- `taproot self-check`
- `taproot self-check`

## Credentials
- `taproot creds set --ref production:sample --user sample_reader --password '***'`
- `taproot creds show --ref production:sample`

## Datasources
- `taproot datasource add --name production-sample --kind mysql --env production --service sample --credential-ref production:sample --host db.internal.example --port 3306 --database sample_app`
- `taproot datasource list`
- `taproot datasource resolve --env production --service sample`

## Doctor + Query
- `taproot doctor --datasource production-sample`
- `taproot query --datasource production-sample --sql "SELECT 1 AS ok"`

## KB
- `taproot kb resolve --service sample --env production`
- `taproot kb resolve --datasource production-sample`

## Learning + Cache
- `taproot learn status`
- `taproot learn compact`
- Learning contract: `references/learning-contract.md`
- `taproot cache show`
- `taproot cache prune --ttl-hours 168`

## Completion
- `eval "$(taproot completion zsh)"`
