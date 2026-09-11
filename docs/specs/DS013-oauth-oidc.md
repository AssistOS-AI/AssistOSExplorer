---
title: DS013-oauth-oidc
summary: Defines UserPersisto OAuth 2.0 / OpenID Connect interoperability, durable applications and credentials, browser consent, token lifecycle, and deployment configuration.
---

# DS013 OAuth / OpenID Connect

## Introduction

UserPersisto is an OAuth 2.0 authorization server and OpenID Connect provider for administrator-registered applications. It uses the pinned `oidc-provider` engine for protocol processing and Persisto for application metadata, signing material, browser sessions, interactions, grants, authorization codes, and tokens. The existing Ploinky SSO interface is retained. External OAuth tokens do not become Ploinky session cookies, verified invocation grants, or permission to access protected Explorer routes.

This contract covers a practical interoperable subset: authorization code with S256 PKCE, discovery, RS256 ID tokens, UserInfo, refresh-token rotation, confidential client credentials, token introspection and revocation, and RP-initiated logout. It does not claim OpenID certification or full Keycloak feature parity. The authoritative discovery document describes the enabled features; applications must not assume features from a different provider's discovery response.

## Core Content

### Issuer and deployment configuration

| Configuration | Contract |
| --- | --- |
| `USERPERSISTO_OIDC_ISSUER` | Explicit, stable public issuer URL. Empty disables OAuth/OIDC while preserving Ploinky SSO. A malformed value fails closed. HTTPS is required except development HTTP on exactly `localhost`, `127.0.0.1`, or `[::1]`. No credentials, query, fragment, or trailing slash. The path ends in `/service/oidc`. |
| Router deployment issuer | `https://id.example/base-agent-additional-server/userPersistoAgent/7000/service/oidc`, substituting the deployment's real public host. The full Router-visible prefix is part of the issuer and every endpoint URL. |
| `USERPERSISTO_SETTINGS_KEY` | Existing generated encryption key, retained across restarts. It protects durable OIDC material as well as existing settings. Back it up through the runtime secret-store mechanism together with the Persisto snapshot. Changing or losing it is not a supported key-rotation procedure. |
| Persistence volume | Existing `PERSISTENCE_FOLDER`, with DS012's exclusive-writer and durable-snapshot guarantees. A healthy persistent volume and stable encryption key are required before enabling the provider. |

Issuer selection never uses untrusted `Host`, `Origin`, or forwarded headers. The transport pins protocol authority to configured issuer data before invoking the engine. Discovery, redirects, interaction URLs, and cookie paths must remain correct when the Router strips its additional-server prefix before proxying to the agent. Existing Ploinky ownership/bootstrap should be completed before exposing the provider publicly and before creating applications; this change does not introduce a second administrator bootstrap endpoint.

The agent manifest declares a generic `publicProtocol` route boundary. Ploinky permits the declared protocol methods, CORS handling, and exact loopback redirect behavior without requiring a prior Ploinky login. The provider owns OAuth client authentication, PKCE, interaction cookies, and CSRF checks. Adjacent nonprotocol routes retain their existing protections; a route declaration must not make an entire additional server public by accident.

Router deployments require the accompanying Ploinky `publicProtocol` implementation and UserPersisto changes together. Installing the agent alone on an older Router does not establish the required public protocol boundary. Ploinky's normal dependency preparation installs the declared provider package before mounting runtime dependencies; the agent's installation hook must not rewrite that mounted dependency tree.

### Standard endpoints

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

### Application administration

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

The Administration Applications panel is available to administrators, under **Settings → Administration → Applications**. It provides metadata editing, status changes, delete/rotation confirmations, and pages of 100 applications. Save errors preserve the entered metadata. Deleting the last row on a page moves to the previous valid page. Issuer configuration is displayed as a readout; this panel does not silently choose or change the public issuer.

A generated confidential secret is visible only in the create/rotation response and a transient copyable field. It is never retained in the presenter state, browser storage, application list, or logs. Refreshing, changing panels, dismissing the field, closing the modal, or losing administrator status clears the displayed secret. Applications must save it immediately in their own server-side secret store. Rotating a secret requires coordinating the relying application's deployment; it does not retrieve the previous value.

### User authentication and consent

