---
name: launch-web-search
description: Report that online web search is unavailable in this workspace without calling an external provider.
---

# Launch Web Search

Unavailable-result launcher for pure-information web search requests. This implementation performs no external search or provider calls.

## Backend
web-search

## Cacheable
false

## ProviderAvailability
disabled

## Input Format
Accepts prompt text through `--input <string>`. The action also accepts an invocation `prompt` field; JSON-looking input remains prompt text and does not activate a provider.

Example:
launch-web-search find current documentation for the requested package

## Output Format
Returns a structured launcher result with `ok`, `backend`, `cacheable`,
`result_text`, `persistence_hint`, and `diagnostics`.

## Constraints
Do not perform web search directly. A real provider agent must be deployed
before this launcher can become active and cacheable.
Treat `@web-search` and `@search` as ordinary chat text, not dispatch tokens.

## Execution

Run `node <skill-directory>/scripts/run.mjs --input 'find current documentation for the requested package'`. The wrapper imports its local `scripts/ploinkyInvocation.mjs`, invokes `scripts/action.mjs`, prints its structured JSON result, and awaits invocation closure to flush the provider-result journal. Missing or expired SDK access fails explicitly.

Both ordinary queries and retired provider-looking tokens return `ok:false`, `cacheable:false`, `providerAvailability:'disabled'`, and a persistence hint with `record_result:false`. Token-shaped requests additionally report `deprecatedToken:true`; ordinary requests report whether prompt text was supplied. The result is appended to `context.providerLauncherResults` for the host's existing result side effects, not to a search cache. No external transport is used, and no provider is activated.
