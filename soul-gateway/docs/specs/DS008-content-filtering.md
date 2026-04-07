# DS008 — Content Filtering

## Summary

This spec describes the two content-filtering surfaces in Soul Gateway: blacklist rules evaluated against incoming messages before the request is dispatched, and regex-based response filters applied to LLM responses before they return to the client. Both are configurable at the gateway level, overridable per tier and per model, and managed via the Content policy management API.

For behavioral loop detection (a separate kind of content analysis), see DS010.

## Pre-dispatch blacklist

The system scans incoming messages against a configurable set of content policy rules before sending them to an LLM. The blacklist check runs as a pre-dispatch middleware, so a matching request short-circuits the pipeline and never reaches the upstream provider.

### Rule types

Rules support three match types:

- **Exact match** — the incoming text must equal the pattern exactly (with optional case sensitivity).
- **Substring match** — the pattern must appear as a substring of any incoming message.
- **Regular expression match** — the pattern is compiled as a regex and evaluated against each incoming message. Invalid regex patterns are rejected at rule-creation time.

### Rule evaluation

- Rules are evaluated in order until the first match.
- When a rule matches, the request is blocked immediately with a structured error response indicating that content was blocked. The rule description is included in the error detail for auditability.
- Blocked requests are recorded in the audit log with a `content_blocked` flag and the matching rule id, so operators can review false positives.
- A blocked request does not count against the RPM limit (it still occupies the middleware slot, but no upstream call is made, so quota is not consumed).

### Rule management

Rules are created, updated, enabled/disabled, and deleted via the management API. The dashboard exposes a Blacklist tab for live management. Rule mutations trigger a runtime refresh so subsequent requests see the updated rule set without a process restart.

Per-rule fields:

| Field | Type | Description |
|---|---|---|
| `id` | uuid | Primary key |
| `pattern` | text | The match pattern (plain text, substring, or regex source) |
| `match_type` | enum | `exact` / `substring` / `regex` |
| `description` | text | Human-readable description shown in errors and audit logs |
| `enabled` | boolean | Disabled rules are skipped during evaluation |
| `case_sensitive` | boolean | For `exact` and `substring` match types |

## Post-dispatch response filter

The system can apply configurable find-and-replace patterns to LLM responses for redaction or sanitization (e.g. masking emails, API keys, or PII). The response filter runs as a post-dispatch middleware after the full response has been buffered.

- Each pattern is a regex with an associated replacement string and regex flags.
- Patterns are applied in order; each replacement operates on the output of the previous one.
- Non-streaming responses are filtered in place before returning to the client.
- Streaming responses are filtered after the stream tap collects the full content. Clients still receive the raw stream for latency reasons; the filtered content is what the audit log records.

### Pattern configuration

Response filter patterns are configurable globally, per tier, or per model. A tier or model override replaces the gateway-level pattern list for requests that route through it — overrides are not merged with the global list.

Per-pattern fields:

| Field | Type | Description |
|---|---|---|
| `pattern` | text | Regex source |
| `replacement` | text | Replacement string (may include capture-group references) |
| `flags` | text | Regex flags (e.g. `gi` for global, case-insensitive) |
| `description` | text | Human-readable description |

## Related specs

- **DS003** — both filters run as gateway middlewares; see the middleware framework for hook semantics and error handling.
- **DS006** — the `blacklist` table backing pre-dispatch rules.
- **DS010** — behavioral loop detection is a separate form of content analysis with its own spec.
- **DS014** — the content blocker and response filter are both listed in the built-in middleware catalog.
- **DS015** — content_blocked flags in the audit log.
