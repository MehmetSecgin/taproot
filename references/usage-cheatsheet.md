# TapRoot Usage Cheatsheet

## Boot
- `taproot self-check`
- `taproot --json self-check`

## Credentials
- `taproot creds set --ref production:sample --user sample_reader --password '***'`
- `taproot creds show --ref production:sample`

## Datasources
- `taproot datasource add --name production-sample --kind mysql --env production --service sample --credential-ref production:sample --host db.internal.example --port 3306 --database sample_app`
- `taproot datasource list`
- `taproot datasource resolve --env production --service sample`

## Doctor + Query
- `taproot doctor --datasource production-sample`
- `taproot query --datasource production-sample --query "SELECT 1 AS ok"`
- `taproot query --datasource production-sample --template sample.latest_by_customer --param customer_id=42 --param limit=20`

## KB
- `taproot kb resolve-connection --service sample --env production`
- `taproot kb resolve-credentials --service sample --env production`
- `taproot kb resolve-database-name --service sample --env production`
- `taproot kb resolve-query --service sample --intent "latest records by customer"`

## Learning + Cache
- `taproot learn status`
- `taproot learn compact`
- Learning contract: `references/learning-contract.md`
- `taproot cache show`
- `taproot cache prune --ttl-hours 168`

## Completion
- `eval "$(taproot completion zsh)"`
