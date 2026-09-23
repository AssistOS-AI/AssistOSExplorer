---
title: DS005-authentication-and-credentials
summary: Defines caller authentication, Router-protected administration, provider accounts, secret storage, leasing, OAuth, and rotation.
---

## Introduction

Soul Gateway separates caller identity from provider credentials. Public inference verifies Ploinky-signed subjects, management verifies protected Router invocations, and provider execution leases encrypted API-key or OAuth account material for one attempt.

## Core Content

### Public caller authentication

The only production bearer identity is a [signed-subject key](../wiki.html#definition-signed-subject-key) verified with Ed25519 and <code>PLOINKY_AGENT_API_PUBLIC_KEY</code>. Agent subjects must match <code>agent:&lt;repo&gt;/&lt;agentName&gt;</code> and remain in raw <code>&lt;subject&gt;|&lt;signature&gt;</code> form. User subjects must match <code>user:&lt;userId&gt;</code> and must be encoded as canonical base64url after the <code>sk-soul-</code> prefix. Raw user keys and encoded agent keys must be rejected.

After verification, the gateway must upsert one deterministic API-key row per subject and apply its limits, budget, status, and expiry. Revocation must block the row without automatic reactivation. Deleting the row permits recreation after a later valid signature. Rotating the Ploinky signing key invalidates every signature created by the previous key.

<code>ALLOW_UNAUTHENTICATED=true</code> may create a development-only permissive identity and must emit a warning. Startup must fail when authentication is enabled and any of <code>PLOINKY_AGENT_API_PUBLIC_KEY</code>, <code>PLOINKY_ROUTER_URL</code>, <code>PLOINKY_AGENT_ID</code>, or <code>PLOINKY_AGENT_SECRET</code> is missing.

### Management authentication

Management requests must carry a Router-provided authentication object with an administrator role, a protected HTTP invocation token, and an invocation body. Soul Gateway must verify the signed method, path, query, and body hash with the Ploinky route verifier and a replay cache. Missing, non-administrator, malformed, replayed, or unverifiable requests must fail closed.

Deprecated dashboard password and local session settings may be parsed for compatibility but must not authenticate management operations.

### Provider accounts and leases

A provider may use no authentication, API-key authentication, OAuth, hybrid authentication, or a custom strategy declared by its backend manifest. Secret material must remain outside public and management responses. API-key secrets must be encrypted at rest. OAuth files must be stored below <code>CREDENTIALS_DIR</code> through the OAuth credential store and protected by the gateway encryption key.

Each direct-model attempt must acquire a [credential lease](../wiki.html#definition-credential-lease) from an eligible provider account and release it in all outcomes. The account pool may rotate least-recently-used accounts, exclude disabled or quota-exhausted accounts, and restore accounts after a quota reset. An [account-scoped failure](../wiki.html#definition-account-scoped-failure) caused by an exhausted quota must mark the leased account <code>quota_exhausted</code> so later requests stop spending the shared quota. The lock lasts until the upstream <code>x-ratelimit-reset</code> time, clamped to between one minute and 26 hours; without a reset header it lasts at most 15 minutes (or until the next UTC midnight if sooner), after which the account is tried again, which bounds the cost of a misclassified error. The quota-reset sweep restores the account after the lock expires. When a provider that requires credentials has no eligible account, the attempt must fail with an account-scoped <code>provider_accounts_exhausted</code> error before any upstream request is sent.

### Bundled free-provider credential

The first-start free defaults need a provider account before any administrator exists to configure one. Soul Gateway therefore carries one restricted OpenRouter key in the backend-only module <code>src/bootstrap/free-provider-credential.mjs</code>. The key belongs to a dedicated free-tier OpenRouter account whose key has a zero credit limit and an upstream guardrail that allows only free models, so a paid request is rejected by OpenRouter even if the gateway's own [free-only provider](../wiki.html#definition-free-only-provider) checks were bypassed. The module must never be imported by dashboard, browser, or public model-listing code. The module holds the key as an XOR-masked hex body without its <code>sk-or-v1-</code> prefix and unmasks it when the module loads, so pattern-based secret scanners, including GitHub's partner scanning of public repositories, do not match it. The masking is not a confidentiality control: anyone with the source can unmask the key, whose protection remains its zero credit limit and free-only guardrail. The unit test <code>bundled-credential-masking.test.mjs</code> fails when a plaintext OpenRouter key appears anywhere in the repository checkout.

The one-time install encrypts the key with the gateway encryption key and stores it only as an encrypted <code>provider_accounts</code> row of the <code>openrouter-free</code> provider, labeled <code>Bundled free-tier key (shared quota)</code>, with <code>bundled=true</code> and the upstream expiry in the account metadata; the current key has no upstream expiry, so <code>expiresAt</code> is <code>null</code>. Management and public responses never return the key. When <code>OPENROUTER_API_KEY</code> is set at the time of that install, the operator's key is stored in place of the bundled key and the account is labeled as an ordinary OpenRouter key. Setting <code>OPENROUTER_API_KEY</code> after the install has completed does not change the stored account, and neither does a different bundled key in a later release: a new bundled key reaches only databases that have not yet run the one-time install.

The bundled key's free-model allowance is one daily quota shared by every installation that uses the key. OpenRouter's free tier currently allows 50 free-model requests per day for such an account, and failed attempts may not count against it. The allowance is not unlimited and not guaranteed, and the key stops working when its owner revokes it upstream. An administrator replaces it through the management dashboard by updating the <code>openrouter-free</code> provider with a new API key (<code>PATCH /management/providers/:providerId</code> with <code>apiKey</code>). The replacement re-encrypts the account secret, sets the account active, clears the stored quota reset time, removes the <code>bundled</code> and <code>expiresAt</code> metadata because they no longer describe the stored key, and clears the running gateway's in-memory exhaustion record for the account, so the new key is used on the next request without a restart. Replacing the key does not change the provider's <code>free_only</code> setting, so the free-only policy still applies; paid models belong on a separately configured provider.

### OAuth and lifecycle operations

Enabled OAuth adapters may implement authorization start, callback, pending state, token refresh, and provider-specific credential persistence. OAuth state must expire after the configured TTL. Expiring tokens may refresh inline before use and through the background token-refresh job. A refresh failure must not expose stored credential data.

Connectivity tests and model discovery may use leased provider credentials and direct vendor metadata requests. They must remain lifecycle operations and must not return completion or generation content to a public caller.

### SuperGrok subscription authentication

The <code>xai-supergrok</code> OAuth adapter must authorize an eligible SuperGrok account through the xAI device-code grant. Administrators open the verification URL on a browser device and approve access using the account that owns the subscription. The gateway must retain the device credential privately, enforce its expiry and polling interval, increase the interval after <code>slow_down</code>, and terminate denied or failed flows without exposing provider response bodies. The existing encrypted credential store must persist access and refresh tokens, including rotated refresh tokens. The access-token deadline must use the earlier of the token response expiry and the JWT expiry when available; JWT claims are display and refresh hints, not verified identity for gateway authorization.

The <code>xai-supergrok</code> preset must use the <code>openai-api</code> backend at <code>https://api.x.ai/v1</code> with OAuth bearer credentials. Model discovery and inference remain subject to the account's upstream model access and subscription quota. The existing <code>xai</code> API-key preset remains a separate configuration choice.

### Encryption-key boundary

The generated <code>DATA_DIR/encryption.key</code>, SQLite database, and encrypted OAuth files form one recovery set. The key file must use restrictive permissions. A replacement key must not be treated as capable of decrypting existing secret material, and startup or provider operations must report decryption failure rather than silently discarding protected credentials.
