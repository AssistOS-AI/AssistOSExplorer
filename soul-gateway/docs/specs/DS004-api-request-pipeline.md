---
title: DS004-api-request-pipeline
summary: Defines public routes, ingress normalization, validation, identity, model resolution, sessions, and protocol egress.
---

## Introduction

The public request pipeline converts supported HTTP protocols into one runtime contract and converts the completed result back into the caller's protocol. Its ordering establishes the security, consistency, and error boundaries used by every completion request.

## Core Content

### Public routes

Soul Gateway must register <code>POST /v1/chat/completions</code>, <code>POST /v1/messages</code>, <code>POST /v1/responses</code>, <code>POST /v1/embeddings</code>, and <code>GET /v1/models</code>. Completion routes must enter <code>runRouteRequest()</code> with the correct route kind. The model list must authenticate the caller and enumerate the current [runtime snapshot](../wiki.html#definition-runtime-snapshot) without a database or provider network call.

### Route composition

The completion route must compose these responsibilities in order: error boundary, body parsing, authentication, identity, snapshot binding, ingress normalization, audit initialization, request validation, model resolution, agent-model loop protection, session resolution, response serialization, and gateway dispatch. Around-style middleware ordering must allow gateway dispatch to set the response before the response middleware serializes it.

The body parser must enforce <code>BODY_LIMIT_BYTES</code>, require valid JSON, and produce a structured request-body error. Authentication must finish before model resolution or backend execution. One immutable snapshot generation must remain bound for the request lifetime.

### Normalization and validation

OpenAI Chat, Anthropic Messages, and OpenAI Responses inputs must become the same [canonical request](../wiki.html#definition-canonical-request). Normalization must preserve supported messages, system instructions, tools, streaming intent, token controls, and provider options. Validation must reject missing model names, malformed messages, unsupported values, and invalid tool structures before execution.

Identity may derive <code>soulId</code>, agent name, session hints, and other supported metadata from request headers after authentication. Identity metadata must not replace the signed-subject security decision.

### Resolution and sessions

Model resolution must apply the supported model-name normalization and alias lookup and must return a model-not-found error for an unknown or disabled target. An agent request that resolves back to its own prohibited delegated model route must fail before dispatch to prevent a routing loop.

Session resolution must group requests using verified API-key identity and available soul or agent identity. Session state may support loop detection, context middleware, audit grouping, and management views; it must not grant authorization beyond the API-key subject.

### Egress

A streaming request must serialize the [canonical stream](../wiki.html#definition-canonical-stream) as OpenAI Chat SSE, Anthropic event streams, or OpenAI Responses events according to the ingress route. A non-streaming request must buffer canonical events and return the matching JSON envelope. Client disconnect must abort or stop downstream work where the active backend supports cancellation.

Structured errors must preserve a stable error type and request context. When a streaming response has already started, the error boundary must emit a protocol-compatible terminal error event rather than attempt a second HTTP status response.
