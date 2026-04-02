# DS012 -- API Reference

## Summary

Complete API endpoint documentation for Soul Gateway. Covers the primary proxy endpoints (OpenAI-compatible chat completions, Anthropic passthrough, OpenAI Responses passthrough), model discovery, health checks, and the full management API for keys, models, providers, tiers, middlewares, logs, sessions, metrics, and data export.

All management endpoints are served under `/api/v1/` and are intended for the dashboard. Proxy and agent-facing endpoints are served under `/v1/` (with optional prefix omission).

---

## Proxy Endpoints

### POST /v1/chat/completions

Send a chat completion request. The gateway authenticates the request, resolves the model (or tier), runs pre-dispatch middlewares, dispatches to the upstream provider with automatic retry and cooldown fallback, taps the response stream, runs post-dispatch middlewares, calculates costs, and logs the full call.

Also available at `/chat/completions` (without the `/v1` prefix).

#### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <api-key>` -- API key created via the dashboard or management API. |
| `Content-Type` | Yes | `application/json` |
| `X-Soul-Id` | No | Caller identity for log grouping. Defaults to `"anonymous"`. |
| `X-Soul-Agent` | No | Agent name for tracking. Automatically set by achillesAgentLib from `AGENT_NAME` env var. |
| `X-Soul-Session` | No | Session identifier for grouping related requests. |

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model name or tier name (e.g. `"copilot/gpt-4o"`, `"axl/fast"`). |
| `messages` | array | Yes | Array of message objects with `role` and `content` fields. |
| `stream` | boolean | No | Enable Server-Sent Events streaming. Default: `false`. |
| `temperature` | number | No | Sampling temperature (0--2). Passed through to provider. |
| `max_tokens` | integer | No | Maximum tokens to generate. Passed through to provider. |
| `tools` | array | No | Tool/function definitions. Passed through to provider. |
| `tool_choice` | string\|object | No | Tool choice strategy. Passed through to provider. |

All additional parameters (e.g. `top_p`, `stop`, `frequency_penalty`) are passed through transparently to the upstream provider.

#### Non-Streaming Response

```json
{
  "id": "chatcmpl-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 9,
    "total_tokens": 21
  }
}
```

#### Streaming Response (SSE)

When `stream: true`, the response is sent as Server-Sent Events. Each event is a `data:` line followed by two newlines:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}

data: [DONE]
```

#### Error Responses

| Status | Type | Description |
|--------|------|-------------|
| 400 | `invalid_request_error` | Missing required fields (`model`, `messages`). |
| 400 | `content_blocked` | Request blocked by blacklist content filter. |
| 401 | `authentication_error` | Missing, invalid, expired, or revoked API key. |
| 404 | `model_not_found` | Requested model or tier not found or not enabled. |
| 429 | `rate_limit_error` | Per-key RPM or TPM limit exceeded. Includes `Retry-After` header. |
| 429 | `budget_exceeded` | Daily budget exhausted. Includes `Retry-After` header. |
| 429 | `loop_detected` | Duplicate request loop detected. `Retry-After: 30`. |
| 502 | `upstream_error` | All upstream provider attempts failed. |
| 503 | `queue_timeout` | Model concurrency queue timed out. `Retry-After: 10`. |
| 500 | `internal_error` | Unexpected server error. |

Error response body format:

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded"
  }
}
```

#### Example: Non-Streaming Request

```bash
curl -X POST http://localhost:8042/v1/chat/completions \
  -H "Authorization: Bearer sk-soul-your-key-here" \
  -H "Content-Type: application/json" \
  -H "X-Soul-Id: my-app" \
  -H "X-Soul-Agent: my-agent" \
  -d '{
    "model": "axl/fast",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is 2 + 2?"}
    ],
    "temperature": 0.7,
    "max_tokens": 100
  }'
```

#### Example: Streaming Request

```bash
curl -X POST http://localhost:8042/v1/chat/completions \
  -H "Authorization: Bearer sk-soul-your-key-here" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "copilot/gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

### POST /v1/messages

Passthrough endpoint for Anthropic Messages API format. Routes requests to Anthropic-protocol providers without format conversion. Also available at `/messages`.

Authentication is the same as chat completions (`Authorization: Bearer`). The request body follows the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) format.

#### Example

```bash
curl -X POST http://localhost:8042/v1/messages \
  -H "Authorization: Bearer sk-soul-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello, Claude!"}]
  }'
```

---

### POST /v1/responses

Passthrough endpoint for the OpenAI Responses API format. Routes requests to providers that support the Responses API (e.g. Codex models). Also available at `/responses`.

#### Example

```bash
curl -X POST http://localhost:8042/v1/responses \
  -H "Authorization: Bearer sk-soul-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex/gpt-5.3-codex",
    "input": "Write a hello world function in Python"
  }'
```

---

### GET /v1/models

Returns an OpenAI-compatible list of all enabled models and tiers. No authentication required (or uses API key auth if provided). Also available at `/models`.

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "copilot/gpt-4o",
      "object": "model",
      "type": "model",
      "created": 1711900000,
      "owned_by": "soul-gateway",
      "mode": "fast",
      "input_price": 2.5,
      "output_price": 10,
      "context_window": 128000,
      "sort_order": 10,
      "is_free": true,
      "billing_type": "subscription",
      "tags": ["fast", "code", "chat"]
    },
    {
      "id": "axl/fast",
      "object": "model",
      "type": "tier",
      "created": 1711900000,
      "owned_by": "soul-gateway",
      "models": ["copilot/gpt-4o", "groq/llama-3-70b"],
      "fallback": null,
      "sort_order": 50,
      "billing_types": ["subscription", "api_key"],
      "is_free": false
    }
  ]
}
```

Each entry includes a `type` field that is either `"model"` or `"tier"`. Model entries include pricing and tag information. Tier entries include their member model references and computed billing types.

