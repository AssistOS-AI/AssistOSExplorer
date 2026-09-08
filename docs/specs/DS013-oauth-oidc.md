---
title: DS013-oauth-oidc
summary: Defines UserPersisto OAuth 2.0 / OpenID Connect interoperability, durable applications and credentials, browser consent, token lifecycle, and deployment configuration.
---

# DS013 OAuth / OpenID Connect

## Product boundary

UserPersisto is an OAuth 2.0 authorization server and OpenID Connect provider for administrator-registered applications. It uses the pinned `oidc-provider` engine for protocol processing and Persisto for application metadata, signing material, browser sessions, interactions, grants, authorization codes, and tokens. The existing Ploinky SSO interface is retained. External OAuth tokens do not become Ploinky session cookies, verified invocation grants, or permission to access protected Explorer routes.

This contract covers a practical interoperable subset: authorization code with S256 PKCE, discovery, RS256 ID tokens, UserInfo, refresh-token rotation, confidential client credentials, token introspection and revocation, and RP-initiated logout. It does not claim OpenID certification or full Keycloak feature parity. The authoritative discovery document describes the enabled features; applications must not assume features from a different provider's discovery response.

## Issuer and deployment configuration

| Configuration | Contract |
| --- | --- |
| `USERPERSISTO_OIDC_ISSUER` | Explicit, stable public issuer URL. Empty disables OAuth/OIDC while preserving Ploinky SSO. A malformed value fails closed. HTTPS is required except development HTTP on exactly `localhost`, `127.0.0.1`, or `[::1]`. No credentials, query, fragment, or trailing slash. The path ends in `/service/oidc`. |
| Router deployment issuer | `https://id.example/base-agent-additional-server/userPersistoAgent/7000/service/oidc`, substituting the deployment's real public host. The full Router-visible prefix is part of the issuer and every endpoint URL. |
| `USERPERSISTO_SETTINGS_KEY` | Existing generated encryption key, retained across restarts. It protects durable OIDC material as well as existing settings. Back it up through the runtime secret-store mechanism together with the Persisto snapshot. Changing or losing it is not a supported key-rotation procedure. |
| Persistence volume | Existing `PERSISTENCE_FOLDER`, with DS012's exclusive-writer and durable-snapshot guarantees. A healthy persistent volume and stable encryption key are required before enabling the provider. |

Issuer selection never uses untrusted `Host`, `Origin`, or forwarded headers. The transport pins protocol authority to configured issuer data before invoking the engine. Discovery, redirects, interaction URLs, and cookie paths must remain correct when the Router strips its additional-server prefix before proxying to the agent. Existing Ploinky ownership/bootstrap should be completed before exposing the provider publicly and before creating applications; this change does not introduce a second administrator bootstrap endpoint.

The agent manifest declares a generic `publicProtocol` route boundary. Ploinky permits the declared protocol methods, CORS handling, and exact loopback redirect behavior without requiring a prior Ploinky login. The provider owns OAuth client authentication, PKCE, interaction cookies, and CSRF checks. Adjacent nonprotocol routes retain their existing protections; a route declaration must not make an entire additional server public by accident.

Router deployments require the accompanying Ploinky `publicProtocol` implementation and UserPersisto changes together. Installing the agent alone on an older Router does not establish the required public protocol boundary. Ploinky's normal dependency preparation installs the declared provider package before mounting runtime dependencies; the agent's installation hook must not rewrite that mounted dependency tree.

## Standard endpoints

