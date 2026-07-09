# DS002 — Provider Authentication

## Summary

This spec describes how Soul Gateway authenticates with upstream providers. It covers the two auth strategies (static API keys and managed OAuth), the five supported OAuth flows, multi-account credential pooling with quota rotation, automatic token refresh, auto-provisioning on provider creation, and format converters for non-OpenAI protocols.

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

A background process periodically checks token expiration and refreshes tokens before they expire, with provider-specific safety margins. Concurrent refresh requests for the same token are deduplicated via an in-memory Promise map so simultaneous requests don't stampede the upstream token endpoint. An inline refresh safety net runs in the credential lease path as well: if the background job fell behind or just didn't run since the gateway restarted, the next credential lease detects the stale token and refreshes it synchronously before handing the credential to the backend module. Refresh failures mark accounts for re-authentication.

## Auto-provisioning

Whenever a provider first obtains a usable credential — either by completing an OAuth flow, by being created with an API key in the management request payload, or by later receiving an API key through provider update — the system automatically runs model discovery against the provider and persists the discovered models in the registry.

- Providers created with a static API key run discovery synchronously during the create request so the provider is immediately usable without a second management call. If that initial sync fails, the create request fails and the new provider row is rolled back.
- Providers updated with a static API key run the same strict discovery-and-sync pass before the PATCH request reports success. If that sync fails, the update request returns an error instead of silently leaving the provider in a "credential saved, models missing" state.
- Providers that finish an OAuth flow run the same discovery-and-sync path before the callback is reported as complete. If sync fails, the callback reports an error instead of pretending the provider is ready.
- Provider create/update, OAuth completion, manual sync, startup refresh, and background refresh share one discovery-and-sync path: discovery descriptors are normalized, duplicate discovered model keys are coalesced before writes, new upstream rows are inserted, and non-manual previously discovered rows are updated. Missing upstream synced rows are disabled with `metadata.syncDisabled = { reason:'missing-from-discovery', source, at }` instead of being deleted. If the same upstream-discovered row returns later, the row is re-enabled and the marker is cleared. Operator-disabled rows stay disabled, and manual rows are preserved.
- OpenAI-compatible discovery preserves any pricing/context metadata the provider's own `/models` response already exposes. When fields are still missing after that parse, the sync path runs the shared `enrichModelMetadata()` pipeline (`src/runtime/policy/model-metadata-classifier.mjs`). Precedence is strict but now four-staged: provider-supplied metadata wins; the cached OpenRouter-backed pricing directory fills remaining pricing/context/capability-tag gaps (it matches by exact id, canonical slug, curated provider-alias rewrite, and finally unique leaf slug — never by fuzzy search); a small static curated metadata table fills exact-model gaps and applies gateway billing semantics such as `isFree:true` for known free-provider catalogs and exact free-model overrides; and the local classifier adds curated family/domain tags (coding, reasoning, agentic, fast, long-context, multilingual, writing, etc.) plus a trusted-provider `tool-calling` augmentation. The classifier never overwrites capability-signal tags (`vision`, `audio`, `tool-calling`, `structured-outputs`, `moderated`, `free`) and never infers `free` on its own. Directory-sourced fields are tagged in `row.metadata.openrouter`; curated static overrides are tagged in `row.metadata.curated`; classifier-sourced tags are tagged in `row.metadata.classifier`.
- Manual model rows are preserved. The sync path does not overwrite rows whose `discovery_source` is `manual`.
- Providers whose upstream can validate connectivity but cannot expose a meaningful model list still complete successfully with zero discovered models, leaving manual model creation as the fallback.
- On process startup, and again on the background provider catalog refresh interval, enabled discoverable providers with usable credentials are refreshed through the same sync path. These catalog refresh passes are best-effort and continue across providers when one provider fails or is skipped. If a refresh returns an empty discovery set for a provider that already has provider-seeded rows, the refresh preserves the existing rows instead of treating the empty response as authoritative removal.

## Format converters