> **Naming convention:** Models use a `<provider>/<model>` naming scheme without any prefix (e.g. `copilot/gpt-4o`). Tiers use an `axl/` prefix (e.g. `axl/fast`, `axl/deep`). The `axl/` prefix on tiers distinguishes them from model names in routing.

---

### GET /v1/tiers

Returns a list of enabled tiers with their member models and fallback configuration. This is the agent-facing tier listing endpoint.

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "name": "axl/fast",
      "display_name": "Fast Tier",
      "models": ["copilot/gpt-4o", "groq/llama-3-70b"],
      "fallback": null,
      "sort_order": 50
    },
    {
      "name": "axl/deep",
      "display_name": "Deep Tier",
      "models": ["copilot/gpt-4.1", "anthropic/claude-sonnet-4"],
      "fallback": "axl/fast",
      "sort_order": 60
    }
  ]
}
```

---

### GET /health

Returns the gateway health status and process uptime. No authentication required.

#### Response

```json
{
  "status": "ok",
  "uptime": 86423.456
}
```

---

### Pipeline Behavior

The chat completions pipeline executes the following steps in order:

1. **Authentication** -- Validate the Bearer token against the `api_keys` table. Reject expired or revoked keys.
2. **Agent and session identification** -- Extract agent name from `X-Soul-Agent` header (or parse from `User-Agent`), session from `X-Soul-Session`.
3. **Body parsing** -- Parse JSON body, validate required `model` and `messages` fields.
4. **Model routing** -- Resolve the requested model name to a concrete upstream model, provider, and pricing. Handles tier resolution with priority ordering.
5. **Pre-dispatch middlewares** -- Run assigned middlewares (rate limiting, budget checks, caching, blacklist, loop detection, prompt injection). May short-circuit with a cached response or block the request.
6. **Prompt hash and size check** -- Hash prompt for cache dedup, check size for warnings.
7. **Dispatch with retry** -- Send to upstream provider. On transient errors, retry with exponential backoff. On quota/rate errors, put the model in cooldown and cascade to the next model in the tier.
8. **Stream tap / response handling** -- For streaming, pipe SSE chunks to the client while accumulating content. For non-streaming, send the complete JSON response.
9. **Post-dispatch middlewares** -- Run post-processing middlewares (budget tracking, cache storage).
10. **Cost calculation** -- Calculate input/output/total cost based on token usage and model pricing.
11. **Logging and broadcasting** -- Insert the full call log and broadcast to WebSocket/SSE subscribers.

---

## Management API

### Key Management

#### GET /api/v1/keys

List all API keys with their metadata and today's spending. The `daily_spent` field shows the total cost of successful (non-free) requests since midnight UTC.

##### Response

```json
[
  {
    "id": 1,
    "label": "production-agent",
    "key_hint": "sk-soul-36cc...c01b",
    "daily_budget": "2.00",
    "rpm_limit": 60,
    "tpm_limit": 100000,
    "expires_at": null,
    "is_revoked": false,
    "last_used_at": "2026-03-31T14:23:00.000Z",
    "created_at": "2026-03-01T10:00:00.000Z",
    "daily_spent": "0.4523"
  }
]
```

The `key_hint` shows the first 12 and last 4 characters of the key for identification without revealing the full key.

---

#### POST /api/v1/keys

Create a new API key. The response includes the full plaintext key in the `key` field. This is the **only time** the plaintext key is returned -- store it securely.

> **Important:** The plaintext API key is only included in the creation response. It cannot be retrieved later. If lost, revoke the key and create a new one.

##### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `label` | string | No | `null` | Human-readable label for the key. |
| `daily_budget` | number | No | `2.00` | Daily spending limit in USD. |
| `rpm_limit` | integer | No | `60` | Requests per minute limit. |
| `tpm_limit` | integer | No | `100000` | Tokens per minute limit. |
| `expires_at` | string | No | `null` | ISO 8601 expiration timestamp. `null` for permanent keys. |
| `key` | string | No | (generated) | Custom key value. If omitted, a secure random key is generated. |

##### Example

```bash
curl -X POST http://localhost:8042/api/v1/keys \
  -H "Content-Type: application/json" \
  -d '{
    "label": "my-dev-key",
    "daily_budget": 5.00,
    "rpm_limit": 120
  }'
```

##### Response (201 Created)

```json
{
  "id": 7,
  "label": "my-dev-key",
  "key_hint": "sk-soul-a1b2...f8g9",
  "daily_budget": "5.00",
  "rpm_limit": 120,
  "tpm_limit": 100000,
  "expires_at": null,
  "is_revoked": false,
  "created_at": "2026-03-31T12:00:00.000Z",
  "key": "sk-soul-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9f8g9"
}
```

---

#### PUT /api/v1/keys/:id

Update an existing API key's metadata.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | API key ID (integer). |

##### Updatable Fields

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Human-readable label. |
| `daily_budget` | number | Daily spending limit in USD. |
| `rpm_limit` | integer | Requests per minute limit. |
| `tpm_limit` | integer | Tokens per minute limit. |

##### Example

```bash
curl -X PUT http://localhost:8042/api/v1/keys/7 \
  -H "Content-Type: application/json" \
  -d '{"daily_budget": 10.00, "rpm_limit": 200}'
