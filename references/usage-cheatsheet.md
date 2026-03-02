# TapRoot Usage Cheatsheet

## Boot
- `taproot self-check`
- `taproot --json self-check`

## Credentials
- `taproot creds set --ref prod:orders --user sample_reader --password '***'`
- `taproot creds show --ref prod:orders`

## Datasources
- `taproot datasource add --name prod-orders --kind mysql --env prod --service orders --credential-ref prod:orders --host db.internal.example --port 3306 --database orders`
- `taproot datasource list`
- `taproot datasource resolve --env prod --service orders`

## Doctor + Query
- `taproot doctor --datasource prod-orders`
- `taproot query --datasource prod-orders --query "SELECT 1 AS ok"`
- `taproot query --datasource prod-orders --template orders.latest_by_customer --param customer_id=42 --param limit=20`

## KB
- `taproot kb resolve-connection --service orders --env prod`
- `taproot kb resolve-credentials --service orders --env prod`
- `taproot kb resolve-database-name --service orders --env prod`
- `taproot kb resolve-query --service orders --intent "latest orders by customer"`

## Learning + Cache
- `taproot learn status`
- `taproot learn compact`
- Learning contract: `references/learning-contract.md`
- `taproot cache show`
- `taproot cache prune --ttl-hours 168`

## Completion
- `eval "$(taproot completion zsh)"`
