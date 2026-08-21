---
title: DS007-streaming-and-errors
summary: Defines canonical streaming, buffering, disconnect handling, error classification, retries, cascades, and client error envelopes.
---

## Introduction

Soul Gateway normalizes provider output before protocol egress and classifies failures before deciding whether to retry, cascade, cool down a model, or return an error. These contracts keep streaming and buffered callers consistent across provider families.

## Core Content

### Canonical stream

Every streaming backend must produce the [canonical stream](../wiki.html#definition-canonical-stream). A valid stream must establish the assistant message before emitting content, preserve text and tool-call deltas, emit normalized usage when available, carry a finish reason, and terminate once. Provider-specific thinking events may be omitted when the caller protocol has no supported equivalent.

The stream adapter must not duplicate message-start, usage, or completion events when an upstream library emits partial or repeated terminal information. Tool-call identifiers, names, argument fragments, and indexes must remain stable enough for protocol serializers to reconstruct the call.

### Streaming egress

OpenAI Chat, Anthropic Messages, and OpenAI Responses routes must serialize canonical events using their own event names and payload shapes. A streaming response must set the appropriate content type, disable intermediary buffering where required, and end exactly once. Heartbeats for management log streams are separate from model response events.

Client disconnect must signal cancellation through the request context. Backends should abort active provider work when their transport exposes cancellation. The gateway must release concurrency and credential leases even when the client disconnects.

### Buffered responses

A non-streaming request must collect canonical events into one completed response and retain bounded excerpts for observability. Buffering must combine text and tool-call fragments, normalize usage, and preserve finish and model metadata. The response serializer must emit the envelope matching the ingress protocol rather than exposing the canonical internal representation.

### Error classification

Provider backends must classify authentication, quota, rate-limit, content-policy, model-not-found, timeout, unavailable, malformed-provider-response, and other supported failures. A classified error must carry a stable gateway error type, client HTTP status, and explicit retry, cascade, and cooldown flags where applicable.

An unclassified error must fail without implicit cascade. Authentication or quota errors may rotate accounts or advance only when the classifier permits it. A model-level cooldown must use the provider error duration, model retry policy, or global <code>COOLDOWN_DURATION_MS</code> in that precedence order.

### HTTP retry and cascade

Retry middleware must cap attempts, apply configured exponential backoff and jitter, and record bounded retry trace entries. It must create a fresh attempt context, timeout, credential lease, and provider-binding execution for each try. Non-retryable errors must leave the loop immediately.

A [cascade model](../wiki.html#definition-cascade-model) must treat each child invocation as a complete direct-model execution. A child failure marked <code>cascade=true</code> may advance to the next eligible child. Exhaustion must return a tier-exhausted error and must not conceal the fact that no configured child succeeded.

### Client-visible errors

Before response headers are sent, the error boundary must return a structured JSON error in the caller's protocol with the correct HTTP status. After a stream starts, it must emit the supported protocol error event and close the stream. Error output and audit storage must redact secrets and must not include provider credentials, encryption material, raw OAuth tokens, or Router invocation tokens.