```

##### Response

```json
{
  "id": 7,
  "label": "my-dev-key",
  "key_hint": "sk-soul-a1b2...f8g9",
  "daily_budget": "10.00",
  "rpm_limit": 200,
  "tpm_limit": 100000,
  "expires_at": null,
  "is_revoked": false,
  "created_at": "2026-03-31T12:00:00.000Z"
}
```

Returns `404` if the key is not found.

---

#### DELETE /api/v1/keys/:id

Revoke an API key. The key is soft-deleted by setting `is_revoked = true`. Revoked keys immediately stop working for proxy authentication.

##### Response

```json
{ "revoked": true }
```

Returns `404` if the key is not found.

---

#### POST /api/v1/keys/:id/reset-budget

Reset the budget counters for a specific API key by updating its `budget_reset_at` timestamp to now. This effectively clears all accumulated spending for the current budget period.

##### Response

```json
{
  "id": 7,
  "label": "my-dev-key",
  "key_hint": "sk-soul-a1b2...f8g9",
  "daily_budget": "10.00",
  "budget_reset_at": "2026-03-31T15:30:00.000Z"
}
```

Returns `404` if the key is not found.

---

#### Key Lifecycle

API keys progress through the following states:

| State | Condition | Can Authenticate? |
|-------|-----------|-------------------|
| **Active** | `is_revoked = false` and not expired | Yes |
| **Expired** | `expires_at` is in the past | No |
| **Revoked** | `is_revoked = true` | No |

Keys are stored as SHA-256 hashes in the database. The encrypted key is also stored for internal use. The `last_used_at` timestamp is updated on every successful authentication.

---

### Model Management

#### GET /api/v1/models

List all model configurations for the dashboard, including disabled models. Models with zero pricing are automatically enriched with OpenRouter pricing data. Tier rows include computed `billing_types` from their member models.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | string | Set to `"true"` to return only enabled models. |

##### Response

```json
[
  {
    "id": 1,
    "name": "copilot/gpt-4o",
    "display_name": "GPT-4o",
    "provider_key": "copilot",
    "provider_model": "gpt-4o",
    "mode": "fast",
    "input_price": "2.500",
    "output_price": "10.000",
    "pricing_type": "token",
    "context_window": 128000,
    "is_enabled": true,
    "is_free": true,
    "billing_type": "subscription",
    "sort_order": 10,
    "tags": ["fast", "code", "chat"],
    "created_at": "2026-03-15T10:00:00.000Z"
  }
]
```

> **Note:** This is the dashboard/management endpoint. For the agent-facing OpenAI-compatible model list, use `GET /v1/models`.

---

#### POST /api/v1/models

Create a new model configuration. If a model with the same name already exists (unique constraint violation), the existing model is returned with a 200 status instead of an error (idempotent behavior).

##### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique model name (e.g. `"openai/gpt-4o"`). |
| `provider_key` | string | Yes | Provider name matching a `provider_configs` entry. |
| `provider_model` | string | Yes | Upstream model identifier sent to the provider. |
| `display_name` | string | No | Human-readable display name. |
| `mode` | string | No | Model mode: `"fast"` or `"deep"`. |
| `input_price` | number | No | Input cost per million tokens (USD). |
| `output_price` | number | No | Output cost per million tokens (USD). |
| `is_free` | boolean | No | Whether the model is free (no budget impact). |
| `sort_order` | integer | No | Sort order in listings. Default: 100. |
| `tags` | array | No | Array of tag strings for tag-based model selection. |

##### Example

```bash
curl -X POST http://localhost:8042/api/v1/models \
  -H "Content-Type: application/json" \
  -d '{
    "name": "openai/gpt-4o",
    "provider_key": "openai",
    "provider_model": "gpt-4o",
    "display_name": "GPT-4o",
    "mode": "fast",
    "input_price": 2.5,
    "output_price": 10,
    "sort_order": 15
  }'
```

##### Response (201 Created)

```json
{
  "id": 42,
  "name": "openai/gpt-4o",
  "display_name": "GPT-4o",
  "provider_key": "openai",
  "provider_model": "gpt-4o",
  "mode": "fast",
  "input_price": "2.500",
  "output_price": "10.000",
  "is_enabled": true,
  "sort_order": 15,
  "created_at": "2026-03-31T12:00:00.000Z"
}
```

---

#### PUT /api/v1/models/:id

Update an existing model configuration. Send only the fields you want to change.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | Model configuration ID (integer). |

##### Request Body

Any subset of the fields from the create endpoint.

##### Response

Returns the updated model object, or `404` if not found.

---

#### DELETE /api/v1/models/:id

Delete a model configuration permanently.

##### Response

```json
{ "ok": true }
```

Returns `404` if the model is not found.

---

#### PUT /api/v1/models/:id/toggle

Toggle a model between enabled and disabled. Disabled models are excluded from routing and the `/v1/models` listing.

##### Response

Returns the updated model object with the new `is_enabled` value.

---

#### GET /api/v1/models/tags

Returns the list of predefined tags available for model configuration. Tags are defined in `model-naming.mjs` as `PREDEFINED_TAGS` and are automatically applied to models based on name patterns during provider sync.

##### Response

```json
["fast", "deep", "code", "chat", "vision", "reasoning", "search", "free"]
```

---

#### GET /api/v1/models/providers

Returns the list of configured providers from the database, including their name (key), source, ID, and protocol. Used by the dashboard for provider selection dropdowns.

##### Response

```json
[
  { "key": "copilot", "source": "database", "id": 1, "protocol": "openai" },
  { "key": "openai", "source": "database", "id": 2, "protocol": "openai" },
  { "key": "anthropic", "source": "database", "id": 3, "protocol": "anthropic" }
]
```

---

#### GET /api/v1/models/providers/:key/models

Discover available models from a specific provider by its name key. Delegates to the provider discovery endpoint. Returns a list of model IDs with pricing information.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `key` | Provider name (e.g. `"copilot"`, `"openai"`). |

##### Response

```json
[
  { "id": "gpt-4o", "input_price": 2.5, "output_price": 10, "owned_by": "copilot" },
  { "id": "gpt-4o-mini", "input_price": 0.15, "output_price": 0.6, "owned_by": "copilot" }
]
```

Returns `404` if the provider name is not found.

---

### Provider Management

#### GET /api/v1/providers

List all configured provider entries from the database.

##### Response

```json
[
  {
    "id": 1,
    "name": "copilot",
    "display_name": "GitHub Copilot",
    "protocol": "openai",
    "base_url": "https://api.githubcopilot.com",
    "auth_type": "managed",
    "billing_type": "subscription",
    "is_enabled": true,
    "created_at": "2026-03-01T10:00:00.000Z"
  },
  {
    "id": 2,
    "name": "openai",
    "display_name": "OpenAI (Direct)",
    "protocol": "openai",
    "base_url": "https://api.openai.com/v1/chat/completions",
    "auth_type": null,
    "billing_type": null,
    "is_enabled": true,
    "created_at": "2026-03-01T10:00:00.000Z"
  }
]
```

---

#### POST /api/v1/providers

Create a new provider configuration. For API key providers, the `api_key` field is required. For managed OAuth providers (`auth_type: "managed"`), no API key is needed -- authentication is handled via the OAuth flow.

##### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique provider name (e.g. `"openai"`, `"copilot"`). |
| `base_url` | string | Yes | Upstream API base URL. |
| `api_key` | string | Conditional | Required for non-managed-auth providers. |
| `display_name` | string | No | Human-readable name. |
| `protocol` | string | No | API protocol: `"openai"`, `"anthropic"`, or `"google"`. |
| `auth_type` | string | No | Set to `"managed"` for OAuth providers, `"internal"` for built-in. |
| `billing_type` | string | No | `"subscription"` or `"api_key"`. |

##### Example

```bash
curl -X POST http://localhost:8042/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "groq",
    "display_name": "Groq",
    "base_url": "https://api.groq.com/openai/v1/chat/completions",
    "protocol": "openai",
    "api_key": "gsk_your_groq_key_here"
  }'
