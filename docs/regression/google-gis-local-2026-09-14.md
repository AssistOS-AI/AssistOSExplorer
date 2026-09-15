# Local Google Identity Services verification — 14 September 2026

The `user-persisto-v2` working tree implements Google Identity Services ID-token sign-in with a public client ID. No Google client secret is read, distributed or required. The base revision was `c750f2b5`; the checks exercised uncommitted changes, including the pre-existing wizard changes. This is integration evidence, not a release or full Ploinky Box deployment acceptance report.

Google Cloud project `ploinky-sso` contains Web client `709999050125-42jmthte7dsv6822o2u8bt20m1ntv7p0.apps.googleusercontent.com`. Its saved JavaScript origins are `http://localhost`, `http://localhost:8080`, `http://127.0.0.1` and `http://127.0.0.1:8080`. GIS requests its standard `openid email profile` identity scopes; the backend retains only the verified identity fields needed for local authentication. No Google API or offline-access scopes are requested.

## Full UserPersisto suite

**Command run:**

```sh
PLOINKY_AGENTLIB_DIR=/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib \
  /Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test userPersistoAgent/tests/*.test.mjs
```

**Output observed:**

```text
ℹ tests 470
ℹ pass 470
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**Result: PASS**

Node.js was 24.19.0. The suite covers the new GIS protocol, browser module and real HTTP handlers alongside existing UserPersisto accounts, policies, persistence, OIDC and authorization behavior. Detailed local output was retained at `/tmp/ploinky-gis-full-suite.log`.

## Numeric loopback and URL restrictions

After adding explicit shared-client support for `127.0.0.1:8080`, the focused protocol suite was rerun. Other ports, public hosts, malformed URLs, protocol-relative service paths, wrong signatures, issuers, audiences, nonces, token algorithms and freshness claims remain rejected.

**Command run:**

```sh
/Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test userPersistoAgent/tests/google-gis-protocol.test.mjs
```

**Output observed:**

```text
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

**Result: PASS**

## Additional adversarial review

The independent review ran the six new GIS HTTP cases and 48 existing Google HTTP/storage cases. Additional temporary HTTP probes exercised parent deletion, client-ID changes and expiry while JWKS verification was held, duplicate browser cookies, malformed transaction handles, duplicate/unknown page selectors and safe JSON return-path encoding. Rejected foreign requests did not consume a valid browser's attempt; concurrent valid submissions verified once; cancellation prevented late verification from completing.

**Commands run:**

```text
node --test userPersistoAgent/tests/google-gis-http.test.mjs
node --test userPersistoAgent/tests/google-http.test.mjs userPersistoAgent/tests/google-storage.test.mjs
```

The commands used the same Node 24 executable and AgentLib environment as the full suite.

**Output observed:**

```text
ℹ tests 6
ℹ pass 6
ℹ fail 0
ℹ tests 48
ℹ pass 48
ℹ fail 0
```

**Result: PASS**

Temporary probe logs were `/tmp/google-gis-review-probes.log` and `/tmp/google-gis-review-json.log`. No verifier changed project files.

## Controlled browser regressions

The existing `tests/browser/google-enrollment.mjs`, `google-resume.mjs` and `wizard-flows.mjs` ran against Chromium 148.0.7778.96. These fixtures substitute the official SDK response with a controlled test SDK but submit genuinely signed test JWTs through the production verifier and HTTP endpoints. They verify Google-first setup, existing-account linking, downstream OIDC consent/PKCE, unchanged roles, cancellation, signed dashboard access and fresh Google confirmation for TOTP/passkey enrollment. They do not by themselves establish Google Cloud acceptance.

**Commands run:** from `userPersistoAgent/`, with the following environment on each command:

```sh
PLOINKY_AGENTLIB_DIR=/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib
GOOGLE_BROWSER_EXECUTABLE='/Users/danielsava/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
WIZARD_BROWSER_EXECUTABLE='/Users/danielsava/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
GOOGLE_BROWSER_PLAYWRIGHT_MODULE=/Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs
```

```sh
/Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/browser/google-enrollment.mjs
/Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/browser/google-resume.mjs
/Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/browser/wizard-flows.mjs
```

**Output observed:** relevant excerpts:

```text
PASS Chromium 148.0.7778.96: controlled signed GIS credential, Google-only real SSO handoff, signed My Account requests, isolated Google popup, TOTP and passkey enrollment without mail
PASS Chromium 148.0.7778.96 HTTP 127.0.0.1 emailCode: passwordless wizard sign-in, no Google control before the wizard loads, native form Origin, explicit linking, consented callback CSP, local subject and roles, scoped host-only proof cookie.
PASS Chromium 148.0.7778.96: SSO first-run email signup, four transitions, canceled delayed verification, administrator email-code sign-in, controlled GIS cancellation notice
```

**Result: PASS**

## Real Google account checks

**Commands run:**

```sh
PLOINKY_AGENTLIB_DIR=/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib \
  /Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /tmp/ploinky-gis-live-check.mjs

GOOGLE_GIS_CHECK_ORIGIN=http://127.0.0.1:8080 \
  PLOINKY_AGENTLIB_DIR=/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib \
  /Users/danielsava/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /tmp/ploinky-gis-live-check.mjs
```

The temporary fixture started the production UserPersisto service with a fresh store and random installation encryption key, exposed only a loopback HTTP proxy preserving the normal Router-visible service prefix, and consumed the resulting SSO handoff. It used the production Google JWKS resolver and official GIS SDK, with no provider override or Google secret. The first run used untouched local Google defaults; the second explicitly selected the shared public client at the numeric loopback origin.

Using Chrome 152.0.7977.83, both runs opened the actual Google account chooser, authenticated the operator-authorized Google account and finished at a clean `/verified` page. Google consent was presented on the first run. The observed result was:

```json
{"realGoogleSignIn":true,"roles":["admin"],"googleBindings":1,"configurationSource":"local-default","googleSecretRequired":false}
{"realGoogleSignIn":true,"roles":["admin"],"googleBindings":1,"configurationSource":"environment","googleSecretRequired":false}
```

**Result: PASS**

Browser screenshots and accessibility observations confirmed the rendered Google button and the final “Google sign-in verified” page. The logs contain no Google tokens, authorization codes, cookies or private encryption keys. Both temporary servers and stores were removed after the checks; no existing deployment was changed.

## Limits

The real checks establish first-user Google sign-in and the existing UserPersisto SSO handoff on both registered loopback origins. They do not establish a full Box deployment, public HTTPS deployment, real Google reauthentication freshness, Firefox/Safari behavior or acceptance under every Google Workspace policy. Account-enrollment freshness was exercised with signed controlled claims and remains fail-closed when real Google omits a recent authentication time. These checks preceded source publication.

## Commit candidate verification

The publication candidate excludes the pre-existing email-code UI edits in `public/auth/wizard.js` and `tests/auth-ui.test.mjs`. A separate checkout of the staged tree was tested with the installed, pinned Persisto dependency and existing Ploinky runtime. This makes the candidate's count 468 rather than the earlier working tree's 470.

**Command run:** with Node 24.19.0 first on PATH, from the staged-tree checkout:

```sh
PLOINKY_AGENT_RUNTIME_ROOT=/Users/danielsava/work/file-parser/ploinky/Agent \
  PLOINKY_AGENTLIB_DIR=/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib \
  node --test userPersistoAgent/tests/*.test.mjs
```

**Output observed:**

```text
ℹ tests 468
ℹ pass 468
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**Result: PASS**

VERDICT: PASS