Not all upstream providers speak OpenAI's chat completion format natively. Format converters translate between the gateway's OpenAI-compatible interface and provider-specific protocols. The shared upstream LLM dispatch layer (`achillesAgentLib`) covers the protocol families needed by the shipped backends: OpenAI-compatible Chat Completions, OpenAI-compatible Responses, OpenAI-compatible classic Completions, Anthropic-compatible Messages, Google Gemini, GitHub Copilot's mixed Completions/Responses API, AWS Kiro's binary event-stream API, and Hugging Face's OpenAI-compatible chat API.

For providers that share a protocol family, configuration is primarily the provider base URL, credential material, model identifier, and any provider-specific headers or request parameters. Adding another provider in an already-supported family does not require a new core request pipeline — for OpenAI-compatible vendors, adding a preset to the preset catalog is enough. OpenAI-compatible embeddings use the same leased credential and provider base URL, dispatching through `achillesAgentLib`'s OpenAI provider helper for `/embeddings`.

All converters produce a uniform typed chunk stream: text deltas, tool-call deltas, completion signals, and errors. This abstraction lets new providers plug into the request pipeline without changing the pipeline itself.

## Provider transport ownership invariant

Request-time LLM inference and embedding provider calls must go through `achillesAgentLib`. Soul Gateway owns routing, provider/account selection, credential leasing, middleware policy, quota/budget enforcement, observability, and conversion from Achilles output into gateway canonical streams. It must not own vendor-specific completion/generation transports for LLM protocol families (OpenAI, Anthropic, Gemini, Copilot, Kiro, etc.) or OpenAI-compatible embeddings transport.

The canonical Achilles source for this workspace is `/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib`.

Lifecycle probes and model discovery are outside the request-time inference path. They may use direct vendor HTTP when they are validating provider connectivity or syncing catalog metadata, provided they use the credential lease for the target provider and do not implement an alternate completion/generation path. Prefer Achilles helpers for lifecycle calls when the relevant provider module exposes them.

When operating Soul Gateway itself, Achilles must be used in direct-provider mode with the leased upstream credential for request-time LLM inference.

## Provider template catalog

The provider template catalog exposed by the management API merges two sources:

1. **Loaded backend modules** that represent distinct vendor offerings — the OAuth-backed modules: GitHub Copilot, OpenAI Codex, Anthropic Claude.ai, AWS Kiro, and Google Gemini OAuth.
2. **A static preset catalog** of vendor-labeled configurations that share a protocol-family backend — OpenAI-compatible vendors (OpenAI direct, OpenRouter, NVIDIA, Groq, Fireworks, Together, DeepSeek, DeepInfra, Perplexity, Mistral, Mistral Codestral, xAI, Cohere), and a direct Anthropic API preset.

Protocol-family dispatcher backends (`openai-api`, `anthropic-api`) are marked as hidden in their manifest and do not surface in the template dropdown as standalone entries — a user always picks a vendor preset (which pre-fills display name, base URL, and auth strategy) rather than the raw dispatcher. The two derived OAuth backends (`gemini-openai`, `claudeai-api`) explicitly opt out of their parent's hidden flag since they are distinct vendor offerings without a preset.

## Connectivity tests

The Test button on each provider invokes the backend module's `testConnection` lifecycle method, routed through `backendCatalog.testConnection(provider, options)`:

