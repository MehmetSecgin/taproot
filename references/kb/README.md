# KB Contract

## Purpose
`references/kb/*.json` is static discovery data (service/environment facts), not runtime state.

## Source-of-Truth Rules
When fields overlap between datasource profiles and KB entries (`engine`, `host`, `port`, `database`, `target`, `access_method`):

1. Explicit CLI args
2. Datasource profile store (`~/.telequery/config/datasources.json`)
3. Learning resolution cache (`~/.telequery/learning/resolution-cache.json`)
4. KB static files (`references/kb/*.json`)

Practical meaning:
- Datasource profiles are runtime source-of-truth.
- KB is bootstrap/default input.
- KB never silently overwrites an explicit datasource profile.

## Access Method Semantics
`services.example.json` contains `access_method` to describe connectivity routing intent (`native`, `qa-portforward`, `tsh`, ...).

This is used during datasource bootstrap/routing.
Plugin manifests may declare `accessMethods[]` as supported routing hints.

## Query Template Intent Contract
Intent strings are agent-facing API.

Rules:
- Keep intents stable and specific.
- Prefer one canonical intent per template.
- Use `aliases` for natural-language variations.
- Avoid duplicate intents with equivalent SQL shape.

## Template Params Contract
`params` are derived from SQL placeholders (`:param`) by Telequery.

Rules:
- SQL placeholder list is canonical.
- Do not hand-maintain `params` separately.