Paths in this table are relative to the configured issuer. Clients should discover them instead of assembling them from assumptions.

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/openid-configuration` | Public OIDC metadata, including the exact issuer, endpoint URLs, supported grants, signing algorithm, scopes, and PKCE methods. |
| `/jwks` | Public verification keys only. Private signing keys are never exposed. |
| `/authorize` | Browser authorization using `response_type=code`, a registered exact redirect URI, requested scopes, and S256 PKCE. |
| `/token` | Form-encoded authorization-code exchange, refresh-token exchange, or confidential client-credentials grant. |
| `/userinfo` | Scope-filtered current user claims, authenticated with the issued bearer access token. |
| `/introspect` | Authenticated token activity and metadata lookup; restricted to a confidential client inspecting tokens issued to that same client. |
| `/revoke` | Client-authenticated revocation of its own token according to the OAuth revocation contract. A public client identifies itself without a secret. |
| `/logout` | RP-initiated logout with browser confirmation and registered post-logout redirects. |
| `/interaction/{uid}` | Provider-owned browser login, registration, and scope-consent screens for a live authorization request. Not an application API. |

Discovery and JWKS are public resources. Token endpoints accept standard OAuth client authentication: `client_secret_basic`, `client_secret_post`, or `none` for registered public clients. Unknown clients, disabled clients, invalid secrets, unsupported grants, redirect mismatch, missing/invalid PKCE, expired codes, and replayed codes fail before a token is issued. Confidential clients also use PKCE for authorization-code requests.

## Application administration

Every application tool resolves the acting user from verified runtime invocation context and re-reads the persisted `admin.agentSettings.manage` capability. Caller-supplied actor, roles, or capability fields cannot authorize an operation. Dynamic client registration is disabled.

| Tool | Input / output |
| --- | --- |
| `userpersisto_oidc_status` | Returns `{ enabled, issuer, discoveryUrl }`. |
| `userpersisto_oidc_clients_list` | Accepts `{ start, pageSize }`; returns `{ items, total, hasMore, start, pageSize }`. Listing never returns a client secret. |
| `userpersisto_oidc_client_create` | Accepts client metadata; returns `{ client, client_secret? }`. Client ID may be omitted for server generation. Confidential secrets are generated by the server. |
| `userpersisto_oidc_client_update` | Accepts `client_id` and changed metadata; returns `{ client }` without its secret. |
| `userpersisto_oidc_client_rotate_secret` | Accepts `{ client_id }`; returns `{ client, client_secret }`. The previous secret immediately stops authenticating the client. |
| `userpersisto_oidc_client_delete` | Accepts `{ client_id }`; returns `{ ok: true, client_id }`. The deleted registration is no longer usable. |

Client metadata contains `client_id`, `client_name`, `redirect_uris`, `post_logout_redirect_uris`, `token_endpoint_auth_method`, `grant_types`, `scope`, and `enabled`. Response types are derived from the allowed grants: `code` for authorization-code clients and no browser response type for machine-only clients. Defaults are confidential HTTP Basic authentication, the authorization-code grant, and `openid profile email` scopes. The server validates every field, including update patches.

Redirects and post-logout redirects are canonical absolute HTTPS URLs or HTTP on an exact allowed loopback host. Wildcards, user information, fragments, malformed URLs, and nonloopback HTTP are rejected. Matching is exact, including registered path, query, and port; there is no wildcard port or path expansion. Authorization-code clients need at least one redirect URI. Browser and native applications use `token_endpoint_auth_method: none` and store no client secret. Public clients cannot use `client_credentials`. Changing a client between public and confidential authentication requires a new registration. Refresh tokens require the authorization-code grant; `offline_access` additionally requires the refresh-token grant. Machine-only clients use `client_credentials` with only the `api` scope, no redirect URIs, and no identity claims; browser and machine grants cannot be mixed in one client.

Any metadata update, including a name change or enable/disable action, revokes the client's existing grants and tokens. Secret rotation also revokes them. The next browser sign-in must obtain consent again. This intentionally favors immediate enforcement of updated redirects and scope policy over retaining existing sessions. Confidential Basic/form authentication changes retain the current secret unless it is separately rotated.

The My Account Applications panel is available to administrators, including through **Profile → Manage OAuth applications** when embedded. It provides metadata editing, status changes, delete/rotation confirmations, and pages of 100 applications. Save errors preserve the entered metadata. Deleting the last row on a page moves to the previous valid page. Issuer configuration is displayed as a readout; this panel does not silently choose or change the public issuer.

A generated confidential secret is visible only in the create/rotation response and a transient copyable field. It is never retained in the presenter state, browser storage, application list, or logs. Refreshing, changing panels, dismissing the field, closing the modal, or losing administrator status clears the displayed secret. Applications must save it immediately in their own server-side secret store. Rotating a secret requires coordinating the relying application's deployment; it does not retrieve the previous value.

## User authentication and consent

OIDC interactions are bound to the initiating browser and a live engine interaction. HTTP-only, SameSite=Lax cookies are secure on HTTPS, and signed using durable cookie keys. Login and consent mutations require the current interaction proof and accepted same-origin browser context. An interaction URL or copied callback alone is insufficient to authenticate another browser. Redirect URLs are taken from the validated authorization request, never from an arbitrary form destination.

Browser responses use `Referrer-Policy: same-origin`: cross-origin destinations receive no referrer, while same-origin form submissions retain the `Origin` required by interaction CSRF checks. Interaction CSP allows form submission to the provider and the origin of that interaction's already validated callback, because browsers apply `form-action` to the subsequent authorization redirect chain. It does not allow arbitrary external form destinations. POST bodies are limited to 56 KiB and a ten-second read deadline before entering the persistence scope. An incomplete oversized or timed-out request receives its error response and then closes its connection and body reader.

Password, email-code, TOTP, and passkey authentication reuse UserPersisto's existing credential checks and persisted policy. Only enabled methods are offered and accepted. Email-code authentication cannot create an unknown account. TOTP and passkey authentication require an existing enrollment, which the account dashboard and My Account Profile panel provide as specified in DS012. Registration remains a distinct email/password action governed by DS012's password, first-owner, and later-registration rules: the first owner is an administrator, while later signup defaults to `selfRegistered` with dashboard-only access. Disabling registration hides and rejects it for later users. Recovery, step-up authentication, and verified-email workflows remain outside this scope.

After authentication, the user sees the registered application name and requested scopes and explicitly accepts or denies consent. Consent is not automatically accepted for administrator-owned applications. The grant records the approved scopes and account. A denied request returns an OAuth error only to the validated redirect URI. `state` is echoed according to the protocol; the relying party must verify it. OIDC requests should also send and validate a fresh `nonce`.

## Claims and token lifecycle

| Scope | Claims or effect |
| --- | --- |
| `openid` | OIDC subject identifier and ID token. `sub` is the durable UserPersisto user ID. |
| `profile` | `name` and `preferred_username` when available. |
| `email` | `email` and truthful `email_verified` state. This implementation does not introduce email verification. |
| `roles` | Current persisted role IDs. |
| `capabilities` | Current effective persisted capabilities. |
| `offline_access` | Allows a refresh token only when the client also permits the refresh-token grant, the authorization request uses `prompt=consent`, and the user consents. |
| `api` | Generic API authorization scope, including confidential machine-client access. It does not confer an Explorer role or Ploinky access. |

ID tokens use RS256, identify the configured issuer and requesting client audience, and carry the request nonce when supplied. Signing keys are durable across restart; JWKS publishes only their public components. UserInfo returns only authorized scope claims and requires an active current user. Tokens and consent must never expose password hashes, TOTP secrets, private passkey material, client secrets, or private signing keys.

Access tokens are opaque bearer credentials, not JWTs. They expire after 300 seconds. ID tokens expire after 300 seconds, authorization codes after 60 seconds, browser interactions after 600 seconds, and provider browser sessions after four hours. Refresh tokens last up to one day per issued token and rotate on every successful use. Reusing an already consumed refresh token revokes its grant and the related tokens rather than issuing another branch of credentials. Grants have a 30-day lifetime. Consumption, expiration, and revocation survive restart; code and refresh-token races must not produce duplicate successful exchanges.

Blocking a user or disabling/deleting its client must prevent new credentials and invalidate activity checks. Claims are resolved from current persisted identity rather than trusted from stale caller input. Previously issued ID tokens remain independently verifiable until their expiration; applications that need current authorization must use current token activity/identity checks rather than treating old ID-token claims as permanent access decisions.

API consumers use authenticated introspection under the confidential client that obtained the opaque token. A client cannot inspect or revoke another client's token. This revision does not provide separate shared resource-server credentials, resource indicators, JWT API audiences, or a central API authorization policy. A public browser client's token is suitable for the provider's UserInfo endpoint; integrating it with a separate API requires an explicitly designed server-side validation boundary. Neither ID tokens nor OAuth access tokens bypass Ploinky's existing route/session checks.

RP-initiated logout clears the provider's browser session through the confirmation flow. Only registered post-logout redirect URIs are accepted. The relying application must separately clear its own session. The existing custom Ploinky SSO session is separate; logging out of an OIDC relying party does not claim to log out every Ploinky or third-party application.

## Durability and failure behavior

The protocol adapter encrypts stored payloads, client secrets, RS256 private signing material, and cookie keys using AES-256-GCM derived from the stable settings encryption key, with authenticated storage context. Persisto's snapshot makes writes durable. The adapter supports expiry, UID/user-code lookup where required by the engine, token consumption, and grant-wide revocation without relying on process memory. Consumed records remain available for replay detection until their expiry. Client enable/disable/update/delete and secret rotation must be visible without restarting the provider.

Expired records are removed when looked up and through a bounded sweep on ordinary writes: at most 100 deletions per write, at most once per minute when no backlog remains. Subsequent writes drain a backlog. Revoked-grant markers remain until their associated grant/artifact expiry so old tokens cannot become valid again. No background timer removes records while the provider is idle.

Storage errors fail closed and follow DS012's poisoned-store behavior; an unpersisted code, grant, key, or token must never be acknowledged as durable success. A mismatched or unavailable encryption key must fail instead of silently generating replacement material. Preserve both the encrypted snapshot and its key in backups. Multiple writers and HA failover remain unsupported.

## Setup and client examples

Complete the existing first-owner setup, retain the generated settings key, configure the issuer on the UserPersisto agent, and restart it. From an administrator session, open **Settings → My Account → Profile → Manage OAuth applications** and verify the displayed issuer/discovery URL. Register exact application callbacks and save any generated confidential secret in the application server's secret store.

A public browser or native application can be registered through the administrative tool with this payload:

```json
{
  "client_id": "example-browser",
  "client_name": "Example browser application",
  "redirect_uris": ["https://app.example/callback"],
  "post_logout_redirect_uris": ["https://app.example/signed-out"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "scope": "openid profile email offline_access",
  "enabled": true
}
```

Configure an OIDC relying-party library with the exact issuer, client ID, callback URI, response type `code`, requested scope, and PKCE method `S256`. For the example above, send `scope=openid profile email offline_access` and `prompt=consent` in the authorization request; omitting explicit consent does not request a refresh token successfully. The library should retrieve discovery and JWKS and validate issuer, audience, signature, nonce, state, and token expiry. Use a fresh cryptographically random verifier for every login and retain it only for that login transaction. If long-lived access is unnecessary, omit `offline_access` and the refresh-token grant.

For a local development callback, register an exact value such as `http://127.0.0.1:5173/callback`. It is independent of the provider issuer URL. Never copy example domains into a live client registration unchanged.

A server application uses `client_secret_basic` (or `client_secret_post`) with the authorization-code grant and still uses S256 PKCE. Keep its secret exclusively on the server. A machine-only registration instead uses:

```json
{
  "client_id": "example-service",
  "client_name": "Example service",
  "redirect_uris": [],
  "post_logout_redirect_uris": [],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["client_credentials"],
  "scope": "api",
  "enabled": true
}
```

That service submits `grant_type=client_credentials&scope=api` to the discovered token endpoint with HTTP Basic client authentication. It receives an opaque access token, not an ID token or a human-user identity. Its resource handler must explicitly validate current activity through the discovered introspection endpoint using the same client's confidential credentials before applying its own API policy.

## Verification contract and deliberate deferrals

Verification must exercise real protocol HTTP requests with a standards client or equivalent independent token verification, not only mocks of engine methods. Required cases include exact discovery/issuer URLs behind the Router, public JWKS with stable restart identity, authorization and nonce, S256 PKCE failures, exact redirect rejection, confidential client authentication, token and refresh replay, expiry, scope-filtered UserInfo, current blocked-user and disabled-client enforcement, cross-client introspection/revocation rejection, machine grants, consent denial, browser/CSRF binding, enabled-method policy, registration, logout, and persistence failure/restart behavior.

Administrator tests must reject untrusted invocation context and nonadministrators, validate malformed metadata, enforce public/confidential grant restrictions, prove secret-at-rest protection and one-time responses, and verify update/disable/delete/rotation take effect without provider restart. UI tests cover structured creation/editing, pages beyond 500 clients, deletion from the final page, failed saves preserving inputs, HTML escaping, secret clearing, and loss of authorization during a request. Browser verification covers real form interactions and visible error/success states. Router tests prove protocol requests work without a Ploinky session while adjacent routes remain protected.

Dynamic client registration, implicit/hybrid and password grants, device authorization, SAML, upstream identity federation/social login, advanced MFA enrollment, password recovery, email verification, DPoP, PAR/JAR, resource indicators, automated signing-key rotation, multi-tenant realms, high availability, and OpenID conformance certification remain outside this revision. These are explicit scope boundaries, not undocumented assumptions about Keycloak equivalence.

## Standards references

The provider contract follows the authorization-code and identity concepts in [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html), PKCE in [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html), current security guidance in [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), and the logout flow in [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html). This implementation's narrower supported profile and verification evidence govern claims of compatibility.
