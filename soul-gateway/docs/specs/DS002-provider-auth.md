# DS002 — Provider Authentication

## Summary

This spec describes how Soul Gateway authenticates with upstream LLM providers. It covers the two auth strategies (static API keys and managed OAuth), the five supported OAuth flows, multi-account credential pooling with quota rotation, automatic token refresh, auto-provisioning on provider creation, format converters for non-OpenAI protocols, and custom search providers as an extension of the same provider model.

## Auth strategies

Each provider record carries an `auth_strategy` field that determines how the gateway authenticates with the upstream service:

- **`api_key`** — a static API key is stored encrypted at rest in an account row associated with the provider. The key is decrypted only at the moment of dispatch and never logged or exposed. When creating or updating a provider via the management API, an API key can be included in the request payload; the system automatically creates (or updates) an encrypted provider account for the key so the provider is ready to use immediately without a separate account-creation step. Provider update accepts API-key-only PATCH bodies so callers can rotate credentials without re-sending the unchanged column fields.
- **`oauth`** — credentials are obtained via one of five managed OAuth flows (see below). Access tokens, refresh tokens, and expiration times are persisted as encrypted credential files in the configured credentials directory. OAuth credentials are leased into provider execution only for the duration of a request.
- **`subscription`** — used for providers that are billed by subscription regardless of token usage (e.g., GitHub Copilot, AWS Kiro). Credentials are obtained via the OAuth flow; pricing is per-request rather than per-token.

## Managed OAuth flows

Five OAuth flows ship with the gateway, each implemented as a registered OAuth adapter:

- **GitHub Copilot** — device-code flow where the user authorizes via a browser. Access tokens are exchanged for a short-lived Copilot token that auto-refreshes. User email is extracted from the GitHub `/user` API.
- **AWS Kiro** — authorization-code flow with PKCE via a local callback URL. User email is decoded from the returned JWT `id_token`.
- **OpenAI Codex** — authorization-code flow with PKCE against ChatGPT's OAuth server. The access token is only accepted by the ChatGPT backend API (`chatgpt.com/backend-api/codex`). User email is decoded from the `id_token` JWT (`openid email` scopes).
- **Google Gemini** — device-code flow with polling. User email is fetched from Google's userinfo endpoint if absent from the token response.
- **Anthropic Claude.ai** — authorization-code flow with PKCE against `claude.ai`. Issues long-lived tokens (~1 year). User email is fetched from `/v1/oauth/userinfo` if absent from the token response.

The management API and dashboard can start OAuth flows, poll pending device-code flows, and complete PKCE callback flows for all five adapters. The dashboard's provider-create UI derives its OAuth adapter choices from the live provider template catalog rather than a hardcoded client-side list, so newly-added OAuth-capable templates appear automatically.

## Multi-account credential pooling

Each OAuth provider can have multiple authenticated accounts. The system rotates to the next account when the current one hits its quota (indicated by payment-required or quota-specific rate-limit errors).

- Exhausted accounts are marked with a reset time (typically next midnight UTC) and automatically restored when the reset time passes.
- The quota-reset sweep also clears the runtime account-pool exhaustion tracker so restored accounts are immediately eligible for reuse without a restart.
- When all accounts for a provider are exhausted, requests to that provider's models are rejected with retry guidance.
- Rotation happens transparently during the request retry loop (see DS009).

## Token refresh

A background process periodically checks token expiration and refreshes tokens before they expire, with provider-specific safety margins. Concurrent refresh requests for the same token are deduplicated via an in-memory Promise map so simultaneous requests don't stampede the upstream token endpoint. An inline refresh safety net runs in the credential lease path as well: if the background job fell behind or just didn't run since the gateway restarted, the next credential lease detects the stale token and refreshes it synchronously before handing the credential to the plugin. Refresh failures mark accounts for re-authentication.

## Auto-provisioning

Whenever a provider first obtains a usable credential — either by completing an OAuth flow or by being created with an API key in the management request payload — the system automatically runs model discovery against the provider and persists the discovered models in the registry.