OIDC interactions are bound to the initiating browser and a live engine interaction. HTTP-only, SameSite=Lax cookies are secure on HTTPS, and signed using durable cookie keys. Login and consent mutations require the current interaction proof and accepted same-origin browser context. An interaction URL or copied callback alone is insufficient to authenticate another browser. Redirect URLs are taken from the validated authorization request, never from an arbitrary form destination.

Browser responses use `Referrer-Policy: same-origin`: cross-origin destinations receive no referrer, while same-origin form submissions retain the `Origin` required by interaction CSRF checks. Interaction CSP allows form submission to the provider and the origin of that interaction's already validated callback, because browsers apply `form-action` to the subsequent authorization redirect chain. It does not allow arbitrary external form destinations. POST bodies are limited to 56 KiB and a ten-second read deadline before entering the persistence scope. An incomplete oversized or timed-out request receives its error response and then closes its connection and body reader.

Password, email-code, TOTP, and passkey authentication reuse UserPersisto's existing credential checks and persisted policy. Only enabled methods are offered and accepted. Email-code authentication cannot create an unknown account. TOTP and passkey authentication require an existing enrollment, which the account dashboard and My Account Profile panel provide as specified in DS012. Registration remains a distinct email/password action governed by DS012's password and later-registration rules, defaulting to `selfRegistered` with dashboard-only access. OIDC registration cannot create the initial administrator: an empty user store hides registration and rejects account creation inside the serialized user-registration operation. The existing Ploinky first-owner setup must be completed separately. Disabling registration hides and rejects it, including submissions from a form opened before the policy changed. Recovery, step-up authentication and general email verification remain outside this scope; the bounded Google new-registration mailbox prerequisite below is separate from email-code login.

An authorization request may include the optional UI extension `screen_hint=signup`. If the engine requires a login interaction and an effective self-registration method is available, the page starts with **Create your account**, the enabled password form and/or Google option, and an **Already registered? Sign in** disclosure containing the enabled sign-in methods. Absent or unrecognized hints preserve the sign-in-first page. Password sign-in and registration failures display the attempted form; no hint changes the registration role, enables a disabled method, forces a new login for an existing provider session, or bypasses consent. The hint is retained by the provider's authorization engine and is not taken from arbitrary interaction-page query parameters.

Applications may open the ordinary authorization URL in a separate browser popup; no popup-specific protocol parameter or embedded form API is required. Registration and login remain provider-owned, same-origin form submissions. The relying application must complete PKCE exchange and verify its own state, nonce, issuer, audience, signature, and token expiry before publishing its own session; a callback may relay only the bounded response URL to the original tab for those checks. The provider does not send credentials or identity messages directly to an opener; iframe embedding remains disabled.

After authentication, the user sees the registered application name and requested scopes and explicitly accepts or denies consent. Consent is not automatically accepted for administrator-owned applications. The grant records the approved scopes and account. A denied request returns an OAuth error only to the validated redirect URI. `state` is echoed according to the protocol; the relying party must verify it. OIDC requests should also send and validate a fresh `nonce`.

### Optional Google authentication

UserPersisto is a confidential Google Web application client for the canonical issuer `https://accounts.google.com`; it remains a separate OIDC provider for ScriptaHub and other registered applications. The two sets of client IDs, issuer, state, nonce, PKCE verifier, callback and cookies are independent. The pinned runtime `openid-client` 6.8.7 performs discovery, `ClientSecretPost`, authorization-code exchange and S256 PKCE. Nonrepudiation checks are explicitly enabled, requiring an ID token with RS256 signature validated against JWKS plus exact issuer/audience, authorized party when present or required, nonce, expiry and issuance-time sanity. Production HTTPS and issuer verification cannot be disabled or selected by requests; controlled providers are injected only during test construction. The request uses only `openid email`, code/query mode, and never requests offline Google access or stores Google access/refresh tokens. Provider errors are rendered neutrally without upstream prose or credentials.

Optional configuration is `USERPERSISTO_GOOGLE_CLIENT_ID`, operator-provided `USERPERSISTO_GOOGLE_CLIENT_SECRET` and exact `USERPERSISTO_GOOGLE_REDIRECT_URI`. The validator accepts a canonical HTTPS callback or exact configured loopback HTTP URL ending in `/service/auth/google/callback`. Supported browser deployments require the full Router path `/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback`; isolated direct-port HTTP fixtures are testing infrastructure, not the browser runtime contract. The administrator-only `userpersisto_google_status` requires current `admin.agentSettings.manage` and returns enabled/configured/available flags, missing variable names, callback/client ID, configuration source, secret-presence boolean and a safe readiness reason. Secrets have no browser editing or masking-fragment field and remain in Ploinky configuration, separate from billing settings. Google starts disabled; enabling it must preserve a usable administrator sign-in method. Configuration fingerprint changes and method disabling invalidate pending completion.

