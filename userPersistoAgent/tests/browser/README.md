# Opt-in browser regressions

The runners use real Chromium with the real UserPersisto service, OIDC engine and sign-in wizard, but controlled identity inputs: codes come from a construction-time delivery capture, and an intercepted Google SDK submits signed test ID tokens through the production GIS verifier. They do not use a Ploinky workspace, a real Google account, real email delivery or a deployed origin, so a pass is never real-provider or deployment acceptance. Separate real-Google results are recorded in [the local GIS integration report](../../../docs/regression/google-gis-local-2026-09-14.md).

Run with a supported Node LTS release, the installed UserPersisto dependencies, `PLOINKY_AGENTLIB_DIR` pointing at the shared AgentLib, and an existing Playwright package and Chromium installation. No global install or download occurs. Set the absolute path to that package's `index.mjs` explicitly. An existing browser executable can be selected with `*_EXECUTABLE`; set `*_HEADED=true` for a visible browser. The runners are intentionally separate from `npm test`.

## Wizard flows

```sh
WIZARD_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/wizard-flows.mjs
```

`wizard-flows.mjs` drives the shared wizard on both renderers. An isolated fresh installation first proves administrator sign-in with the default `admin` password and an optional unverified contact email, rejection of an incorrect password, and returning sign-in to the same administrator. A separate email-first installation proves the first-run message, that requesting a code claims nothing, that a verified email signup claims the installation without activating the default administrator password, the Login/Register confirmation transitions, the method chooser with a wrong code followed by the right one, email-code sign-in resolving the existing installation administrator, and a Google denial returning to the live wizard. On the OIDC side the identity service runs on `localhost` and the application on `127.0.0.1`, a different site, and opens the authorization in a popup. It proves the `up_browser` proof is HttpOnly, SameSite=Strict and scoped to `/service/`, that the native `email-verify` POST carries it from the popup, that a wrong code re-renders the interaction with a visible error, and that administrator email-code sign-in still requires separate application consent. Screenshots are taken before any code or password is typed and are written to `.ploinky/test-artifacts/userpersisto-wizard/<run>/` (override with `WIZARD_BROWSER_ARTIFACT_DIR`).

## Google collision linking

```sh
GOOGLE_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/google-resume.mjs
```

`google-resume.mjs` first signs the installation owner in to a separate local relying party through the OIDC wizard with an email code, then holds the wizard module and verifies that no Google control exists before it loads. It completes controlled Google authorization into the collision page, proves the existing account with the selected method, and verifies that proof alone creates no binding before **Link Google and continue**. It also verifies the browser-generated POST Origin, the cross-origin callback redirect chain, independent downstream PKCE/state/nonce/signature verification, unchanged local subject and roles, and exactly one binding.

Set `GOOGLE_BROWSER_LINK_METHOD` to `emailCode` (default: a link code sent to the verified mailbox), `totp` (a random fixture secret enrolled through the staged setup functions) or `passkey` (a random P-256 credential loaded into Chromium's CDP virtual authenticator with user verification; the production script performs `navigator.credentials.get` and the runner checks the assertion event and server-side counter advancement). No hardware, real user credential or mocked authentication result is used.

Passkey fixtures default to `localhost`; the other methods default to `127.0.0.1`. `GOOGLE_BROWSER_HOST` explicitly selects either value and consistently configures the issuer, callback, cookie host and virtual credential. Chromium rejects WebAuthn on the numeric `127.0.0.1` origin with a relying-party domain `SecurityError`; `GOOGLE_BROWSER_LINK_METHOD=passkey GOOGLE_BROWSER_HOST=127.0.0.1` reproduces that known failing boundary and checks that no binding or Google application login results. Passing localhost fixtures do not establish passkey support for a deployed numeric-IP route.

Set `GOOGLE_BROWSER_HTTPS=true` to run the same roundtrip behind an ephemeral local HTTPS reverse proxy. This mode requires an existing OpenSSL executable (`GOOGLE_BROWSER_OPENSSL` can select its absolute path), creates a one-day self-signed certificate with a loopback IP subject alternative name, and enables certificate-error bypass only in the disposable Chromium context. The Node relying party trusts that certificate only for the exact fixture origin. Both modes verify the host-only, HttpOnly, SameSite=Lax service-path Google proof cookie and its removal; HTTPS additionally requires `Secure` and the `__Secure-` name prefix. No production TLS configuration is relaxed.

## Google-only account enrollment

```sh
GOOGLE_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/google-enrollment.mjs
```

`google-enrollment.mjs` signs in through the real Google SSO callback, derives the fixture Router session from the consumed handoff, and signs My Account requests with that authenticated identity. With email disabled and no delivery provider, it confirms the linked Google Account in an isolated provider popup, requires a signed recent `auth_time`, and enrolls both an authenticator and a Chromium virtual passkey with user verification. The account selector itself is not fresh credential proof. A real Google response without a recent authentication time fails closed and asks the user to sign in to their Google Account again. The runner uses `GOOGLE_BROWSER_EXECUTABLE` when supplied; screenshots after completed operations contain no setup keys or grants and are written to `.ploinky/test-artifacts/google-enrollment/<run>/` (override with `GOOGLE_ENROLLMENT_ARTIFACT_DIR`).

All fixtures choose dynamic loopback ports, create temporary persistence, use test identities, and close their browsers and servers and remove persistence in `finally`, including after failed checks. Output contains only the browser version and check result, apart from existing service initialization diagnostics, and never codes, cookies or tokens. Router deployment, Google Console acceptance, real mail delivery, physical passkeys, Firefox and Safari remain separate acceptance checks.
