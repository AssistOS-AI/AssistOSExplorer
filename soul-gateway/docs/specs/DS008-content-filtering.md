# DS008 — Content Filtering

## Summary

Soul Gateway has two built-in content-policy surfaces:

- blacklist blocking before dispatch
- response filtering after buffered responses

Both are configured through management APIs and middleware bindings.

## Pre-dispatch blacklist

The `content-blocker` middleware checks incoming request messages against blacklist rules before any upstream call happens.

Supported rule types:

- exact match
- substring match
- regex

On match, the middleware aborts the request with a structured content-blocked error.

## Post-dispatch response filter

The `response-filter` middleware applies regex replacements to buffered response content.

Current behavior:

- buffered responses can be filtered in place
- streaming responses are not filtered in real time by the gateway middleware path
- in streaming mode any response filter that needs buffered content must drain the stream first

## Override scopes

Filtering behavior can be changed by binding middleware at:

- gateway scope
- direct-model scope
- cascade-model scope

The dashboard's tier compatibility views edit cascade-model bindings under the hood.

## Related specs

- **DS001** — where content policy runs in the route/gateway chain
- **DS005** — why streaming responses bypass buffered post-only filters
- **DS012** — blacklist and middleware management APIs
- **DS014** — built-in content blocker and response filter entries