- **OpenAI-compatible providers** first try `GET /models`. If that returns 404 (as on Mistral's Codestral subdomain, which only exposes `/chat/completions` and `/fim/completions`), the backend module falls back to an empty `POST /chat/completions` probe and interprets the status code: 2xx or 4xx other than 401/403/404 means the endpoint is reachable and the credential is recognised (reported as "Connected (model listing not exposed at this base URL)"), 401/403 surfaces the auth failure, and a double-404 indicates the base URL itself is wrong.
- **OAuth-backed providers** validate the credential lease (presence + non-expired) rather than making a live call that is known to fail due to scope restrictions (e.g. the Codex OAuth token isn't accepted by `api.openai.com/v1/models` even when it is perfectly valid for the ChatGPT backend).

Model discovery is stricter than connectivity testing:

- discovery is expected to return a model catalog or throw
- OpenAI-compatible discovery still tolerates the "listing unsupported but API reachable" case by returning zero models after the fallback `/chat/completions` probe succeeds
- auth failures, wrong base URLs, and transport errors are surfaced as discovery errors instead of being silently converted into an empty list

## Credential storage

- **Static API keys** are stored as encrypted rows in a provider-accounts table using AES-256-GCM. The cipher components (ciphertext, 12-byte IV, 16-byte auth tag) are persisted as raw bytes so they round-trip cleanly through the database's binary columns. Keys are decrypted only at dispatch time, held in a lease object, and wiped from memory on release.
- **OAuth credentials** are stored as encrypted credential files in a per-provider directory on disk, keyed by account index. The encryption module uses the same AES-256-GCM primitive, with explicit hex encoding at the JSON file boundary. Credentials are leased into provider execution only for the duration of a request.

## Inbound API key authentication

Soul Gateway authenticates incoming API calls using Ploinky-issued signed-subject identity. Agent runtime keys are raw signed-subject tokens with the format `<subjectId>|<base64url-ed25519-signature>`, where the signature is over the exact UTF-8 bytes of `subjectId`. User-facing keys use an encoded wrapper around the generic user subject form `user:<userId>`, with the format `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>`; admin-created user keys use `user:<owner>:<name>` as their inner subject. Soul Gateway decodes the wrapper, then verifies the inner signed-subject value with the Ed25519 public key in `PLOINKY_AGENT_API_PUBLIC_KEY`; Ploinky holds the corresponding private key and signs.

**Agent key format:** `<subjectId>|<base64url-ed25519-signature>`

**User key format:** `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>` for the generic user subject form; admin-created keys use `sk-soul-<base64url(user:<owner>:<name>|<base64url-ed25519-signature>)>`.

Raw user signed-subject bearer tokens are rejected. User keys must use the `sk-soul-` wrapper so the visible copied key string displays the base64url wrapper instead of the literal user/admin subject text; base64url is reversible and is not a privacy boundary. Agent keys remain raw because they are runtime-injected into Ploinky-managed agents rather than shown to dashboard users.

**Revocation semantics:**
- Revoking the database row (setting `status='revoked'`) blocks all calls from that subject until the row is removed or re-enabled.
- Deleting the row allows the same subject to re-register on its next valid signed request.
- Per-subject rotation without changing the subject id is not available — the key is deterministic from `subjectId` and the signing key pair. To rotate a single subject's key, change the subject id.
- Rotating Ploinky's Ed25519 signing key invalidates every signed key simultaneously.

**No workspace default key:** There is no shared workspace-generated API-key secret. Each Ploinky agent receives its own `PLOINKY_AGENT_API_KEY` signed-subject value injected by the Ploinky runtime at startup. It is not a manifest-declared `sharedGeneratedSecret` field; it is runtime-injected by the launcher.

**Legacy identity headers rejected:** Soul Gateway rejects requests carrying `x-soul-id`, `x-agent-name`, or `x-soul-agent` with HTTP 400. Identity is established exclusively from the signed-subject key.

**Loop guard:** A call whose signed key resolves to the same subject as the model being invoked (the caller is the soul gateway model representing itself) is rejected with HTTP 400.

## Decisions & Questions

1. 2026-06-24: Signed-subject identity uses the generic Ploinky agent key names. Callers present `PLOINKY_AGENT_API_KEY`, and Soul Gateway verifies it with `PLOINKY_AGENT_API_PUBLIC_KEY`; the former Soul Gateway-named compatibility alias is removed.
2. 2026-06-27: Admin-created user API keys are shown to admins and accepted only as `sk-soul-<base64url(user:<owner>:<name>|<signature>)>`; raw `user:<owner>:<name>|<signature>` bearer tokens are rejected. Agent runtime keys remain raw signed-subject values.

## Related specs

- **DS003** — the middleware/backend model and the unified `BackendCatalog`; provider pipeline composer.
- **DS004** — model routing, which resolves a requested model name into a concrete provider and model.
- **DS007** — account rotation is driven by quota-specific rate-limit and payment-required errors classified here.
- **DS009** — error classification and the retry loop that triggers account rotation.
- **DS012** — the management API endpoints for provider CRUD, OAuth flow orchestration, account management, and connectivity tests.
