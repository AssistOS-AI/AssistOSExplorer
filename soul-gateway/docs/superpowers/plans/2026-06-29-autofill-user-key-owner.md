# Autofill User Key Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically prefill the Soul Gateway user API key owner from the verified Ploinky login user, while keeping the field editable for admins who intentionally create keys for another owner.

**Architecture:** Keep authentication authority in Ploinky. Soul Gateway already receives the verified user through `x-ploinky-auth-info`; the fix is to preserve that verified user in management route context, expose a small current-user management endpoint, and let the dashboard initialize the keys modal from that endpoint. Key minting stays unchanged: Soul Gateway continues to send `userId: "<owner>:<name>"` to Ploinky and continues to store `subjectId: "user:<owner>:<name>"`.

**Tech Stack:** Node.js ESM, Soul Gateway management routes, dashboard vanilla JS modules, Node test runner, existing Soul Gateway docs/spec files.

---

## File Structure

Files to create:

```
proxies/soul-gateway/src/management/management-user.mjs
proxies/soul-gateway/src/management/session-route.mjs
proxies/soul-gateway/src/test/unit/management-user.test.mjs
```

Files to modify:

```
proxies/soul-gateway/src/management/build-routes.mjs
proxies/soul-gateway/src/dashboard/js/app.mjs
proxies/soul-gateway/src/test/unit/management.test.mjs
proxies/soul-gateway/src/test/unit/dashboard-keys-page.test.mjs
proxies/soul-gateway/docs/specs/DS012-api-reference.md
proxies/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md
```

---

## Root Cause

Ploinky already forwards the logged-in user to routed services in `x-ploinky-auth-info`. Soul Gateway verifies and parses it in `authenticateRouterAdmin()`, returning an object that includes `user`. The management `admin(handler)` wrapper then discards that returned auth result and calls `handler(ctx)` with no current-user context.

Because that context is lost:

- `POST /management/keys` only sees the dashboard payload and requires a manual `subjectId`.
- The dashboard initializes `createKeyForm.owner` to an empty string.
- The keys modal cannot know that the logged-in admin is already `admin`.

The fix is not to trust browser-provided identity. The fix is to preserve the already verified server-side Ploinky identity and expose only a normalized, non-secret current-user view to the dashboard.

---

## Task 1: Add Tests For Owner Derivation

- [ ] Create `src/test/unit/management-user.test.mjs` with failing tests for owner normalization.

Use these tests:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    deriveUserKeyOwner,
    managementUserView,
    normalizeOwnerPart,
} from '../../management/management-user.mjs';

describe('management user key owner helpers', () => {
    it('prefers the Ploinky username for the key owner', () => {
        assert.equal(
            deriveUserKeyOwner({
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
            }),
            'admin',
        );
    });

    it('falls back from a local id to the id suffix', () => {
        assert.equal(deriveUserKeyOwner({ id: 'local:admin' }), 'admin');
    });

    it('sanitizes owner parts to the Soul Gateway owner grammar', () => {
        assert.equal(normalizeOwnerPart('alice@example.test'), 'alice-example.test');
        assert.equal(normalizeOwnerPart(' local:Jane Doe '), 'Jane-Doe');
    });

    it('returns a compact safe current-user view', () => {
        assert.deepEqual(
            managementUserView({
                source: 'router-sso',
                user: {
                    id: 'local:admin',
                    username: 'admin',
                    email: 'admin@example.test',
                    roles: ['admin'],
                    secret: 'hidden',
                },
            }),
            {
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
                roles: ['admin'],
                keyOwner: 'admin',
            },
        );
    });
});
```

- [ ] Run the test and confirm it fails because `management-user.mjs` does not exist yet.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/management-user.test.mjs
```

Expected outcome: Node reports `ERR_MODULE_NOT_FOUND` for `src/management/management-user.mjs`.

---

## Task 2: Implement Management User Owner Helpers

- [ ] Create `src/management/management-user.mjs`.

Use this implementation:

