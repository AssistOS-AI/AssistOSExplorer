# Encoded User API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and accept admin-created Soul Gateway user API keys as `sk-soul-<base64url(raw signed-subject key)>`, while rejecting raw user signed-subject bearer tokens.

**Architecture:** Ploinky remains the only signer. It still signs `user:<owner>:<name>` with Ed25519, but the router user-key endpoint wraps the raw signed-subject key before returning it. Soul Gateway unwraps only `sk-soul-...` user keys before running the existing signature verifier; raw agent keys remain accepted and raw user keys become invalid.

**Tech Stack:** Node.js ES modules, `node:test`, SQLite-backed Soul Gateway unit harness, Ploinky router unit tests, browser dashboard served through Ploinky.

---

## File Structure

`/Users/danielsava/work/file-parser/ploinky/cli/services/userIdentityKey.js`
: Owns router user-key result creation. Add the public `sk-soul-` wrapper at the user-key mint boundary.

`/Users/danielsava/work/file-parser/ploinky/tests/unit/userIdentityKey.test.mjs`
: Proves Ploinky returns encoded user-facing API keys, keeps admin/non-admin target rules, and that the encoded payload verifies after decoding.

`/Users/danielsava/work/file-parser/proxies/soul-gateway/src/test/fixtures/signed-subject-key.mjs`
: Test-only helper for wrapping raw signed-subject keys as `sk-soul-...`.

`/Users/danielsava/work/file-parser/proxies/soul-gateway/src/test/unit/embedded-auth.test.mjs`
: Proves Soul Gateway accepts encoded user keys, rejects raw user keys, rejects malformed encoded keys, rejects encoded agent subjects, and keeps raw agent keys working.

`/Users/danielsava/work/file-parser/proxies/soul-gateway/src/runtime/security/api-key-auth.mjs`
: Add inbound token parsing that unwraps `sk-soul-...` user keys and rejects raw user signed-subject tokens.

`/Users/danielsava/work/file-parser/proxies/soul-gateway/docs/specs/DS002-provider-auth.md`
`/Users/danielsava/work/file-parser/proxies/soul-gateway/docs/specs/DS007-rate-limiting-budgets.md`
`/Users/danielsava/work/file-parser/proxies/soul-gateway/docs/specs/DS012-api-reference.md`
`/Users/danielsava/work/file-parser/proxies/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md`
: Update current behavior docs to describe encoded user keys and raw agent keys.

## Execution Setup

- [ ] **Step 1: Create isolated worktrees for both repos**

```bash
git -C /Users/danielsava/work/file-parser/proxies worktree add /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys -b fix/encoded-user-api-keys
git -C /Users/danielsava/work/file-parser/ploinky worktree add /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys -b fix/encoded-user-api-keys
```

Expected: two worktrees created on `fix/encoded-user-api-keys`. If `.worktrees` is not ignored in either repo, stop and add the ignore entry in that repo before creating the worktree.

- [ ] **Step 2: Record baseline targeted tests**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
node --test tests/unit/userIdentityKey.test.mjs

cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/embedded-auth.test.mjs src/test/unit/dashboard-keys-page.test.mjs
```

Expected: both commands pass before changing tests. If a baseline fails, capture the output and decide whether to fix the baseline before starting the red/green cycle.

## Task 1: Ploinky Red Tests For Encoded User Keys

**Files:**

- Modify: `/Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys/tests/unit/userIdentityKey.test.mjs`

- [ ] **Step 1: Add a test helper that decodes the public key wrapper**

Add this helper after `invoke()` and before `loadModules()`:

```js
function decodePublicUserApiKey(apiKey) {
    assert.equal(typeof apiKey, 'string');
    assert.ok(apiKey.startsWith('sk-soul-'), `expected public key prefix, got ${apiKey}`);
    assert.equal(apiKey.includes('user:'), false, 'public key must not expose a user subject');
    assert.equal(apiKey.startsWith('sk-soul-v1'), false, 'public key prefix must not expose a version marker');
    const payload = apiKey.slice('sk-soul-'.length);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
    return Buffer.from(payload, 'base64url').toString('utf8');
}
```

- [ ] **Step 2: Replace raw-key assertions in route tests with encoded-key assertions**

In `authenticated user receives user:<id>|<signature> that verifies, with the public key`, change the test name and assertion body to:

```js
test('authenticated user receives sk-soul encoded key that verifies after decoding', async (t) => {
    const { route, primitive } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        user: { id: '123', username: 'alice', roles: ['user'] },
    });

    assert.equal(result.handled, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subjectId, 'user:123');
    assert.equal(typeof result.body.publicKey, 'string');
    assert.ok(result.body.publicKey.length > 0);
    assert.equal(result.body.publicKey, primitive.getSubjectIdentityPublicKey());

    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:123|'), `decoded key should start with user:123| (got ${rawApiKey})`);
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
});
```

In `a body userId is ignored for a non-admin (no horizontal privilege escalation)`, replace the raw-key assertions with:

```js
    assert.equal(result.body.subjectId, 'user:123');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:123|'));
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
```

In `an admin CAN mint a key for another userId via the body`, replace the raw-key assertions with:

```js
    assert.equal(result.body.subjectId, 'user:999');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:999|'));
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:999', subjectType: 'user' },
    );
```

In `an admin with no body userId mints their own key`, replace the final assertion with:

```js
    assert.equal(result.body.subjectId, 'user:local:admin');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:local:admin|'));
```

In `an admin supplying an empty-string userId falls back to their own key (not a 400)`, replace the final assertion with:

```js
    assert.equal(result.body.subjectId, 'user:local:admin');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:local:admin|'));
```

In `the pure buildUserApiKeyResult enforces the privilege model directly`, replace both direct `verifySubjectIdentityKey(...apiKey...)` assertions with decoded raw values:

```js
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(decodePublicUserApiKey(nonAdmin.apiKey), nonAdmin.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(decodePublicUserApiKey(admin.apiKey), admin.publicKey),
        { subjectId: 'user:999', subjectType: 'user' },
    );
```

- [ ] **Step 3: Run the Ploinky test to verify RED**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
node --test tests/unit/userIdentityKey.test.mjs
```

Expected: FAIL because `result.body.apiKey` currently starts with `user:` instead of `sk-soul-`.

## Task 2: Ploinky Encoded Mint Implementation

**Files:**

- Modify: `/Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys/cli/services/userIdentityKey.js`
- Test: `/Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys/tests/unit/userIdentityKey.test.mjs`

- [ ] **Step 1: Add the public wrapper helper**

In `cli/services/userIdentityKey.js`, add this constant and helper after the imports:

```js
const PUBLIC_USER_API_KEY_PREFIX = 'sk-soul-';

function encodePublicUserApiKey(rawApiKey) {
    return `${PUBLIC_USER_API_KEY_PREFIX}${Buffer.from(rawApiKey, 'utf8').toString('base64url')}`;
}
```

- [ ] **Step 2: Return the encoded key from `buildUserApiKeyResult()`**

Replace:

```js
    const apiKey = buildSubjectIdentityKey(subjectId);
    const publicKey = getSubjectIdentityPublicKey();
    return { subjectId, apiKey, publicKey };
```

with:

```js
    const rawApiKey = buildSubjectIdentityKey(subjectId);
    const apiKey = encodePublicUserApiKey(rawApiKey);
    const publicKey = getSubjectIdentityPublicKey();
    return { subjectId, apiKey, publicKey };
```

- [ ] **Step 3: Run the targeted Ploinky test to verify GREEN**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
node --test tests/unit/userIdentityKey.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit Ploinky changes**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
git add cli/services/userIdentityKey.js tests/unit/userIdentityKey.test.mjs
git commit -m "feat: encode user api keys"
```

## Task 3: Soul Gateway Red Tests For Encoded User Auth

**Files:**

- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/src/test/fixtures/signed-subject-key.mjs`
- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/src/test/unit/embedded-auth.test.mjs`

- [ ] **Step 1: Add encoded user-key test helpers**

In `src/test/fixtures/signed-subject-key.mjs`, add this constant and helper before `makeSignedSubjectKey()`:

```js
export const ENCODED_USER_API_KEY_PREFIX = 'sk-soul-';