- Providers created with a static API key run discovery synchronously during the create request so the provider is immediately usable without a second management call.
- Providers that finish an OAuth flow run discovery as soon as the flow completes.
- Providers whose upstream cannot expose a meaningful model list (e.g. Mistral's Codestral subdomain, which only serves `/chat/completions` and `/fim/completions`) simply register zero rows, and the operator adds models manually.
- Auto-provisioning is idempotent and also runs at startup to reconcile any providers that already had stored credentials.

## Format converters

Not all upstream providers speak OpenAI's chat completion format natively. Format converters translate between the gateway's OpenAI-compatible interface and provider-specific protocols. The shared upstream LLM transport layer (`achillesAgentLib`) covers the protocol families needed by the shipped providers: OpenAI-compatible Chat Completions, OpenAI-compatible Responses, OpenAI-compatible legacy Completions, Anthropic-compatible Messages, Google Gemini, GitHub Copilot's mixed Completions/Responses API, AWS Kiro's binary event-stream API, and Hugging Face's OpenAI-compatible chat API.

For providers that share a protocol family, configuration is primarily the provider base URL, credential material, model identifier, and any provider-specific headers or request parameters. Adding another provider in an already-supported family does not require a new core request pipeline — for OpenAI-compatible vendors, adding a preset to the preset catalog is enough.

All converters produce a uniform typed chunk stream: text deltas, tool-call deltas, completion signals, and errors. This abstraction lets new providers plug into the request pipeline without changing the pipeline itself.

## Provider template catalog

The provider template catalog exposed by the management API merges two sources:

1. **Loaded provider plugins** that represent distinct vendor offerings — the OAuth-backed plugins: GitHub Copilot, OpenAI Codex, Anthropic Claude.ai, AWS Kiro, and Google Gemini OAuth.
2. **A static preset catalog** of vendor-labeled configurations that share a protocol-family plugin — OpenAI-compatible vendors (OpenAI direct, OpenRouter, NVIDIA, Groq, Fireworks, Together, DeepSeek, DeepInfra, Perplexity, Mistral, Mistral Codestral, xAI, Cohere), a direct Anthropic API preset, and eight web-search engines (Tavily, Brave, Exa, Serper, Jina, DuckDuckGo, SearXNG, Gemini Search grounding).

Protocol-family dispatcher plugins (`openai-api`, `anthropic-api`, `search-builtin`) are marked as hidden in their manifest and do not surface in the template dropdown as standalone entries — a user always picks a vendor preset (which pre-fills display name, base URL, and auth strategy) rather than the raw dispatcher. The two derived OAuth plugins (`gemini-openai`, `claudeai-api`) explicitly opt out of their parent's hidden flag since they are distinct vendor offerings without a preset.

## Connectivity tests

The Test button on each provider invokes the plugin's `testConnection` lifecycle method:

- **OpenAI-compatible providers** first try `GET /models`. If that returns 404 (as on Mistral's Codestral subdomain, which only exposes `/chat/completions` and `/fim/completions`), the plugin falls back to an empty `POST /chat/completions` probe and interprets the status code: 2xx or 4xx other than 401/403/404 means the endpoint is reachable and the credential is recognised (reported as "Connected (model listing not exposed at this base URL)"), 401/403 surfaces the auth failure, and a double-404 indicates the base URL itself is wrong.
- **Search providers** resolve which engine the row represents by walking `ctx.resolvedModel.provider_model_id → settings.engine → provider_key → base_url hostname`, so the Test button reports the actual engine name ("Exa Search credentials present", "Brave Search credentials present", "DuckDuckGo does not require authentication") rather than a generic default.
- **OAuth-backed providers** validate the credential lease (presence + non-expired) rather than making a live call that is known to fail due to scope restrictions (e.g. the Codex OAuth token isn't accepted by `api.openai.com/v1/models` even when it is perfectly valid for the ChatGPT backend).

## Custom search providers

The system supports registering custom search provider implementations that execute web searches and return results formatted as LLM-compatible responses. A custom search provider is a unit of code that lives inside the gateway. When a model backed by a search provider receives a request, the system invokes the custom code instead of calling an external LLM API.

The system ships with built-in search providers for Tavily, Brave Search, Exa, Serper, Google Gemini (grounding), DuckDuckGo, SearXNG, and Jina. Each returns results formatted as a chat-style response. A `deep-research` meta-engine queries multiple search providers in parallel, deduplicates by URL, ranks by score, and produces a synthesized response.

Custom search providers participate in the same model registry, tier system, middleware pipeline, rate limiting, cost tracking, and observability as any other model — from the client's perspective, a search-backed model looks identical to an LLM-backed model. An example of a truly custom search provider would be one that launches a headless browser, navigates to google.com, activates Google's AI Mode feature, extracts the AI-generated response, and formats the result as a standard chat completion response.

Custom search providers receive a curated gateway service surface for sub-model invocation, credential leasing, token estimation, and optional browser automation. They do not receive direct access to the gateway's internal service container.

## Credential storage

- **Static API keys** are stored as encrypted rows in a provider-accounts table using AES-256-GCM. The cipher components (ciphertext, 12-byte IV, 16-byte auth tag) are persisted as raw bytes so they round-trip cleanly through the database's binary columns. Keys are decrypted only at dispatch time, held in a lease object, and wiped from memory on release.
- **OAuth credentials** are stored as encrypted credential files in a per-provider directory on disk, keyed by account index. The encryption module uses the same AES-256-GCM primitive, with explicit hex encoding at the JSON file boundary. Credentials are leased into provider execution only for the duration of a request.

## Related specs

- **DS003** — the plugin/hook/executor model that provider plugins plug into; provider pipeline composer.
- **DS004** — model routing, which resolves a requested model name into a concrete provider and model.
- **DS007** — account rotation is driven by quota-specific rate-limit and payment-required errors classified here.
- **DS009** — error classification and the retry loop that triggers account rotation.
- **DS012** — the management API endpoints for provider CRUD, OAuth flow orchestration, account management, and connectivity tests.
