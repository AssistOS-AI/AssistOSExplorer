---
title: DS009-policy-and-safety
summary: Defines rate, token, budget, content, loop, caching, compression, and session policy boundaries.
---

## Introduction

Soul Gateway policy modules protect shared provider capacity, spending limits, content boundaries, and long-running agent sessions. Policy can be bound at gateway, model, provider, or API-key-related scopes only where the individual module supports that scope.

## Core Content

### Rate and token limits

Request-rate enforcement must use a sliding one-minute window keyed by the authenticated API-key record and must apply the effective request-per-minute limit before provider execution. Token-rate enforcement must estimate prompt tokens before dispatch and add actual completion usage when available. Limits may come from API-key, model, or configured defaults only according to the module's explicit precedence.

A rejected request must return a classified rate-limit error and must not lease provider credentials. In-memory windows are process-local and reset when the gateway restarts; persistent usage and cost reporting remain in audit records.

### Budgets and pricing

Budget enforcement must calculate effective daily and monthly limits from the authenticated key and supported overrides. It must query or cache authoritative spend and compare the projected or recorded cost according to the policy module's phase. Cost calculation must use stored or enriched model pricing and normalized token usage.

When a model's pricing contract is insufficient, the gateway must not invent a monetary charge. An explicitly free model has zero cost. External-directory pricing remains bounded by the directory entry and provenance applied during model metadata enrichment.

### Free-only provider policy

A provider whose <code>settings.free_only</code> is <code>true</code> is a [free-only provider](../wiki.html#definition-free-only-provider): it may only store and execute models that are provably free. The first-start <code>openrouter-free</code> provider sets this flag; other providers are unaffected. Three gateway checks in <code>src/runtime/providers/free-model-policy.mjs</code> enforce the policy, and none replaces the upstream account limits of the bundled key (a zero credit limit and a guardrail that allows only free models).

Catalog admission runs for startup, periodic, and manual synchronization, and it also filters model lists that a caller passes to synchronization directly. A discovered entry is admitted only when its identifier has the form <code>vendor/model:free</code> or is exactly <code>openrouter/free</code>, <code>pricing.prompt</code> and <code>pricing.completion</code> are present, and every present pricing value, including nested values, is an explicit zero: the number 0 or a string of zero digits. Booleans, null, blank strings, negative numbers, negative zero, non-finite numbers, and exponent notation are rejected. When the entry declares an architecture block, it must accept text input and produce text output and must not produce embeddings. The identifier must also name a general chat model: an identifier containing <code>safety</code>, <code>shield</code>, <code>guard</code>, <code>moderation</code>, <code>embed</code>, <code>rerank</code>, <code>classif</code>, or <code>reward</code> is never stored, because a classifier, reranker or embedding model answers with a verdict, a score or a vector instead of assistant text, even when free. A catalog entry carries no machine-readable task, so this is a test of the name; the token list is narrow because admitting a classifier is the failure that matters, and it rejects the rare chat model whose name merely contains a token, which only makes that model unavailable. The backend applies the pricing and architecture checks while it parses the catalog; <code>src/runtime/providers/discovery-admission.mjs</code> applies the identifier and normalized-pricing checks inside <code>syncProviderModels</code>, which every synchronization path reaches.

A synchronized model that the catalog later reprices or removes is disabled, and an administrator-disabled model stays disabled. Whether a catalog may disable rows is decided in one place, <code>syncProviderModels</code>, for every caller: startup, periodic refresh, manual synchronization, key replacement, OAuth completion, and caller-supplied lists. An empty incoming list is uninformative, because it can mean an upstream outage or a discovery fallback, so it never disables stored synchronized rows. When the provider holds at least one non-manual row, the sync does no work and reports the skip as <code>emptySkipped</code>: the periodic refresh counts it in its summary and <code>POST /management/providers/:providerId/sync-models</code> returns it, so all-zero counters are distinguishable from a catalog that was simply unchanged. When the provider holds no non-manual row there is nothing to protect and the empty list is synchronized normally. A list that the upstream returned non-empty but from which no entry is admissible is policy-filtered: the upstream answered and nothing on it is allowed, so previously synchronized models are disabled. The backend marks a list it filtered itself with a non-enumerable <code>policyFiltered</code> property, which array filtering drops, so the decision reads it from the original list before any filtering and also treats a list emptied by the second admission step as policy-filtered. For a free-only provider, an HTTP 404 on the configured discovery path fails the synchronization instead of falling back to an empty list, because that provider's catalog is its admission source.

Execution admission rejects a model identifier without an approved free form before any upstream request. The rejection is model-scoped: a cascade may continue with another free child, and it is not retried. Request hardening then runs after every other parameter merge, including provider <code>extra_body</code> settings and per-child reasoning parameters. It forces the OpenRouter price ceiling <code>provider.max_price</code> to zero for prompt, completion, request, and image, and it removes the <code>model</code>, <code>messages</code>, <code>models</code>, <code>route</code>, <code>plugins</code>, and <code>transforms</code> keys from the provider options, so no provider setting can add paid fallback models, routing, or plugins. Clients cannot supply these fields because the chat parameters sent upstream come from a fixed list of request fields. Embedding requests to a free-only provider are refused with <code>provider_bad_request</code>.

The upstream guardrail rejects a paid model independently of these checks; in live verification OpenRouter answered a paid model request through the bundled key with HTTP 404 <code>Model blocked by guardrail</code>, and the account's usage stayed at zero.

### Content blocking and response filtering

Pre-dispatch content blocking must evaluate enabled exact, substring, or regular-expression rules in priority order against supported request message content. A matching mandatory rule must stop execution and return a content-policy error. Invalid stored regular expressions must be handled according to the policy implementation without exposing an untrusted pattern as executable source outside the matcher.

Post-dispatch response filtering may redact or replace configured patterns in buffered text and streaming deltas. Filtering must preserve the surrounding protocol structure and tool-call data unless the module explicitly owns tool content.

### Loop detection

Loop detection must associate observations with the resolved session and evaluate repeated response fingerprints, similarity across a bounded window, repetitive ratios, and token growth only after the configured minimum observations. Its response mode may warn, inject an intervention, or stop according to explicit settings. It must not classify one repeated short response as an agent loop before the minimum evidence threshold.

The route-level agent-model loop guard is separate: it prevents a Ploinky agent request from routing back to a prohibited model endpoint owned by the same agent before backend dispatch.

### Context, prompts, caching, and compression

System-prompt injection and session-context middleware may add supported messages before dispatch. Context compression may reduce earlier content when token estimates exceed configured bounds while preserving required recent or system content. Output compression may transform response content after generation only within its documented settings.

Response caching must key entries from stable request and route content and must preserve streaming or buffered semantics on replay. Caches and session summaries are process-local unless a specialized module persists them. Cache hits must not bypass authentication or a mandatory gateway policy that is ordered before the cache binding.

### Failure policy

Authentication, mandatory budget, mandatory rate, and mandatory content checks must fail closed when their required state cannot be evaluated safely. Optional logging, caching, enrichment, and compression may fail open only when their module contract preserves the original valid request or response and records the failure.