export function encodeUserApiKey(rawApiKey) {
    return `${ENCODED_USER_API_KEY_PREFIX}${Buffer.from(rawApiKey, 'utf8').toString('base64url')}`;
}
```

Then add this helper after `makeSignedSubjectKey()`:

```js
export function makeEncodedUserKey(subjectId) {
    const signed = makeSignedSubjectKey(subjectId);
    return {
        ...signed,
        rawApiKey: signed.apiKey,
        apiKey: encodeUserApiKey(signed.apiKey),
    };
}
```

- [ ] **Step 2: Import the new helpers**

In `src/test/unit/embedded-auth.test.mjs`, change:

```js
import {
    makeSignedSubjectKey,
    makeSignedSubjectSigner,
} from '../fixtures/signed-subject-key.mjs';
```

to:

```js
import {
    encodeUserApiKey,
    makeEncodedUserKey,
    makeSignedSubjectKey,
    makeSignedSubjectSigner,
} from '../fixtures/signed-subject-key.mjs';
```

- [ ] **Step 3: Change existing user-auth success paths to encoded keys**

In `authenticates a valid user key and creates a DB row`, replace:

```js
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
```

with:

```js
            const { apiKey, publicKeyBase64url } = makeEncodedUserKey(subjectId);
```

In `denies a revoked signed key and does not reactivate it`, replace:

```js
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
```

with:

```js
            const { apiKey, publicKeyBase64url } = makeEncodedUserKey(subjectId);
```

In `fails signed-subject auth when the public key is missing`, replace:

```js
            const { apiKey } = makeSignedSubjectKey(subjectId);
```

with:

```js
            const { apiKey } = makeEncodedUserKey(subjectId);
