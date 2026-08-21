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

Each direct-model attempt must acquire a [credential lease](../wiki.html#definition-credential-lease) from an eligible provider account and release it in all outcomes. The account pool may rotate least-recently-used accounts, exclude disabled or quota-exhausted accounts, and restore accounts after a quota reset. A provider-auth or quota error may update account eligibility before retry or cascade classification proceeds.

### OAuth and lifecycle operations

Enabled OAuth adapters may implement authorization start, callback, pending state, token refresh, and provider-specific credential persistence. OAuth state must expire after the configured TTL. Expiring tokens may refresh inline before use and through the background token-refresh job. A refresh failure must not expose stored credential data.

Connectivity tests and model discovery may use leased provider credentials and direct vendor metadata requests. They must remain lifecycle operations and must not return completion or generation content to a public caller.

### Encryption-key boundary

The generated <code>DATA_DIR/encryption.key</code>, SQLite database, and encrypted OAuth files form one recovery set. The key file must use restrictive permissions. A replacement key must not be treated as capable of decrypting existing secret material, and startup or provider operations must report decryption failure rather than silently discarding protected credentials.
