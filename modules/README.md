# Modules

Future external plugins live here.

v1 ships built-ins only (`mysql`, `postgres`), but runtime contract is plugin-ready for:
- redis
- kafka
- rabbitmq
- loki/logql
- k8s
- other queryable systems

Each module should include `module.json` manifest and compiled entrypoint.
