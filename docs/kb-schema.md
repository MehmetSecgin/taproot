# KB format: services.json

The KB directory holds the files TapRoot reads to resolve a service in an environment. This page defines the format of `services.json`. `taproot kb validate` checks a file against it. `docs/services.schema.json` is the same rules as JSON Schema, for editors.

## Shape

`services.json` is a JSON array. Each element is one service:

```json
[
  {
    "service": "orders",
    "connections": [
      {
        "env": "qa",
        "namespace": "develop",
        "engine": "mysql",
        "database": "orders",
        "db_user": "orders_reader",
        "access_method": "native",
        "status": "active",
        "verified_at_utc": "2026-03-01T00:00:00Z"
      }
    ]
  }
]
```

The example uses placeholder names only.

## Service fields

| Field | Required | Type | Rule |
|---|---|---|---|
| `service` | yes | string | Non-empty. Matched case-insensitively. |
| `connections` | no | array | Each element is a connection row. Absent means no connections. |

## Connection fields

| Field | Required | Type | Rule |
|---|---|---|---|
| `env` | yes | string | Non-empty. Environment name, e.g. `qa`, `stg`, `prod`. |
| `namespace` | no | string | Namespace inside the environment, e.g. `develop`. |
| `status` | no | string | Only `active` rows resolve. Absent means `active`. |
| `engine` | no | string | Database engine, e.g. `mysql`. |
| `database` | no | string | Database name. |
| `db_user` | no | string | Database user to connect as. |
| `host` | no | string | Host to connect to. |
| `port` | no | integer 1 to 65535, or a digit string | Port to connect to. |
| `target` | no | string | Teleport database name when `access_method` is `tsh`. |
| `access_method` | no | enum | One of `native`, `qa-portforward`, `tsh`. |
| `verified_at_utc` | no | ISO 8601 timestamp with a timezone | When the row was last checked. The newest active row wins. |

Unknown keys are allowed. A newer KB with extra fields still validates, and TapRoot ignores keys it does not read.

## Resolution

For a query, TapRoot takes the service and env, and the namespace when given. It keeps the rows with a matching `env` and an `active` status. With a namespace, it also keeps rows with that namespace. The row with the newest `verified_at_utc` wins.

## Validation

```bash
taproot kb validate
```

Prints `{"valid": true, "findings": []}` on success. On any problem it exits non-zero and names each problem with its path, for example `orders: services[0] (orders).connections[0].access_method: 'ssh' is not a known access method (native, qa-portforward, tsh)`.

Validation covers the rules above. It does not check that a host, database or user exists.