```

##### Response (201 Created)

Returns the created provider object. Returns `409` if the name already exists.

---

#### PUT /api/v1/providers/:id

Update an existing provider configuration. Send only the fields to change.

##### Response

Returns the updated provider object, or `404` if not found.

---

#### DELETE /api/v1/providers/:id

Delete a provider configuration.

##### Response

```json
{ "ok": true }
```

Returns `404` if the provider is not found.

---

#### GET /api/v1/providers/templates

Returns pre-configured templates for all supported providers. Each template contains the default `display_name`, `protocol`, `base_url`, and optionally `auth_type` and `billing_type`. Used by the dashboard to pre-fill the provider creation form.

##### Available Templates

| Key | Display Name | Protocol | Auth Type |
|-----|-------------|----------|-----------|
| `copilot` | GitHub Copilot | openai | managed |
| `axiologic_kiro` | Kiro (AWS Claude) | openai | managed |
| `codex` | OpenAI Codex (OAuth) | openai | managed |
| `gemini` | Google Gemini (OAuth) | openai | managed |
| `anthropic` | Anthropic Claude (OAuth) | anthropic | managed |
| `openai` | OpenAI (Direct) | openai | api_key |
| `groq` | Groq | openai | api_key |
| `deepseek` | DeepSeek | openai | api_key |
| `nvidia` | NVIDIA | openai | api_key |
| `fireworks` | Fireworks AI | openai | api_key |
| `together` | Together AI | openai | api_key |
| `deepinfra` | DeepInfra | openai | api_key |
| `perplexity` | Perplexity | openai | api_key |
| `mistral` | Mistral | openai | api_key |
| `xai` | xAI (Grok) | openai | api_key |
| `cohere` | Cohere | openai | api_key |
| `google` | Google AI | google | api_key |
| `search` | Web Search (Built-in) | openai | internal |
| `tavily` | Tavily Search | openai | api_key |
| `brave` | Brave Search | openai | api_key |
| `exa` | Exa Search | openai | api_key |
| `serper` | Serper Search | openai | api_key |
| `jina` | Jina Search | openai | api_key |
| `duckduckgo` | DuckDuckGo Search | openai | api_key |
| `searxng` | SearXNG Search | openai | api_key |
| `gemini_search` | Gemini Search | openai | api_key |
| `custom` | Custom | openai | api_key |

> **Search providers:** The search provider templates (tavily, brave, exa, serper, jina, duckduckgo, searxng, gemini_search) appear in the Add Provider dropdown alongside LLM providers. When synced, their models are automatically added to the `axl/search` tier.

---

#### POST /api/v1/providers/:id/test

Test connectivity to a provider. For API key providers, this hits the upstream `/models` endpoint with a 10-second timeout. For managed OAuth providers, this checks the credential status.

##### Response (success)

```json
{ "ok": true, "model_count": 42 }
```

##### Response (OAuth, success)

```json
{ "ok": true, "message": "Authenticated (2 accounts)" }
```

##### Response (failure)

```json
{ "ok": false, "error": "401: Invalid API key" }
```

---

#### POST /api/v1/providers/:id/sync

Discover models from the provider and sync them into the database. New models are upserted with the `<provider>/<model>` naming convention. Models no longer returned by the provider are automatically disabled. If the provider is a search provider, the `axl/search` tier is updated with the synced models.

##### Response

```json
{
  "ok": true,
  "synced": ["groq/llama-3-70b", "groq/llama-3-8b", "groq/mixtral-8x7b"],
  "disabled": 1
}
```

---

#### GET /api/v1/providers/:id/models

Discover available models from a provider without syncing them into the database. For API key providers, queries the upstream `/models` endpoint. For managed OAuth providers, uses OAuth credentials for the request, falling back to the adapter's `knownModels` list or existing DB models if the endpoint is not accessible.

##### Response

```json
[
  { "id": "gpt-4o", "input_price": 2.5, "output_price": 10, "owned_by": "openai" },
  { "id": "gpt-4o-mini", "input_price": 0.15, "output_price": 0.6, "owned_by": "openai" }
]
```

---

#### OAuth Authentication

Managed-auth providers (Copilot, Kiro, Codex, Gemini, Anthropic) use OAuth device flow or PKCE for authentication. These endpoints manage the OAuth lifecycle.

##### POST /api/v1/providers/:id/auth/start

Start a new OAuth authentication flow. Returns a device code and verification URL (for device flow) or an authorization URL (for PKCE flow). The user must complete the flow in a browser.

Returns `400` if the provider does not use managed auth.

**Response (Device Flow)**

```json
{
  "flow": "device",
  "verification_uri": "https://github.com/login/device",
  "user_code": "ABCD-1234",
  "expires_in": 900,
  "interval": 5
}
```

**Response (PKCE Flow)**

```json
{
  "flow": "pkce",
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "random-state-value"
}
```

---

##### GET /api/v1/providers/:id/auth/poll

Poll the status of an in-progress device flow. Returns `"pending"` while waiting for user authorization, `"complete"` when tokens have been received.

**Response (pending)**

```json
{ "status": "pending" }
```

**Response (complete)**

```json
{ "status": "complete", "account": "user@example.com" }
```

---

##### POST /api/v1/providers/:id/auth/callback

Manual callback handler for PKCE flows. When the local redirect URI is not reachable, the user can paste the authorization code and state from the callback URL.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Authorization code from the callback URL. |
| `state` | string | Yes | State parameter from the callback URL. |

**Response**

```json
{ "status": "complete", "account": "user@example.com" }
```

---

##### GET /api/v1/providers/:id/auth/status

Get the current authentication status for a managed-auth provider. Returns account details and whether credentials are active.

**Response (active)**

```json
{
  "auth_type": "managed",
  "status": "active",
  "accounts": [
    { "email": "user@example.com", "added_at": "2026-03-15T10:00:00Z" }
  ]
}
```

**Response (no accounts)**

```json
{
  "auth_type": "managed",
  "status": "no_accounts",
  "accounts": []
}
```

**Response (API key provider)**

```json
{ "auth_type": "api_key" }
```

---

##### DELETE /api/v1/providers/:id/auth/accounts/:idx

Remove an OAuth account by its index from a managed-auth provider.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Provider ID. |
| `idx` | Zero-based account index. |

**Response**

```json
{ "ok": true }
```

---

##### POST /api/v1/providers/:id/auth/reset-quota

Reset the quota tracking counters for a managed-auth provider.

**Response**

```json
{ "ok": true }
```

---

### Tier Management

#### GET /api/v1/tiers

List all tiers for the dashboard, including disabled tiers with full database row details.

##### Response

```json
[
  {
    "id": 1,
    "name": "axl/fast",
    "display_name": "Fast Tier",
    "type": "tier",
    "model_refs": ["copilot/gpt-4o", "groq/llama-3-70b"],
    "fallback_model": null,
    "is_enabled": true,
    "sort_order": 50,
    "created_at": "2026-03-01T10:00:00.000Z"
  },
  {
    "id": 2,
    "name": "axl/deep",
    "display_name": "Deep Tier",
    "type": "tier",
    "model_refs": ["copilot/gpt-4.1", "anthropic/claude-sonnet-4"],
    "fallback_model": "axl/fast",
    "is_enabled": true,
    "sort_order": 60,
    "created_at": "2026-03-01T10:00:00.000Z"
  }
]
```

> **Note:** For the agent-facing tier list, use `GET /v1/tiers`, which returns only enabled tiers in a simplified format.

---

#### POST /api/v1/tiers

Create a new tier. The tier name must be unique.

##### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique tier name (e.g. `"axl/fast"`, `"axl/deep"`). |
| `display_name` | string | No | Human-readable display name. |
| `model_refs` | array | No | Ordered array of model names. Also accepts `models` as an alias. |
| `fallback_model` | string | No | Fallback tier or model name. Also accepts `fallback_tier`. |
| `sort_order` | integer | No | Sort order in listings. |

##### Example

```bash
curl -X POST http://localhost:8042/api/v1/tiers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "axl/code",
    "display_name": "Code Generation",
    "model_refs": [
      "copilot/gpt-4.1",
      "anthropic/claude-sonnet-4",
      "deepseek/deepseek-coder"
    ],
    "fallback_model": "axl/fast",
    "sort_order": 70
  }'