```js
const OWNER_PART_RE = /^[A-Za-z0-9._-]+$/;
const MAX_OWNER_LENGTH = 64;

export function normalizeOwnerPart(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    const parts = raw.split(':').filter(Boolean);
    const candidate = parts.length > 1 ? parts[parts.length - 1] : raw;
    const normalized = candidate
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_OWNER_LENGTH);

    return OWNER_PART_RE.test(normalized) ? normalized : '';
}

export function deriveUserKeyOwner(user = {}) {
    const candidates = [
        user.username,
        user.name,
        user.id,
        user.email,
    ];

    for (const candidate of candidates) {
        const owner = normalizeOwnerPart(candidate);
        if (owner) return owner;
    }

    return '';
}

export function managementUserView(managementAuth = {}) {
    const user = managementAuth?.user && typeof managementAuth.user === 'object'
        ? managementAuth.user
        : {};

    return {
        id: String(user.id || ''),
        username: String(user.username || user.name || ''),
        email: String(user.email || ''),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role)) : [],
        keyOwner: deriveUserKeyOwner(user),
    };
}
```

- [ ] Re-run the helper test.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/management-user.test.mjs
```

Expected outcome: all tests in `management-user.test.mjs` pass.

---

## Task 3: Preserve Verified Management Auth Context

- [ ] Add tests in `src/test/unit/management.test.mjs` that prove a management route can see the verified Ploinky user.

Add a direct route handler test for the new endpoint after the existing management route tests:

```js
import { handleManagementMe } from '../../management/session-route.mjs';
```

Then add:

```js
describe('management current session route', () => {
    it('returns the verified management user with a derived key owner', async () => {
        const req = createMockReq({ method: 'GET', path: '/management/me' });
        const res = createMockRes();

        await handleManagementMe({
            req,
            res,
            managementAuth: {
                source: 'router-sso',
                user: {
                    id: 'local:admin',
                    username: 'admin',
                    email: 'admin@example.test',
                    roles: ['admin'],
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(parseJsonResponse(res), {
            authenticated: true,
            source: 'router-sso',
            user: {
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
                roles: ['admin'],
                keyOwner: 'admin',
            },
        });
    });
});
```

- [ ] Add a router registration test in the existing build-routes section.

Use the local helper names already present in `management.test.mjs`. The assertion should prove `GET /management/me` is routed through the admin wrapper:

```js
it('registers the current management session route', async () => {
    const appCtx = createMockAppCtx();
    const router = buildManagementRouter(appCtx);
    const req = createRoutedReq({
        method: 'GET',
        path: '/management/me',
        authInfo: {
            user: {
                id: 'local:admin',
                username: 'admin',
                email: 'admin@example.test',
                roles: ['admin'],
            },
        },
    });
    const res = createMockRes();

    await router.handle(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(parseJsonResponse(res).user.keyOwner, 'admin');
});
```

If the exact helper signatures differ, adapt only the setup to the existing test helper API. Keep the assertion and route path unchanged.

- [ ] Run the management tests and confirm the new tests fail because the route does not exist and `ctx.managementAuth` is not set.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
```

Expected outcome: failures mention missing `session-route.mjs`, missing route registration, or missing current-user response.

---

## Task 4: Add The Current Management User Endpoint

- [ ] Create `src/management/session-route.mjs`.

Use this implementation:

```js
import { sendJson } from '../core/responses.mjs';
import { managementUserView } from './management-user.mjs';

export async function handleManagementMe(ctx) {
    sendJson(ctx.res, 200, {
        authenticated: true,
        source: ctx.managementAuth?.source || 'router-sso',
        user: managementUserView(ctx.managementAuth),
    });
}
```

- [ ] Modify `src/management/build-routes.mjs`.

Import the handler:

```js
import { handleManagementMe } from './session-route.mjs';
```

Change the `admin(handler)` wrapper from discarding the auth result to preserving it:

```js
async function admin(handler) {
    return async (ctx) => {
        const managementAuth = await requireAdmin(
            ctx.req,
            appCtx.config.env,
            appCtx.routerAuth || appCtx,
        );
        ctx.managementAuth = managementAuth;
        return handler(ctx);
    };
}
```

Register the endpoint next to the other management routes:

```js
httpRouter.add('GET', '/management/me', admin(handleManagementMe));
```

- [ ] Run the helper and management tests.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/management-user.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
```

Expected outcome: both commands pass.

- [ ] Commit this backend slice.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git status --short
git add src/management/management-user.mjs src/management/session-route.mjs src/management/build-routes.mjs src/test/unit/management-user.test.mjs src/test/unit/management.test.mjs
git commit -m "Expose management current user"
```

Expected outcome: commit succeeds with only the backend and backend-test files staged.

---

## Task 5: Add Dashboard Tests For Owner Autofill

- [ ] Add a failing test to `src/test/unit/dashboard-keys-page.test.mjs`.

The test should mock:

- `GET /management/me` returning `{ user: { keyOwner: 'admin' } }`
- `GET /management/keys` returning an empty key list
- `POST /management/keys` capturing the stored `subjectId`
- `POST /api/router/identity/user-api-key` capturing the minted `userId`

Add this test near the existing keys page create-key tests:

```js
it('prefills the create-key owner from the current management user', async () => {
    const calls = [];

    installFetchMock(async (url, options = {}) => {
        calls.push({ url: String(url), options });

        if (String(url).endsWith('/management/me')) {
            return jsonResponse({
                authenticated: true,
                user: { keyOwner: 'admin' },
            });
        }

        if (String(url).endsWith('/management/keys') && (options.method || 'GET') === 'GET') {
            return jsonResponse({ keys: [] });
        }

        if (String(url).endsWith('/api/router/identity/user-api-key')) {
            return jsonResponse({ apiKey: 'sk-user-admin-laptop' });
        }

        if (String(url).endsWith('/management/keys') && options.method === 'POST') {
            return jsonResponse({ key: { id: 'key-1' } }, 201);
        }

        throw new Error(`unexpected fetch ${url}`);
    });

    const page = createKeysPage();
    await page.init();
    page.openCreateKey();

    assert.equal(page.createKeyForm.owner, 'admin');

    page.createKeyForm.name = 'laptop';
    await page.submitCreateKey();

    const createCall = calls.find((call) => call.url.endsWith('/management/keys') && call.options.method === 'POST');
    const mintCall = calls.find((call) => call.url.endsWith('/api/router/identity/user-api-key'));

    assert.equal(JSON.parse(createCall.options.body).subjectId, 'user:admin:laptop');
    assert.equal(JSON.parse(mintCall.options.body).userId, 'admin:laptop');
});
```

If local helper names differ, use the existing test helpers in that file. Keep the endpoint URLs and assertions unchanged.

- [ ] Run the dashboard keys page test and confirm it fails.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/dashboard-keys-page.test.mjs
```

Expected outcome: the new test fails because the page does not call `/management/me` and still initializes `createKeyForm.owner` to `''`.

---

## Task 6: Autofill Owner In The Keys Dashboard

- [ ] Modify `src/dashboard/js/app.mjs`.

Find the keys page state and add current-user fields:

```js
currentUser: null,
currentOwner: '',
```

Add a loader method to the keys page object:

```js
async loadCurrentUser() {
    try {
        const payload = await api.get('/management/me');
        const user = payload?.user && typeof payload.user === 'object' ? payload.user : null;
        this.currentUser = user;
        this.currentOwner = String(user?.keyOwner || '').trim();
    } catch (err) {
        this.currentUser = null;
        this.currentOwner = '';
        console.warn('Unable to load management user', err);
    }
}
```

Update `init()` so the current user is loaded before key rows are mapped:

```js
async init() {
    await this.loadCurrentUser();
    const raw = unwrapArray(await api.get('/management/keys'));
    this.keys = raw.map((item) => this._normalizeKey(item));
    this.applyFilters();
}
```

Update `openCreateKey()` so the owner starts with the verified Ploinky owner:

```js
openCreateKey() {
    this.createKeyForm = {
        owner: this.currentOwner || '',
        name: '',
        model: '',
        tier: '',
        ttl: '',
        label: '',
        metadata: '',
        error: '',
        busy: false,
        created: null,
    };
    this.showCreateKeyModal = true;
}
```

Update `submitCreateKey()` so a blank owner still falls back to the verified owner if it exists:

```js
const owner = String(this.createKeyForm.owner || this.currentOwner || '').trim();
```

Keep the existing validation and payload shape unchanged after that line. The key still needs a valid owner and name, and admins can still edit the owner before submitting.

- [ ] Run the dashboard keys page test.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/dashboard-keys-page.test.mjs
```

Expected outcome: the new dashboard owner autofill test passes with the existing keys page tests.

- [ ] Commit the dashboard slice.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git status --short
git add src/dashboard/js/app.mjs src/test/unit/dashboard-keys-page.test.mjs
git commit -m "Autofill user key owner"
```

Expected outcome: commit succeeds with only dashboard and dashboard-test files staged.

---

## Task 7: Document The Contract

- [ ] Update `docs/specs/DS012-api-reference.md`.

Add the new endpoint to the management API section:

```md
### GET /management/me

Returns the current management session as verified by Ploinky router auth. The response is non-secret and is used by the dashboard to prefill API key ownership fields.

Response:

```json
{
  "authenticated": true,
  "source": "router-sso",
  "user": {
    "id": "local:admin",
    "username": "admin",
    "email": "admin@example.test",
    "roles": ["admin"],
    "keyOwner": "admin"
  }
}
```

`keyOwner` is derived from the verified user in this order: `username`, `name`, `id`, `email`. It is normalized to Soul Gateway's owner grammar `[A-Za-z0-9._-]+`; colon-prefixed local ids such as `local:admin` become `admin`.
```

Also update the user-key creation text to state that the dashboard defaults the owner from `/management/me`, but the API still requires a valid `subjectId` and admins may override the owner intentionally.

- [ ] Update `docs/specs/DS016-ploinky-agent-mode.md`.

Add a short note in the router-auth or dashboard section:

```md
Soul Gateway preserves the verified Ploinky user from `x-ploinky-auth-info` on management route context and exposes a non-secret `/management/me` view. The keys dashboard uses `user.keyOwner` from that view to prefill the user API key owner. Soul Gateway does not infer ownership from browser state and does not accept an unauthenticated owner claim.
```

- [ ] Run a docs diff check.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git diff -- docs/specs/DS012-api-reference.md docs/specs/DS016-ploinky-agent-mode.md
```

Expected outcome: the diff describes only the new current-user endpoint and owner-prefill contract.

- [ ] Commit the docs slice.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git status --short
git add docs/specs/DS012-api-reference.md docs/specs/DS016-ploinky-agent-mode.md
git commit -m "Document management user owner defaults"
```

Expected outcome: commit succeeds with only docs files staged.

---

## Task 8: Full Verification

- [ ] Run focused tests.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/management-user.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
node --test src/test/unit/dashboard-keys-page.test.mjs
```

Expected outcome: all focused tests pass.

- [ ] Run the full Soul Gateway test suite.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
npm test
```

Expected outcome: the full suite passes.

- [ ] Check formatting hazards.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git diff --check
```

Expected outcome: no whitespace errors.

- [ ] Manually verify in a clean Ploinky run if local deployment time allows.

Command:

```bash
cd /Users/danielsava/work/testExplorerFresh
ploinky destroy
rm -rf .ploinky
ploinky start explorer
```

Manual expected outcome:

- Open Soul Gateway through Ploinky as the admin user.
- Open `Keys`.
- Click create key.
- Owner is prefilled as `admin`.
- Submitting a key named `laptop` stores `subjectId: user:admin:laptop`.
- Ploinky mints the corresponding user key for `admin:laptop`.

---

## Task 9: Final Review And Integration

- [ ] Review the complete diff.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git status --short
git diff HEAD~3..HEAD -- src/management src/dashboard/js/app.mjs src/test/unit docs/specs
```

Expected outcome: changes are limited to management current-user context, keys owner autofill, tests, and docs.

- [ ] Confirm the branch history.

Command:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git log --oneline -3
```

Expected outcome: the three commits are:

```text
Expose management current user
Autofill user key owner
Document management user owner defaults
```

- [ ] If the repository policy for this session is to push directly to `main`, merge or fast-forward as instructed, then push.

Command:

```bash
cd /Users/danielsava/work/file-parser
git status --short
git branch --show-current
git push origin main
```

Expected outcome: `main` is pushed only after tests pass and the working tree contains no unrelated staged changes.

---

## Self-Review Checklist

- [ ] The owner is derived only from server-verified Ploinky auth context.
- [ ] Browser input can override the owner only through the existing admin-only create-key flow.
- [ ] Raw ids such as `local:admin` do not become invalid owner values with colons.
- [ ] The Ploinky identity minting payload remains `userId: "<owner>:<name>"`.
- [ ] The Soul Gateway stored subject remains `user:<owner>:<name>`.
- [ ] Existing manually entered owner behavior remains supported.
- [ ] Logs, activity, usage, and errors pages are not touched by this fix.
