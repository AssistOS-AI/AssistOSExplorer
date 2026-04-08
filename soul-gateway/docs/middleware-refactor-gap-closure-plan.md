# Soul Gateway — Middleware Refactor Gap Closure Summary

## Purpose

This document is now a historical summary of the middleware-first runtime refactor that was completed on this branch.

It stays outside `soul-gateway/docs/specs/` because it is implementation history, not a current-behavior spec.

## What shipped

- one kernel-driven request/runtime model
- route handling moved into `src/runtime/route/`
- provider execution moved to provider middlewares plus terminal transports
- client-facing SSE route streaming
- unified `middleware_bindings`
- cascade models backed by `models` + `model_children`
- tier compatibility endpoints/views backed by cascade models
- legacy provider-hook storage/runtime deletion

## Compatibility surfaces that intentionally remain

- `executorCatalog` as an alias for `transportCatalog`
- legacy gateway middleware module shape `{ meta, pre?, post? }`
- legacy provider-hook extension module shape for extension loading
- legacy extension directory conventions such as `provider-hooks/`, `executors/`, and `wrappers/`
- `/v1/tiers` and `/management/tiers` as compatibility views over cascade models
- `/management/provider-hooks` and `/management/executors` as compatibility management URLs

## Follow-on work

Remaining work that is not part of this completed refactor is tracked elsewhere, especially:

- [main-branch-migration-and-remediation-plan.md](/Users/danielsava/work/file-parser/proxies/soul-gateway/docs/main-branch-migration-and-remediation-plan.md)

That plan covers importing historical data from the older `main` branch Soul Gateway implementation and any remaining remediation around that migration path.