Each `googleAuthTransaction` is durable and indexed by its random state's hash. Its encrypted payload binds independent browser-proof hash, nonce, verifier, exact configured callback/client, configuration fingerprint, original Explorer request/core state or OIDC UID/client context, and bounded proof/confirmation state. AES-256-GCM uses the retained settings key and Google-specific authenticated context. A distinct HttpOnly, host-only, SameSite=Lax cookie per attempt is scoped to the Router-visible UserPersisto `/service/` prefix; Secure is mandatory on HTTPS and non-Secure is restricted to configured loopback HTTP. Never use Domain, readable storage or a `__Host-` name with a narrower path. State/handle is a selector, never proof. The deadline is at most five minutes and the parent's remaining lifetime; no restart/resume extends it.

| Internal route | Contract |
| --- | --- |
| `POST /service/auth/google/start` | Exact-origin JSON Explorer start; retains provider request ID separately from original Router state. Rejects caller-selected issuer, callback, role and account. |
| `POST /service/oidc/interaction/:uid/google` | Existing interaction cookie, Origin and CSRF checks; starts Google inside the existing popup. |
| `GET /service/auth/google/callback` | Handles explicitly before auth static fallback; validates state, browser proof, expiry and fingerprint, durably claims exchange once, then verifies Google outside persistence locks. |
| `GET /service/auth/google/resume/:handle` | Rechecks retained Explorer login request and proof before local resolution/completion. |
| `GET /service/oidc/interaction/:uid/google-resume?transaction=:handle` | Returns to original interaction cookie path, revalidates `interactionDetails`, original UID/client and proof before resolution. |
| Resume action POSTs | Authenticate/challenge/confirm-link/send-email-proof/verify-email-proof/cancel require exact Origin, transaction proof, purpose-bound CSRF and original parent; bodies do not choose a target or destination. |

Missing/wrong proof must not consume another browser's valid attempt. Duplicate critical parameters, simultaneous code/error, expired state, changed configuration and replay reject. Durable `pending` survives restart while proof/parent/deadline remain valid. A claimed `exchanging` transaction is nonretryable after ambiguous network or process failure; start fresh. Durable verified identity may resume without exchanging again. Consumed/failed/cancelled tombstones retain replay rejection through original expiry, erasing verifier/nonce/claims when no longer required; bounded ordinary reads/writes clean expiry without an idle timer.