```

##### Response (201 Created)

```json
{
  "id": 3,
  "name": "axl/code",
  "display_name": "Code Generation",
  "type": "tier",
  "model_refs": ["copilot/gpt-4.1", "anthropic/claude-sonnet-4", "deepseek/deepseek-coder"],
  "fallback_model": "axl/fast",
  "is_enabled": true,
  "sort_order": 70,
  "created_at": "2026-03-31T12:00:00.000Z"
}
```

Returns `409` if a tier with the same name already exists.

---

#### PUT /api/v1/tiers/:id

Update a tier's configuration. Accepts both new and legacy field names (`model_refs`/`models` and `fallback_model`/`fallback_tier`).

When `model_refs` is updated, all referenced models are automatically enabled (`is_enabled = true`).

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | Tier ID (integer). |

##### Request Body

Any subset of: `display_name`, `model_refs` (or `models`), `fallback_model` (or `fallback_tier`), `sort_order`.

##### Example

```bash
curl -X PUT http://localhost:8042/api/v1/tiers/3 \
  -H "Content-Type: application/json" \
  -d '{
    "model_refs": [
      "copilot/gpt-4.1",
      "anthropic/claude-sonnet-4",
      "deepseek/deepseek-coder",
      "fireworks/codestral-latest"
    ]
  }'