```

- [ ] **Step 4: Add breaking-change and malformed-token tests**

Add these tests near the other signed-subject API key tests, before `does not require ciphertext columns to insert a row`:

```js
    it('rejects raw user signed-subject bearer tokens', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'user:alice';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );

            const stored = await db.query(
                'SELECT id FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 0);
        });
    });

    it('rejects encoded keys whose decoded payload is an agent subject', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/llmAssistant';
            const { apiKey: rawAgentKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const encodedAgentKey = encodeUserApiKey(rawAgentKey);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${encodedAgentKey}`, appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );

            const stored = await db.query(
                'SELECT id FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 0);
        });
    });

    it('rejects malformed encoded user API keys', async () => {
        await withSignedDb(async (db) => {
            const { publicKeyBase64url } = makeSignedSubjectKey('user:ignored');
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };
            const badKeys = [
                'sk-soul-',
                'sk-soul-not+base64url',
                `sk-soul-${Buffer.from('not-a-signed-key', 'utf8').toString('base64url')}`,
                `sk-soul-${Buffer.from('user:alice|', 'utf8').toString('base64url')}`,
            ];

            for (const badKey of badKeys) {
                await assert.rejects(
                    () => authenticateApiKey(`Bearer ${badKey}`, appCtx),
                    (err) => err.errorType === 'invalid_api_key',
                    `expected invalid API key for ${badKey}`
                );
            }
        });
    });
```

- [ ] **Step 5: Run the Soul Gateway auth test to verify RED**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/embedded-auth.test.mjs
```

Expected: FAIL because encoded `sk-soul-...` keys are not decoded yet and raw user keys are still accepted.

## Task 4: Soul Gateway Encoded User-Key Verifier

**Files:**

- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/src/runtime/security/api-key-auth.mjs`
- Test: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/src/test/unit/embedded-auth.test.mjs`

- [ ] **Step 1: Add encoded user-key constants**

In `src/runtime/security/api-key-auth.mjs`, add these constants after `ED25519_PUBLIC_KEY_BYTES`:

```js
const ENCODED_USER_API_KEY_PREFIX = 'sk-soul-';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
```

- [ ] **Step 2: Parse inbound tokens before signature verification**

In `authenticateApiKey()`, replace:

```js
    // 3. Parse <subjectId>|<signature>.
    const { subjectId, signature } = parseSignedSubjectApiKey(token);

    // 4. Classify the subject BEFORE doing signature math.
    const subjectType = classifySubjectType(subjectId);
```

with:

```js
    // 3. Parse the inbound public token. User keys must be encoded as
    //    sk-soul-<base64url(raw signed-subject key)>; agent keys remain raw.
    const { subjectId, signature, subjectType } = parseInboundApiKeyToken(token);
```

- [ ] **Step 3: Add encoded/raw token parsing helpers**

Add these helpers above `parseSignedSubjectApiKey()`:

```js
/**
 * Parse the inbound public bearer token.
 *
 * User keys are public wrappers: sk-soul-<base64url(user:<id>|<sig>)>.
 * Agent keys keep the raw signed-subject format because they are injected into
 * agent runtime env by Ploinky.
 *
 * @param {string} token
 * @returns {{ subjectId: string, signature: string, subjectType: 'agent'|'user' }}
 * @throws {InvalidApiKeyError}
 */
export function parseInboundApiKeyToken(token) {
    if (String(token || '').startsWith(ENCODED_USER_API_KEY_PREFIX)) {
        const decoded = decodeEncodedUserApiKey(token);
        const parsed = parseSignedSubjectApiKey(decoded);
        const subjectType = classifySubjectType(parsed.subjectId);
        if (subjectType !== 'user') {
            throw new InvalidApiKeyError(
                'Encoded API keys must contain a user signed-subject key'
            );
        }
        return { ...parsed, subjectType };
    }

    const parsed = parseSignedSubjectApiKey(token);
    const subjectType = classifySubjectType(parsed.subjectId);
    if (subjectType === 'user') {
        throw new InvalidApiKeyError(
            'Raw user signed-subject API keys are not accepted'
        );
    }
    return { ...parsed, subjectType };
}

export function decodeEncodedUserApiKey(token) {
    const payload = String(token || '').slice(ENCODED_USER_API_KEY_PREFIX.length);
    if (!payload || !BASE64URL_RE.test(payload)) {
        throw new InvalidApiKeyError('Encoded user API key payload is malformed');
    }
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== payload) {
        throw new InvalidApiKeyError('Encoded user API key payload is malformed');
    }
    return decoded.toString('utf8');
}
```

- [ ] **Step 4: Run the Soul Gateway auth test to verify GREEN**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/embedded-auth.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Soul Gateway verifier changes**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys
git add soul-gateway/src/runtime/security/api-key-auth.mjs soul-gateway/src/test/fixtures/signed-subject-key.mjs soul-gateway/src/test/unit/embedded-auth.test.mjs
git commit -m "feat: require encoded user api keys"
```

## Task 5: Dashboard Key-Reveal Regression Test

**Files:**

- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/src/test/unit/dashboard-keys-page.test.mjs`

- [ ] **Step 1: Write a dashboard unit test for the revealed key shape**

Append this test inside `describe('dashboard keys page', () => { ... })`:

```js
    it('reveals the encoded router key without decoding it in the dashboard', async () => {
        const encodedKey = `sk-soul-${Buffer.from('user:alice:laptop|sig', 'utf8').toString('base64url')}`;
        const source = await readFile(
            new URL('../../dashboard/js/app.mjs', import.meta.url),
            'utf8'
        );
        const calls = [];
        const window = {
            location: { hash: '#keys', protocol: 'http:', host: 'localhost:7000' },
            addEventListener() {},
            dispatchEvent() {},
            open() {},
        };
        const context = {
            window,
            location: window.location,
            sessionStorage: {
                getItem() {
                    return null;
                },
                setItem() {},
                removeItem() {},
            },
            fetch: async (url, options = {}) => {
                calls.push({ url: String(url), options });
                if (String(url).endsWith('/management/keys')) {
                    return {
                        status: 200,
                        redirected: false,
                        async json() {
                            if (options.method === 'POST') {
                                return { key: { id: 'key-1', subject_id: 'user:alice:laptop' } };
                            }
                            return { data: [] };
                        },
                    };
                }
                if (String(url) === '/api/router/identity/user-api-key') {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { apiKey: encodedKey };
                        },
                    };
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            URLSearchParams,
            CustomEvent: class CustomEvent {
                constructor(type, init = {}) {
                    this.type = type;
                    this.detail = init.detail;
                }
            },
            renderMarkdown(value) {
                return String(value ?? '');
            },
            console,
        };
        context.globalThis = context;
        window.window = window;

        vm.runInNewContext(source, context, {
            filename: 'src/dashboard/js/app.mjs',
        });

        const page = window.keysPage();
        page.createKeyForm.owner = 'alice';
        page.createKeyForm.name = 'laptop';

        await page.submitCreateKey();

        assert.equal(page.newUserKey, encodedKey);
        assert.equal(page.newUserKey.startsWith('sk-soul-'), true);
        assert.equal(page.newUserKey.includes('user:'), false);
        assert.equal(page.newUserKey.startsWith('sk-soul-v1'), false);
        assert.equal(page.createKeyError, '');
        assert.equal(calls.some((call) => String(call.url) === '/api/router/identity/user-api-key'), true);
    });
```

- [ ] **Step 2: Run the dashboard keys test**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/dashboard-keys-page.test.mjs
```

Expected: PASS. This is a regression guard for existing dashboard pass-through behavior; no production dashboard change is expected.

- [ ] **Step 3: Commit the dashboard regression test**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys
git add soul-gateway/src/test/unit/dashboard-keys-page.test.mjs
git commit -m "test: cover encoded user key reveal"
```

## Task 6: Current Behavior Docs

**Files:**

- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/docs/specs/DS002-provider-auth.md`
- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/docs/specs/DS007-rate-limiting-budgets.md`
- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/docs/specs/DS012-api-reference.md`
- Modify: `/Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md`

- [ ] **Step 1: Update DS002 inbound API key authentication**

Replace the opening paragraphs under `## Inbound API key authentication` with:

```markdown
Soul Gateway authenticates incoming API calls using Ploinky-issued signed-subject identity. Agent runtime keys are raw signed-subject tokens with the format `<subjectId>|<base64url-ed25519-signature>`, where the signature is over the exact UTF-8 bytes of `subjectId`. User-facing keys are encoded public wrappers with the format `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>`. Soul Gateway decodes the wrapper, then verifies the inner signed-subject value with the Ed25519 public key in `PLOINKY_AGENT_API_PUBLIC_KEY`; Ploinky holds the corresponding private key and signs.

**Agent key format:** `<subjectId>|<base64url-ed25519-signature>`

**User key format:** `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>`

Raw user signed-subject bearer tokens are rejected. User keys must use the `sk-soul-` wrapper so the copied key does not expose the user/admin subject text. Agent keys remain raw because they are runtime-injected into Ploinky-managed agents rather than shown to dashboard users.
```

Add a new decision in DS002:

```markdown
2. 2026-06-27: Admin-created user API keys are exposed and accepted only as `sk-soul-<base64url(raw signed-subject key)>`; raw `user:<id>|<signature>` bearer tokens are rejected. Agent runtime keys remain raw signed-subject values.
```

- [ ] **Step 2: Update DS007 API key lifecycle**

In `## API key lifecycle`, replace:

```markdown
All inbound API keys are Ploinky router-signed signed-subject values. The gateway stores only the `api_keys` policy row: subject id, subject type, `source='signed-subject'`, limits, budgets, expiry, status, and metadata. It does not store raw keys, encrypted keys, or secret hashes.

Admins can provision user keys through `POST /management/keys`. The endpoint records a policy row for a router-signed `user:<owner>:<name>` subject with `subject_type='user'` and `source='signed-subject'`; the router mints the bearer key, and the gateway only enforces the stored policy when that signed subject is presented. User-key revocation sets the row to `status='revoked'` and blocks that deterministic subject. A revoked user `subject_id` cannot be reused, so per-user-key rotation is revoke plus a new name.
```

with:

```markdown
All inbound API keys are backed by Ploinky router-signed subjects. Agent runtime keys are raw signed-subject values. User-facing keys are encoded as `sk-soul-<base64url(raw signed-subject key)>` before they are shown or accepted. The gateway stores only the `api_keys` policy row: subject id, subject type, `source='signed-subject'`, limits, budgets, expiry, status, and metadata. It does not store raw keys, encrypted keys, or secret hashes.

Admins can provision user keys through `POST /management/keys`. The endpoint records a policy row for a router-signed `user:<owner>:<name>` subject with `subject_type='user'` and `source='signed-subject'`; the router mints the encoded `sk-soul-...` bearer key, and the gateway decodes that public key before enforcing the stored policy. Raw `user:<owner>:<name>|<signature>` bearer tokens are rejected. User-key revocation sets the row to `status='revoked'` and blocks that deterministic subject. A revoked user `subject_id` cannot be reused, so per-user-key rotation is revoke plus a new name.
```

Add a new decision:

```markdown
2. 2026-06-27: User-facing API keys use the encoded `sk-soul-...` public wrapper. Soul Gateway rejects raw user signed-subject bearer tokens while continuing to accept raw agent runtime keys.
```

- [ ] **Step 3: Update DS012 management API key description**

Replace the API key management bullet under `## Other management surfaces` with:

```markdown
- API key management — admins can provision user keys with `POST /management/keys`. The endpoint creates a policy row for a router-signed `user:<owner>:<name>` subject with `subject_type='user'` and `source='signed-subject'`; the router mints the copied bearer value as `sk-soul-<base64url(user:<owner>:<name>|<signature>)>`, and Soul Gateway stores no raw key material. Agent keys remain discovery-provisioned, cannot be provisioned through this endpoint, and are non-revocable through key management. User keys are revocable; a revoked user subject id cannot be reused, so rotation requires a new key name. The `status` field on each key row reflects `active` or `revoked`.
```

Add a new decision:

```markdown
2. 2026-06-27: The dashboard reveals admin-created user keys only in the encoded `sk-soul-...` form returned by Ploinky. The gateway decodes that wrapper for verification and rejects raw user signed-subject bearer tokens.
```

- [ ] **Step 4: Update DS016 Ploinky agent mode**

Replace the first paragraph under `## Signed-Subject API Key Authentication` with:

```markdown
Soul Gateway verifies incoming bearer tokens as Ploinky-signed subject identity. Agent runtime keys are raw signed-subject values with the format `<subjectId>|<base64url-ed25519-signature>`, where the signature is over the exact UTF-8 bytes of `subjectId`. User-facing API keys are encoded public wrappers with the format `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>`. Soul Gateway decodes user wrappers before verifying the inner signature with `PLOINKY_AGENT_API_PUBLIC_KEY`; Ploinky signs with its Ed25519 private key, which never enters Soul Gateway or agent processes. Raw user signed-subject bearer tokens are rejected.
```

Replace the `PLOINKY_AGENT_API_KEY` table value with:

```markdown
| `PLOINKY_AGENT_API_KEY` | The agent's raw signed-subject key: `<subjectId>|<base64url-sig>` |
```

Replace the admin-provisioned user key paragraph with:

```markdown
**Admin-provisioned user keys:** Administrators can provision user keys from the protected management dashboard. The gateway endpoint `POST /management/keys` records a policy row for a router-signed `user:<owner>:<name>` subject with `subject_type='user'` and `source='signed-subject'`; Ploinky's router identity endpoint mints the copied bearer value as `sk-soul-<base64url(user:<owner>:<name>|<signature>)>`, and the gateway stores no key material. User keys are revocable. A revoked user subject id is burned, so rotation is revoke plus a different name. Agent keys are unchanged: they are discovered from Ploinky agent registration, are not provisioned by this endpoint, remain raw runtime-injected signed-subject values, and remain non-revocable in key management.
```

Add a new decision:

```markdown
3. 2026-06-27: Admin-created user keys are copied and accepted only as encoded `sk-soul-...` public tokens. The encoded payload contains the existing signed-subject key, but the visible key no longer exposes `user:<owner>:<name>` or a version marker. Raw user signed-subject bearer tokens are rejected.
```

- [ ] **Step 5: Commit docs**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys
git add soul-gateway/docs/specs/DS002-provider-auth.md soul-gateway/docs/specs/DS007-rate-limiting-budgets.md soul-gateway/docs/specs/DS012-api-reference.md soul-gateway/docs/specs/DS016-ploinky-agent-mode.md
git commit -m "docs: document encoded user api keys"
```

## Task 7: Final Verification And Local E2E

**Files:**

- Verify only; no planned source edits.

- [ ] **Step 1: Run targeted Ploinky tests**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
node --test tests/unit/userIdentityKey.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run targeted Soul Gateway tests**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/embedded-auth.test.mjs src/test/unit/dashboard-keys-page.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run full Soul Gateway unit tests**

```bash
cd /Users/danielsava/work/file-parser/proxies/.worktrees/encoded-user-api-keys/soul-gateway
npm run test:unit
```

Expected: PASS.

- [ ] **Step 4: Run Ploinky unit suite**

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/encoded-user-api-keys
npm test
```

Expected: PASS, or document any pre-existing unrelated failure with the exact failing test names and logs.

- [ ] **Step 5: Merge both worktrees back to their main branches**

After review approves both repos:

```bash
cd /Users/danielsava/work/file-parser/ploinky
git merge --ff-only fix/encoded-user-api-keys

cd /Users/danielsava/work/file-parser/proxies
git merge --ff-only fix/encoded-user-api-keys
```

Expected: both merges fast-forward.

- [ ] **Step 6: Redeploy fresh local Explorer**

```bash
cd /Users/danielsava/work/testExplorerFresh
ploinky destroy
rm -rf .ploinky
ploinky start explorer
```

Expected: Explorer starts at `http://127.0.0.1:8080/dashboard`.

- [ ] **Step 7: Browser E2E through the dashboard**

Using Chrome integration, log in with `admin` / `admin`, open:

```text
http://127.0.0.1:8080/services/soul-gateway/management/#keys
```

Create a user key with:

```text
Owner: alice
Key name: laptop
Label: alice/laptop
```

Expected dashboard result:

```text
The revealed key starts with sk-soul-
The revealed key prefix is not sk-soul-v1
The revealed key does not visibly contain user:
The revealed key does not visibly contain user:alice:laptop
```

- [ ] **Step 8: Verify encoded key authenticates and raw decoded key is rejected**

Copy the revealed key into `ENCODED_KEY`, then run:

```bash
ENCODED_KEY='paste-dashboard-key-here'
RAW_KEY=$(ENCODED_KEY="$ENCODED_KEY" node -e "const k=process.env.ENCODED_KEY; process.stdout.write(Buffer.from(k.slice('sk-soul-'.length), 'base64url').toString('utf8'))")

curl -sS -o /tmp/encoded-user-key-models.json -w '%{http_code}' \
  -H "Authorization: Bearer ${ENCODED_KEY}" \
  http://127.0.0.1:8080/services/soul-gateway/v1/models

curl -sS -o /tmp/raw-user-key-models.json -w '%{http_code}' \
  -H "Authorization: Bearer ${RAW_KEY}" \
  http://127.0.0.1:8080/services/soul-gateway/v1/models
```

Expected:

```text
Encoded key curl returns 200
Raw decoded user key curl returns 401 or 403 with invalid_api_key semantics
```

- [ ] **Step 9: Push both repos after verification**

```bash
cd /Users/danielsava/work/file-parser/ploinky
git push origin master

cd /Users/danielsava/work/file-parser/proxies
git push origin main
```

Expected: both pushes succeed.
