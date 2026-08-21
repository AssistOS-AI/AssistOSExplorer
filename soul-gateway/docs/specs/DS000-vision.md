---
title: DS000-vision
summary: Defines Soul Gateway's purpose, users, system boundary, and product-level success conditions.
---

## Introduction

Soul Gateway gives Ploinky agents, authenticated users, and compatible clients one governed interface for language-model execution. It removes provider routing, credential handling, retry policy, and protocol conversion from callers while preserving explicit security and operational boundaries.

## Core Content

### Product purpose

Soul Gateway must accept supported model requests through the Ploinky Router, authenticate the caller, apply centrally configured policy, route the request to an eligible model, and return a response in the caller's selected protocol. A client must be able to change providers or use a [compatibility tier](../wiki.html#definition-compatibility-tier) without implementing provider credentials, retry rules, cooldown handling, or provider-specific stream parsing.

### Users and outcomes

Ploinky agents must be able to call stable OpenAI-compatible model names with their generated [signed-subject keys](../wiki.html#definition-signed-subject-key). Authenticated users must be able to use encoded user keys for the same public model interface. Ploinky administrators must be able to configure providers, models, policy, and credentials and inspect usage through the Router-protected management surface.

### System boundary

Soul Gateway owns ingress normalization, caller authentication, model and alias resolution, gateway and provider middleware, credential leasing, concurrency, retries, cascade routing, response normalization, SQLite persistence, management operations, and observability. The [Ploinky Router](../wiki.html#definition-ploinky-router) owns external agent-port routing and protected-route user identity. [AchillesAgentLib](../wiki.html#definition-achilles-agent-lib) owns request-time vendor LLM transport. The Ploinky-agent backend owns exact-byte signing and transport for authenticated Router capability calls.

Provider lifecycle probes and catalog discovery may contact vendor metadata interfaces directly. Those operations must not become an alternate completion or generation path. Search providers may own provider-specific execution behind the standard model interface because search is a gateway backend rather than an LLM protocol-family transport.

### Success conditions

The product succeeds when an authenticated caller can select an addressable direct model, alias, or cascade tier; receive a valid buffered or streamed protocol response; and rely on configured security, budget, content, retry, and observability rules across provider changes. Operators must be able to restart or upgrade the agent without losing the SQLite database, encryption key, managed credentials, or the stable public route contract.