```

##### Response

Returns the updated tier object, or `404` if not found.

---

#### DELETE /api/v1/tiers/:id

Delete a tier permanently. The member models are not deleted.

##### Response

```json
{ "ok": true }
```

Returns `404` if the tier is not found.

---

#### PUT /api/v1/tiers/:id/toggle

Toggle a tier between enabled and disabled. Disabled tiers cannot be used for routing.

##### Response

Returns the updated tier object with the new `is_enabled` value, or `404` if not found.

---

#### Tier Resolution

When a request specifies a tier name as the `model`, the routing system:

1. Looks up the tier by name.
2. Iterates through `model_refs` in order, skipping any model currently in cooldown.
3. Returns the first available model with its provider configuration and pricing.
4. If all models in the tier are in cooldown and a `fallback_model` is set, resolution continues with the fallback (which may be another tier or a direct model).
5. If no model can be resolved, a `404 model_not_found` error is returned.

---

#### Tier Model Picker (Dashboard UI)

The tier editing modal uses a searchable multi-select popup for adding models:

- An "Add Models..." button opens a picker modal
- A search bar filters models by name, provider, or tags
- Billing filter chips (`All` / `Subscription` / `API Key` / `Free`) narrow the list by billing type
- A scrollable checkbox list shows each model's display name, provider badge, billing badge, and tags
- Multiple models can be selected and added at once via an "Add N Models" button
- Model ordering in the tier uses drag-and-drop: each model row has a grip handle (≡) that can be dragged to reorder. The dragged item becomes translucent and a blue border indicates the drop position. Priority numbers auto-update after reorder.

---

### Middleware Management

#### GET /api/v1/middlewares

List all registered middlewares.

##### Response

```json
[
  {
    "id": 1,
    "name": "rate-limiter",
    "display_name": "Rate Limiter",
    "description": "Per-key RPM and TPM rate limiting",
    "phase": "pre",
    "default_settings": { "window_seconds": 60 },
    "is_enabled": true,
    "created_at": "2026-03-01T10:00:00.000Z"
  },
  {
    "id": 2,
    "name": "budget-enforcer",
    "display_name": "Budget Enforcer",
    "description": "Daily and monthly budget enforcement per API key",
    "phase": "both",
    "default_settings": {},
    "is_enabled": true,
    "created_at": "2026-03-01T10:00:00.000Z"
  }
]
```

---

#### GET /api/v1/middlewares/:id

Get detailed information about a specific middleware.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | Middleware ID (integer). |

##### Response

Returns the full middleware object, or `404` if not found.

---

#### PUT /api/v1/middlewares/:id

Update a middleware's default settings or enabled state.

##### Request Body

Any subset of: `default_settings`, `is_enabled`, `display_name`, `description`.

##### Response

Returns the updated middleware object, or `404` if not found.

---

#### POST /api/v1/middlewares/rescan

Scan the filesystem for middleware `.mjs` files and register any newly discovered middlewares in the database. Existing middlewares are not overwritten.

##### Response

```json
{
  "discovered": ["rate-limiter", "budget-enforcer", "cache", "blacklist"],
  "count": 4
}
```

---

#### Model-Middleware Assignment

Assign middlewares to individual models with custom settings and execution order.

##### GET /api/v1/models/:id/middlewares

List all middlewares assigned to a specific model, ordered by `sort_order`.

**Response**

```json
[
  {
    "id": 10,
    "middleware_id": 1,
    "model_config_id": 5,
    "is_enabled": true,
    "sort_order": 10,
    "settings": { "window_seconds": 30 },
    "middleware_name": "rate-limiter"
  }
]
```

---

##### POST /api/v1/models/:id/middlewares

Assign a middleware to a model.

**Request Body**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `middleware_id` | integer | Yes | -- | ID of the middleware to assign. |
| `is_enabled` | boolean | No | `true` | Whether the assignment is active. |
| `sort_order` | integer | No | `100` | Execution order (lower runs first). |
| `settings` | object | No | `{}` | Custom settings that override the middleware's defaults. |

**Response (201 Created)**

Returns the created assignment. Returns `409` if the middleware is already assigned to this model.

---

##### PUT /api/v1/models/:id/middlewares/:mwId

Update a model-middleware assignment's settings, enabled state, or sort order.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Model configuration ID. |
| `mwId` | Model-middleware assignment ID. |

**Response**

Returns the updated assignment, or `404` if not found.

---

##### DELETE /api/v1/models/:id/middlewares/:mwId

Remove a middleware assignment from a model.

**Response**

```json
{ "ok": true }
```

---

##### PUT /api/v1/models/:id/middlewares/reorder

Reorder the middleware pipeline for a model by providing the assignment IDs in the desired execution order.

**Request Body**

```json
{ "ordered_ids": [10, 12, 11] }
```

**Response**

Returns the updated list of model-middleware assignments in the new order.

---

#### Tier-Middleware Assignment

Assign middlewares to tiers. Tier-level middlewares apply to all models within the tier.

##### GET /api/v1/tiers/:id/middlewares

List all middlewares assigned to a specific tier.

---

##### POST /api/v1/tiers/:id/middlewares

Assign a middleware to a tier. Same request body as model-middleware assignment.

**Request Body**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `middleware_id` | integer | Yes | -- | ID of the middleware to assign. |
| `is_enabled` | boolean | No | `true` | Whether the assignment is active. |
| `sort_order` | integer | No | `100` | Execution order (lower runs first). |
| `settings` | object | No | `{}` | Custom settings overriding defaults. |

**Response (201 Created)**

Returns the assignment. `409` if already assigned.

---

##### PUT /api/v1/tiers/:id/middlewares/:mwId

Update a tier-middleware assignment.

**Response**

Returns the updated assignment, or `404` if not found.

---

##### DELETE /api/v1/tiers/:id/middlewares/:mwId

Remove a middleware assignment from a tier.

**Response**

```json
{ "ok": true }
```

---

##### PUT /api/v1/tiers/:id/middlewares/reorder

Reorder the middleware pipeline for a tier.

**Request Body**

```json
{ "ordered_ids": [5, 7, 6] }
```

**Response**

Returns the reordered list of tier-middleware assignments.

---

### Logs & Sessions

#### GET /api/v1/logs

Query call logs with filtering, sorting, and pagination. Returns a paginated list of log entries matching the specified criteria.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `soul_id` | string | Filter by soul ID (from `X-Soul-Id` header). |
| `model` | string | Filter by resolved model name. |
| `from` | string | Start timestamp (ISO 8601). Filters `started_at >= from`. |
| `to` | string | End timestamp (ISO 8601). Filters `started_at <= to`. |
| `status` | string | Filter by HTTP status code (e.g. `"200"`, `"429"`). |
| `error_type` | string | Filter by error type (e.g. `"rate_limit_error"`). |
| `keyword` | string | Full-text search in request/response content. |
| `agent_name` | string | Filter by agent name. |
| `api_key_id` | integer | Filter by API key ID. |
| `limit` | integer | Maximum results to return. Default: 50. |
| `offset` | integer | Offset for pagination. Default: 0. |
| `sort` | string | Sort field (e.g. `"started_at"`, `"latency_ms"`). |
| `order` | string | Sort direction: `"asc"` or `"desc"`. |

##### Example

```bash
curl "http://localhost:8042/api/v1/logs?model=copilot/gpt-4o&status=200&limit=10&sort=started_at&order=desc"
```

##### Response

```json
{
  "rows": [
    {
      "id": 1234,
      "soul_id": "my-app",
      "requested_model": "axl/fast",
      "resolved_model": "copilot/gpt-4o",
      "mode": "fast",
      "is_streaming": true,
      "status_code": 200,
      "stop_reason": "stop",
      "latency_ms": 847,
      "ttfb_ms": 312,
      "prompt_tokens": 156,
      "completion_tokens": 89,
      "total_tokens": 245,
      "input_cost": "0.000390",
      "output_cost": "0.000890",
      "total_cost": "0.001280",
      "is_free": true,
      "agent_name": "coral-agent",
      "session_id": "sess-abc123",
      "retry_count": 0,
      "is_truncated": false,
      "is_slow": false,
      "cache_hit": false,
      "started_at": "2026-03-31T14:23:00.000Z",
      "completed_at": "2026-03-31T14:23:00.847Z"
    }
  ],
  "total": 1542
}
```

---

#### GET /api/v1/logs/:id

Get a single log entry by ID with full details including request messages and response content.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | Log entry ID (integer). |

##### Response

Returns the full log entry object, or `404` if not found.

---

#### GET /api/v1/logs/stream

Real-time log stream using Server-Sent Events (SSE). The connection stays open and receives log entries as they are generated. A keepalive comment is sent every 15 seconds to prevent proxy timeouts.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `soul_id` | string | Filter events by soul ID. |
| `model` | string | Filter events by resolved model. |

##### Response Headers

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

##### Event Format

```
data: {"type":"connected","filters":{"soul_id":null,"model":null}}

