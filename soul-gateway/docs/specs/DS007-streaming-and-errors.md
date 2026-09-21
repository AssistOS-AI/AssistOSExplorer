---
title: DS007-streaming-and-errors
summary: Defines canonical streaming, buffering, disconnect handling, error classification, retries, cascades, and client error envelopes.
---

## Introduction

Soul Gateway normalizes provider output before protocol egress and classifies failures before deciding whether to retry, cascade, cool down a model, or return an error. These contracts keep streaming and buffered callers consistent across provider families.

## Core Content

### Canonical stream

Every streaming backend must produce the [canonical stream](../wiki.html#definition-canonical-stream). A valid stream must establish the assistant message before emitting content, preserve text and tool-call deltas, emit normalized usage when available, carry a finish reason, and terminate once. Provider-specific thinking events may be omitted when the caller protocol has no supported equivalent.

The canonical stream also has one internal event, the [liveness event](../wiki.html#definition-liveness-event) <code>activity</code>, which carries no client content. The Achilles bridge emits <code>{ type: 'activity', data: { kind: 'reasoning' } }</code> for every AchillesAgentLib <code>thinking_delta</code> (streamed model reasoning, which the OpenAI-compatible transport reads from <code>delta.reasoning</code> or <code>delta.reasoning_content</code>) and does not forward the reasoning text. Liveness events exist only so that deadlines can tell a working upstream from a stalled one. Stream priming consumes them before and after commit, so provider middleware, response buffering, response capture, protocol serializers, and callers never receive one; the stream lease also drops any that reach it. Forwarding reasoning text to callers is outside this contract.

The stream adapter must not duplicate message-start, usage, or completion events when an upstream library emits partial or repeated terminal information. Tool-call identifiers, names, argument fragments, and indexes must remain stable enough for protocol serializers to reconstruct the call.

### Streaming egress

OpenAI Chat, Anthropic Messages, and OpenAI Responses routes must serialize canonical events using their own event names and payload shapes. A streaming response must set the appropriate content type, disable intermediary buffering where required, and end exactly once. Heartbeats for management log streams are separate from model response events.

### Stream priming and commit

Backends return lazy canonical streams: the upstream request is sent only when the first event is pulled. [Stream priming](../wiki.html#definition-stream-priming) runs next to the backend inside every attempt, buffered or streamed, and pulls upstream events until the first content event, a <code>text_delta</code> or <code>tool_call_delta</code>, or until a <code>done</code> event or the end of the stream. A failure before that point is an ordinary attempt error, so retry and cascade handle an HTTP 404, 429, or 5xx, or a silent upstream, in streamed mode exactly as in buffered mode. The pulled events are replayed at the head of the returned stream.

Two optional pre-commit deadlines bound the wait for the first content event more tightly than the whole-attempt deadline, and either one aborts the attempt with a provider timeout:

| Setting | Meaning |
| --- | --- |
| <code>retryPolicy.firstEventTimeoutMs</code> | Silence window. It starts with the attempt and restarts on every liveness event, so a model that streams reasoning for longer than the window is not abandoned. Other events do not restart it, so a trickle of usage or metadata events cannot keep a silent model alive. |
| <code>retryPolicy.firstContentTimeoutMs</code> | First-content cap. An absolute limit from the attempt start to the first <code>text_delta</code> or <code>tool_call_delta</code>, so an upstream that reasons without end still yields to the next model. |

SSE comment lines such as <code>: keepalive</code> never reach priming, because the SSE parser drops them. That is intended: a router such as OpenRouter sends them while it waits for its model, so they prove only that the router is alive. A row that sets only <code>firstEventTimeoutMs</code> therefore gets a silence window, not an absolute first-event limit; the whole-attempt deadline remains the absolute bound.

A stream that reaches <code>done</code> or its end without any text or tool-call delta is an empty response, for example a reasoning-only answer cut off by the token limit or an empty HTTP 200 stream. The attempt then fails with <code>provider_server_error</code> and the message <code>Provider returned an empty response</code>; it is not retried and may cascade to the next child. <code>usage</code> and <code>done</code> events never commit a response on their own.

The first text or tool-call delta commits the response. After commit, a failure must never be replaced by another model's output: the error boundary terminates the caller's stream with the route's protocol error event, and the SSE response is left open until that event is written. A buffered request sends nothing until the response is complete, so a failure after partial upstream output can still retry or advance the cascade.

### Timeouts and cancellation

Every attempt has a deadline from <code>requestTimeoutMs</code> (per model or per cascade child), falling back to <code>DEFAULT_REQUEST_TIMEOUT_MS</code>. The attempt deadline is linked to the caller's signal, so a client disconnect or an expired [tier budget](../wiki.html#definition-tier-budget) always reaches the upstream transport. A buffered attempt completes inside that deadline, which therefore bounds its whole upstream exchange.

A streamed attempt returns while its upstream is still producing events, so its whole-attempt deadline stops on return and two deadlines bound the rest of the stream:

| Deadline | Meaning |
| --- | --- |
| Idle | <code>retryPolicy.streamIdleTimeoutMs</code> for the model or child, falling back to <code>STREAM_IDLE_TIMEOUT_MS</code> (default 300000 ms). It restarts on every event, liveness events included, so a model that streams reasoning is not treated as stalled. |
| Content gap | <code>max(streamIdleTimeoutMs, firstContentTimeoutMs)</code>, measured from the last content event. Only a <code>text_delta</code> or <code>tool_call_delta</code> restarts it, so a committed stream whose upstream reasons without end, or keeps sending usage or metadata events, still terminates. A model without a first-content cap is therefore cut one idle deadline after its last content event, whatever it emits in between. |

Every execution deadline is capped at 2147483647 ms, the longest delay a timer can represent: the attempt deadline, the two pre-commit deadlines, the idle and content-gap deadlines, the [tier budget](../wiki.html#definition-tier-budget), the model queue wait (<code>queueTimeoutMs</code>), and the retry backoff. A larger configured value means "practically never" and is treated as that maximum; it must never overflow into an almost immediate abort, rejection, or retry. A delay that is not a positive number becomes zero, which is what a timer does with it anyway. <code>src/runtime/execution/timer-delay.mjs</code> owns the ceiling and every timer of the execution chain passes through it.

Either deadline aborts the stream with a provider timeout, and the upstream request is also aborted when the consumer stops reading early. After commit, the abort reaches the caller as the route's protocol error event on an already-started response.

Each public request carries an abort signal that fires when the client connection closes before the response has ended. It cancels the in-flight upstream request, stops further retries (backoff sleeps end immediately), and stops the cascade before the next child. The resulting internal error carries status 499 for logs and audit records; nothing is sent to the departed client. The gateway must release concurrency and credential leases in every outcome.

### Buffered responses

A non-streaming request must collect canonical events into one completed response and retain bounded excerpts for observability. Buffering must combine text and tool-call fragments, normalize usage, and preserve finish and model metadata. The response serializer must emit the envelope matching the ingress protocol rather than exposing the canonical internal representation.

### Error classification

Provider backends must classify authentication, quota, rate-limit, content-policy, model-not-found, timeout, unavailable, bad-request, malformed-provider-response, and other supported failures. A classified error must carry a stable gateway error type, client HTTP status, and explicit retry, cascade, and cooldown flags where applicable. The OpenAI-compatible classifier in <code>src/runtime/backends/openai-compatible-errors.mjs</code> reads the upstream status, parsed body, and rate-limit headers that AchillesAgentLib attaches to HTTP errors:

| Upstream response | Classification and effect |
| --- | --- |
| 401 | <code>provider_auth_error</code> (HTTP 502), [account-scoped](../wiki.html#definition-account-scoped-failure): no retry; the cascade skips remaining children on the same provider. |
| 402 | <code>provider_quota_exhausted</code> (HTTP 429), account-scoped: no retry, no model cooldown; the cascade skips the provider. |
| 403 | <code>provider_auth_error</code> (HTTP 502), model-specific: no retry; the cascade may try the next child. A model blocked by the free-only policy before dispatch fails with the same error type. |
| 404 | <code>provider_model_not_found</code> (HTTP 502): no retry; the cascade may try the next child. |
| 408 | <code>provider_timeout</code> (HTTP 504): retryable and may cascade. |
| 429 with a daily or billing quota signal | <code>provider_quota_exhausted</code> (HTTP 429), account-scoped. A quota signal is an <code>insufficient_quota</code> or <code>billing_hard_limit_reached</code> error type, a message matching free-models-per-day, per-day, daily limit or quota, insufficient credits, or billing, or <code>x-ratelimit-remaining: 0</code> with a reset more than five minutes away. The account is marked exhausted until <code>x-ratelimit-reset</code>, clamped to between one minute and 26 hours; without a reset header, for at most 15 minutes (or until the next UTC midnight if sooner), after which the account is tried again. No model cooldown is recorded. |
| Other 429, including per-minute limits and messages that only mention a quota | <code>provider_rate_limited</code> (HTTP 429), one model's momentary capacity: retryable, may cascade, and cools the model down for the <code>retry-after</code> duration clamped to between 5 seconds and 10 minutes, defaulting to 60 seconds. |
| 400 with <code>content_policy_violation</code> | <code>provider_content_policy</code> (HTTP 400): may cascade. |
| Other 4xx | <code>provider_bad_request</code> (HTTP 400) with the upstream message truncated to 500 characters: no retry and no cascade, because every model and attempt would receive the same request. |
| 5xx and transport failures | Server-error or unavailable classification: retryable and may cascade. |

Without an attached upstream status the classifier can only treat a failure as a transport or server error, which is why AchillesAgentLib must attach status, body, and rate-limit headers to HTTP errors. An unclassified error must fail without implicit cascade. A model-level cooldown must use the provider error duration, model retry policy, or global <code>COOLDOWN_DURATION_MS</code> in that precedence order.

### HTTP retry and cascade

Retry middleware must cap attempts, apply configured exponential backoff and jitter, and record bounded retry trace entries. It must create a fresh attempt context, timeout, credential lease, and provider-binding execution for each try. Non-retryable errors and an aborted request signal must leave the loop immediately.

A [cascade model](../wiki.html#definition-cascade-model) must treat each child invocation as a complete direct-model execution. A child failure marked <code>cascade=true</code> may advance to the next eligible child. An account-scoped failure removes the failed provider's remaining children from the walk. When every candidate failed for an account reason, the caller must receive that error, for example HTTP 429 <code>provider_quota_exhausted</code> or HTTP 502 <code>provider_auth_error</code>; a provider with no usable account fails fast with <code>provider_accounts_exhausted</code> without an upstream call. Other exhaustion must return a tier-exhausted error and must not conceal the fact that no configured child succeeded.

### Client-visible errors

Before response headers are sent, the error boundary must return a structured JSON error in the caller's protocol with the correct HTTP status. After a stream starts, it must emit the supported protocol error event and close the stream; a committed stream that fails is never ended silently or truncated without that event. Error output and audit storage must redact secrets and must not include provider credentials, encryption material, raw OAuth tokens, or Router invocation tokens.
