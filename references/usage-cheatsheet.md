# Telequery Usage Cheatsheet

## Boot
- `telequery self-check`
- `telequery --json self-check`

## Credentials
- `telequery creds set --ref prod:orders --user sample_reader --password '***' --host db.internal.example --database orders`
- `telequery creds show --ref prod:orders`

## Datasources
- `telequery datasource add --name prod-orders --kind mysql --env prod --service orders --credential-ref prod:orders --host db.internal.example --port 3306 --database orders`
- `telequery datasource list`
- `telequery datasource resolve --env prod --service orders`

## Doctor + Query
- `telequery doctor --datasource prod-orders`
- `telequery query --datasource prod-orders --query "SELECT 1 AS ok"`
- `telequery query --datasource prod-orders --template orders.latest_by_customer --param customer_id=42 --param limit=20`

## KB
- `telequery kb resolve-connection --service orders --env prod`
- `telequery kb resolve-credentials --service orders --env prod`
- `telequery kb resolve-database-name --service orders --env prod`
- `telequery kb resolve-query --service orders --intent "latest orders by customer"`

## Learning + Cache
- `telequery learn status`
- `telequery learn compact`
- `telequery cache show`
- `telequery cache prune --ttl-hours 168`

## Completion
- `eval "$(telequery completion zsh)"`
