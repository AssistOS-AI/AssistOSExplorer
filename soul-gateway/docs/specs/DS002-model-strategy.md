---
title: DS002-model-strategy
summary: Defines addressable models, aliases, direct and cascade execution, standard tiers, metadata, and transport ownership.
---

## Introduction

Soul Gateway presents direct models, aliases, and cascade tiers through one model namespace. The model strategy determines which provider execution path runs while keeping caller protocols independent from provider configuration.

## Core Content

### Addressable model namespace

Every enabled [direct model](../wiki.html#definition-direct-model), [cascade model](../wiki.html#definition-cascade-model), and alias must have a unique addressable name in the [runtime snapshot](../wiki.html#definition-runtime-snapshot). Model-name normalization may remove supported compatibility prefixes and resolve aliases, but it must not silently select an unrelated model when the requested name is absent.

<code>GET /v1/models</code> must enumerate addressable models and aliases in an OpenAI-compatible list. Gateway metadata may add pricing, context, tag, free-model, billing-type, and cascade child-count fields without changing the base model fields expected by compatible clients.

### Direct execution

A direct model must reference one provider and one provider model identifier. Execution must apply its concurrency and queue limits, retry and request timeouts, provider middleware, and a temporary [credential lease](../wiki.html#definition-credential-lease). A vendor LLM [provider backend](../wiki.html#definition-provider-backend) must use AchillesAgentLib for request-time inference. A Ploinky-agent backend may use its signed exact-byte Router capability transport. Every backend must normalize its result into the [canonical stream](../wiki.html#definition-canonical-stream).

### Cascade execution

A cascade model must contain ordered child references and must not own provider credentials. It must try the highest-priority enabled child that is not excluded by a current cooldown or an earlier failed attempt. Only a classified error with <code>cascade=true</code> may advance to another child. A classified cooldown error must persist cooldown state and request a snapshot refresh without delaying the in-flight attempt transition.

The cascade must stop after its configured maximum attempts or when no eligible child remains and return a tier-exhausted error. It must preserve the successful child's response and attach attempt, model, account, retry, and queue metadata used by observability.

### Standard tiers and reconciliation

The compatibility names <code>fast</code>, <code>plan</code>, and <code>deep</code> are stable model identifiers configured through <code>LLM_DEFAULT_TIERS</code>. On a new database, tier seeding may bind these aliases to the discovered model for <code>LLM_DEFAULT_AGENT</code>. Seeding must remain idempotent and must not overwrite an operator-owned conflicting model or alias.

Tag-tier reconciliation may create or update cascade models derived from predefined tags. Reconciliation must preserve manually owned model configuration outside the records it owns and must request a new runtime snapshot after material catalog changes.

### Metadata and pricing

Model metadata may combine provider discovery, curated metadata, and an external pricing directory. Explicit stored values must retain precedence where the classifier contract requires them. Pricing may be token-based, request-based, free, or externally resolved. Budget enforcement must not invent a cost when the selected model lacks sufficient pricing evidence.

### Transport boundary

Soul Gateway may own direct HTTP for connectivity checks and model discovery because those operations validate or synchronize provider state. It must not use those lifecycle paths to serve completion or generation results. A new vendor LLM protocol family must first exist in AchillesAgentLib. The exact-byte Ploinky-agent capability route is limited to authenticated Router delegation, and a new search backend must remain behind the standard model interface.