Google verification resolves local identity under DS012's registration and collision rules before downstream success. The terminal transaction transition is prepared and validated before identity staging under one continuous persistence scope. Expiry while staging cannot poison otherwise valid storage; the complete identity may persist, but no handoff is issued. Google policy, configuration fingerprint and deadline are checked again in the same persistence scope as downstream completion, so a queued disable or rotation takes effect before a new result is issued. Passkey reauthentication retains the existing credential's RP ID and exact origin validation; linking cannot change either to bypass browser eligibility. WebAuthn requires a relying-party domain, so the IP-address preview cannot establish native passkey acceptance. Use a configured hostname with matching credentials and callback registrations; `localhost` is available for isolated browser tests. See the [WebAuthn RP ID requirements](https://www.w3.org/TR/webauthn-3/#rp-id).

OIDC resumes only through the original engine's `interactionFinished` using the local account and an accurate federated method marker. Current account and client checks and ordinary application consent remain mandatory; Google consent never grants ScriptaHub scopes. Explorer issues its existing SSO handoff with the retained provider request, then returns a validated relative `/auth/callback` preserving original Router core state. No Google handler sets a Ploinky session cookie. UserPersisto cannot inspect Router-only in-memory pending state: a Router restart may reject the later handoff after a complete local identity commit. Fresh login reuses that binding and no failed callback creates a Router session.

The Google auth wildcard retains guest transport admission; it does not gain an overlapping public-route override. Local redirects are fixed same-origin relative paths with the public Router prefix; Google authorization uses same-origin initiation fetch followed by explicit navigation to the verified HTTPS URL. The server-rendered OIDC Google button remains disabled until its submit handler is installed; an early click while the deferred script loads must not submit the JSON initiation endpoint as a native navigation. OIDC cookie paths stay unchanged. Callback/redirect responses use no-store, no-referrer, no third-party assets and no code/token logging. Google resume forms and ordinary interaction pages use `Referrer-Policy: same-origin` so native form POSTs retain the exact Origin required for CSRF checks. OIDC resume form CSP permits the retained, validated client callback origin through the authorization redirect chain; it cannot select an arbitrary destination. Framing remains denied.

### ScriptaHub popup completion and cancellation

Authentication and its action callers negotiate an explicit grant API version and action owner. An incompatible cached caller/provider pair cannot begin sign-in or publish a protected action; it shows reload guidance. Reader iframe delegation requires the same version from its parent, and current generated pages refresh shared script version queries when this contract changes.

The ScriptaHub original tab retains outer PKCE/state/nonce, exchanges UserPersisto's code, verifies tokens and reads current UserInfo. Its callback only relays the bounded URL through strict origin/source/state `postMessage` and a same-origin BroadcastChannel keyed by unpredictable state. Both transports validate exact callback origin/path and one state, deliver at most once and acknowledge delivery only. Missing or throwing BroadcastChannel retains strict opener transport; both transports unavailable yields retry guidance and no local success. Apparent `popup.closed` after COOP is advisory; no iframe or persistent localStorage relay is introduced.

Original-tab Cancel, an attempt generation and a monotonic whole-attempt deadline cover configuration, discovery, current-account validation, authorization, token exchange, UserInfo and delayed Continue. Cancellation settles promptly and invalidates local publication even if network work completes later. Every await, navigation, shared-state write and cleanup checks generation/ownership and remaining lifetime. Late old errors cannot clear a newer or unrelated valid session; stale finalizers cannot erase a retry's state/UI.

Sign-in produces a private verified candidate session. `requireAccount` returns a one-shot action grant whose synchronous publication rechecks current attempt, expiry, cancellation and token freshness, commits the candidate, consumes the grant and performs the exact retained action without an intervening await. The grant remains cancellable until publication; failure cannot authorize automatic replay. PDF destination, edition/language and modified-click Continue stay bound to the original action; stale click/auxclick cannot navigate. Feedback rechecks connected form, latest draft, validity and agreement immediately before its mail handoff. Anonymous reading and direct PDF URLs remain public. Cancel governs local ScriptaHub session/action publication, never rollback of remote Google/UserPersisto commits. Closing/reloading the original tab loses the pending action by design.

### Claims and token lifecycle

| Scope | Claims or effect |
| --- | --- |
| `openid` | OIDC subject identifier and ID token. `sub` is the durable UserPersisto user ID. |
| `profile` | `name` and `preferred_username` when available. |
| `email` | `email` and truthful `email_verified` state from the local profile, including accepted current Google-registration proof. It does not claim universal verification of historical accounts. |
| `roles` | Current persisted role IDs. |
| `capabilities` | Current effective persisted capabilities. |
| `offline_access` | Allows a refresh token only when the client also permits the refresh-token grant, the authorization request uses `prompt=consent`, and the user consents. |
| `api` | Generic API authorization scope, including confidential machine-client access. It does not confer an Explorer role or Ploinky access. |

ID tokens use RS256, identify the configured issuer and requesting client audience, and carry the request nonce when supplied. Signing keys are durable across restart; JWKS publishes only their public components. UserInfo returns only authorized scope claims and requires an active current user. Tokens and consent must never expose password hashes, TOTP secrets, private passkey material, client secrets, or private signing keys.

Access tokens are opaque bearer credentials, not JWTs. They expire after 300 seconds. ID tokens expire after 300 seconds, authorization codes after 60 seconds, browser interactions after 600 seconds, and provider browser sessions after four hours. Refresh tokens last up to one day per issued token and rotate on every successful use. Reusing an already consumed refresh token revokes its grant and the related tokens rather than issuing another branch of credentials. Grants have a 30-day lifetime. Consumption, expiration, and revocation survive restart; code and refresh-token races must not produce duplicate successful exchanges.

Blocking a user or disabling/deleting its client must prevent new credentials and invalidate activity checks. Claims are resolved from current persisted identity rather than trusted from stale caller input. Previously issued ID tokens remain independently verifiable until their expiration; applications that need current authorization must use current token activity/identity checks rather than treating old ID-token claims as permanent access decisions.

API consumers use authenticated introspection under the confidential client that obtained the opaque token. A client cannot inspect or revoke another client's token. This revision does not provide separate shared resource-server credentials, resource indicators, JWT API audiences, or a central API authorization policy. A public browser client's token is suitable for the provider's UserInfo endpoint; integrating it with a separate API requires an explicitly designed server-side validation boundary. Neither ID tokens nor OAuth access tokens bypass Ploinky's existing route/session checks.

RP-initiated logout clears the provider's browser session through the confirmation flow. Only registered post-logout redirect URIs are accepted. The relying application must separately clear its own session. The existing custom Ploinky SSO session is separate; logging out of an OIDC relying party does not claim to log out every Ploinky or third-party application.

### Durability and failure behavior

The protocol adapter encrypts stored payloads, client secrets, RS256 private signing material, and cookie keys using AES-256-GCM derived from the stable settings encryption key, with authenticated storage context. Persisto's snapshot makes writes durable. The adapter supports expiry, UID/user-code lookup where required by the engine, token consumption, and grant-wide revocation without relying on process memory. Consumed records remain available for replay detection until their expiry. Client enable/disable/update/delete and secret rotation must be visible without restarting the provider.

Expired records are removed when looked up and through a bounded sweep on ordinary writes: at most 100 deletions per write, at most once per minute when no backlog remains. Subsequent writes drain a backlog. Revoked-grant markers remain until their associated grant/artifact expiry so old tokens cannot become valid again. No background timer removes records while the provider is idle.

Storage errors fail closed and follow DS012's poisoned-store behavior; an unpersisted code, grant, key, or token must never be acknowledged as durable success. A mismatched or unavailable encryption key must fail instead of silently generating replacement material. Preserve both the encrypted snapshot and its key in backups. Multiple writers and HA failover remain unsupported.

### Setup and client examples

Complete the existing first-owner setup, retain the generated settings key, configure the issuer on the UserPersisto agent, and restart it. From an administrator session, open **Settings → Administration → Applications** and verify the displayed issuer/discovery URL. Register exact application callbacks and save any generated confidential secret in the application server's secret store.

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

### Verification contract and deliberate deferrals

Verification must exercise real protocol HTTP requests with a standards client or equivalent independent token verification, not only mocks of engine methods. Required cases include exact discovery/issuer URLs behind the Router, public JWKS with stable restart identity, authorization and nonce, S256 PKCE failures, exact redirect rejection, confidential client authentication, token and refresh replay, expiry, scope-filtered UserInfo, current blocked-user and disabled-client enforcement, cross-client introspection/revocation rejection, machine grants, consent denial, browser/CSRF binding, enabled-method policy, registration, logout, and persistence failure/restart behavior.

Administrator tests must reject untrusted invocation context and nonadministrators, validate malformed metadata, enforce public/confidential grant restrictions, prove secret-at-rest protection and one-time responses, and verify update/disable/delete/rotation take effect without provider restart. UI tests cover structured creation/editing, pages beyond 500 clients, deletion from the final page, failed saves preserving inputs, HTML escaping, secret clearing, and loss of authorization during a request. Browser verification covers real form interactions and visible error/success states. Router tests prove protocol requests work without a Ploinky session while adjacent routes remain protected.

Dynamic client registration, implicit/hybrid and password grants, device authorization, SAML, general upstream identity federation beyond the pinned Google client, advanced MFA enrollment, password recovery, general email verification, DPoP, PAR/JAR, resource indicators, automated signing-key rotation, multi-tenant realms, high availability, and OpenID conformance certification remain outside this revision. These are explicit scope boundaries, not undocumented assumptions about Keycloak equivalence.

### Standards references

The provider contract follows the authorization-code and identity concepts in [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html), PKCE in [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html), current security guidance in [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), and the logout flow in [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html). This implementation's narrower supported profile and verification evidence govern claims of compatibility.

## Conclusion

UserPersisto remains the issuer of local application identity and consent. Its optional Google client uses a separate, verified browser transaction before completing the original provider interaction; protocol, persistence and cancellation boundaries remain explicit.
