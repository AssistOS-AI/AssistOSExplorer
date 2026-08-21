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