: keepalive

data: {"type":"log","data":{"id":1234,"soul_id":"my-app","resolved_model":"copilot/gpt-4o","status_code":200,"latency_ms":847,"total_cost":"0.001280","started_at":"2026-03-31T14:23:00.000Z"}}
```

##### Example

```bash
curl -N "http://localhost:8042/api/v1/logs/stream?model=copilot/gpt-4o"
```

---

#### WS /ws/v1/logs

Real-time log stream over WebSocket. Receives the same log entry payloads as the SSE endpoint. Supports dynamic filter updates via messages. The server sends a ping frame every 15 seconds as a heartbeat.

##### Connection

```
ws://localhost:8042/ws/v1/logs?soul_id=my-app&model=copilot/gpt-4o
```

##### Initial Message (from server)

```json
{"type": "connected", "filters": {"soul_id": "my-app", "model": "copilot/gpt-4o"}}
```

##### Log Event (from server)

```json
{
  "type": "log",
  "data": {
    "id": 1234,
    "soul_id": "my-app",
    "requested_model": "axl/fast",
    "resolved_model": "copilot/gpt-4o",
    "status_code": 200,
    "latency_ms": 847,
    "ttfb_ms": 312,
    "prompt_tokens": 156,
    "completion_tokens": 89,
    "total_tokens": 245,
    "total_cost": "0.001280",
    "retry_count": 0,
    "is_truncated": false,
    "is_slow": false,
    "cache_hit": false,
    "started_at": "2026-03-31T14:23:00.000Z",
    "completed_at": "2026-03-31T14:23:00.847Z"
  }
}
```

##### Update Filters (client to server)

Send a JSON message to update filters dynamically without reconnecting:

```json
{"type": "filter", "filters": {"model": "anthropic/claude-sonnet-4"}}
```

##### Filter Update Confirmation (from server)

```json
{"type": "filter_updated", "filters": {"soul_id": "my-app", "model": "anthropic/claude-sonnet-4"}}
```

> **Note:** Broadcast payloads are sanitized to exclude full prompt/response content. They include metadata fields only: IDs, model info, status, latency, tokens, cost, error info, and timestamps.

---

#### WS /ws/v1/soul/:id

WebSocket stream scoped to a specific soul ID. Receives only log entries for the specified soul. Useful for per-application monitoring dashboards.

##### Connection

```
ws://localhost:8042/ws/v1/soul/my-app-id
```

##### Initial Message

```json
{"type": "connected", "soul_id": "my-app-id"}
```

##### Log Events

Same format as the general log stream, but only events matching this soul ID.

```json
{"type": "log", "data": { ... }}
```

---

#### GET /api/v1/agents

List all unique agent names that have made requests through the gateway, with aggregate statistics.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `api_key_id` | integer | Filter by API key ID. |

---

#### GET /api/v1/sessions

List sessions with optional filtering and pagination.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `api_key_id` | integer | Filter by API key ID. |
| `agent_name` | string | Filter by agent name. |
| `limit` | integer | Maximum results to return. |
| `offset` | integer | Offset for pagination. |

---

#### GET /api/v1/sessions/:id/logs

Get all log entries for a specific session.

##### Path Parameters

| Parameter | Description |
|-----------|-------------|
| `id` | Session identifier string. |

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Maximum results. |
| `offset` | integer | Pagination offset. |
| `sort` | string | Sort field. |
| `order` | string | `"asc"` or `"desc"`. |

---

#### GET /api/v1/tree

Get a hierarchical view of agents and their sessions. Useful for building tree-view navigation in the dashboard.

##### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | string | Start timestamp (ISO 8601). |
| `to` | string | End timestamp (ISO 8601). |

---

### Metrics & Export

#### Common Query Parameters

Most metrics endpoints accept the following time-range filters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | string | Start timestamp (ISO 8601). |
| `to` | string | End timestamp (ISO 8601). |
| `granularity` | string | Time bucket size: `"hour"`, `"day"` (default), `"week"`, `"month"`. |

---

#### GET /api/v1/metrics/costs

Get cost breakdown by model and a cost trend over time. Returns two datasets: aggregate costs grouped by model, and a time series of total costs.

##### Response

```json
{
  "by_model": [
    {
      "resolved_model": "copilot/gpt-4o",
      "total_cost": "2.456",
      "request_count": 1250,
      "total_tokens": 450000
    },
    {
      "resolved_model": "anthropic/claude-sonnet-4",
      "total_cost": "8.123",
      "request_count": 340,
      "total_tokens": 890000
    }
  ],
  "trend": [
    { "bucket": "2026-03-28", "total_cost": "3.21" },
    { "bucket": "2026-03-29", "total_cost": "2.87" },
    { "bucket": "2026-03-30", "total_cost": "4.12" },
    { "bucket": "2026-03-31", "total_cost": "1.56" }
  ]
}
```

---

#### GET /api/v1/metrics/usage

Get daily usage statistics including cost by model over time, month-to-date total, list of distinct models used, and per-model request statistics.

##### Response

```json
{
  "daily_by_model": [
    {
      "day": "2026-03-31",
      "resolved_model": "copilot/gpt-4o",
      "total_cost": "0.89",
      "request_count": 156
    }
  ],
  "total": {
    "total_cost": "45.67",
    "request_count": 4520,
    "total_tokens": 12500000
  },
  "models": [
    "copilot/gpt-4o",
    "anthropic/claude-sonnet-4",
    "groq/llama-3-70b"
  ],
  "model_requests": [
    {
      "resolved_model": "copilot/gpt-4o",
      "request_count": 2100,
      "avg_latency_ms": 847
    }
  ]
}
```

---

#### GET /api/v1/metrics/errors

Get error analytics: error rates over time, summary statistics, breakdown by error type, and breakdown by model.

##### Response

```json
{
  "rates": [
    {
      "bucket": "2026-03-31",
      "total_requests": 450,
      "error_count": 12,
      "error_rate": 0.0267
    }
  ],
  "summary": {
    "total_errors": 45,
    "total_requests": 4520,
    "error_rate": 0.0099
  },
  "breakdown": [
    { "error_type": "rate_limit_error", "count": 20 },
    { "error_type": "upstream_error", "count": 15 },
    { "error_type": "budget_exceeded", "count": 8 },
    { "error_type": "authentication_error", "count": 2 }
  ],
  "models": [
    {
      "resolved_model": "anthropic/claude-sonnet-4",
      "error_count": 10,
      "total_requests": 340,
      "error_rate": 0.0294
    }
  ]
}
```

---

#### GET /api/v1/metrics/activity

Get activity metrics grouped by API key, with cost and request counts. Also returns a trend showing activity over time by key.

##### Response

```json
{
  "by_key": [
    {
      "api_key_id": 1,
      "label": "production-agent",
      "total_cost": "32.45",
      "request_count": 3200
    },
    {
      "api_key_id": 2,
      "label": "dev-testing",
      "total_cost": "5.12",
      "request_count": 890
    }
  ],
  "trend": [
    {
      "bucket": "2026-03-31",
      "api_key_id": 1,
      "total_cost": "2.34",
      "request_count": 312
    }
  ]
}
```

---

#### GET /api/v1/metrics/tokens

Get token usage trend over time.

##### Response

```json
{
  "trend": [
    {
      "bucket": "2026-03-28",
      "prompt_tokens": 1250000,
      "completion_tokens": 450000,
      "total_tokens": 1700000
    },
    {
      "bucket": "2026-03-29",
      "prompt_tokens": 1100000,
      "completion_tokens": 380000,
      "total_tokens": 1480000
    }
  ]
}
```

---

#### GET /metrics

System health metrics including process memory, event loop lag, database connection pool status, model queue statistics, loop detector state, and active stream subscriber counts. No authentication required.

##### Response

```json
{
  "process": {
    "rss": 85983232,
    "heapUsed": 42567680,
    "heapTotal": 67108864,
    "external": 1234567,
    "uptime": 86423.456,
    "eventLoopLagMs": 0.42
  },
  "db": {
    "total": 10,
    "idle": 7,
    "waiting": 0
  },
  "modelQueue": {
    "active": 3,
    "waiting": 0,
    "models": {
      "copilot/gpt-4o": { "active": 2, "waiting": 0 },
      "anthropic/claude-sonnet-4": { "active": 1, "waiting": 0 }
    }
  },
  "loopDetector": {
    "trackedKeys": 15,
    "activeBlocks": 0
  },
  "streams": {
    "ws": 2,
    "sse": 1
  }
}
```

> **Monitoring:** Use this endpoint for health checks and alerting. Key indicators: `eventLoopLagMs` above 100ms suggests CPU pressure, `db.waiting` above 0 indicates connection pool saturation, and `modelQueue.waiting` above 0 means requests are queued due to concurrency limits.

---

#### GET /api/v1/export

Export call logs as a downloadable CSV or JSON file. Includes log metadata (IDs, models, status, latency, tokens, costs, errors, timestamps) but not full request/response content.

##### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `format` | string | `"json"` | Export format: `"json"` or `"csv"`. |
| `from` | string | -- | Start timestamp (ISO 8601). |
| `to` | string | -- | End timestamp (ISO 8601). |

##### CSV Columns

`id`, `soul_id`, `requested_model`, `resolved_model`, `status_code`, `latency_ms`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `total_cost`, `error_type`, `is_truncated`, `is_slow`, `started_at`, `completed_at`

##### Example (CSV)

```bash
curl -o logs.csv "http://localhost:8042/api/v1/export?format=csv&from=2026-03-01&to=2026-03-31"
```

##### Example (JSON)

```bash
curl -o logs.json "http://localhost:8042/api/v1/export?format=json&from=2026-03-31"
```

##### Response Headers (CSV)

```
Content-Type: text/csv
Content-Disposition: attachment; filename="soul-gateway-logs.csv"
```

##### Response Headers (JSON)

```
Content-Type: application/json
Content-Disposition: attachment; filename="soul-gateway-logs.json"
```
