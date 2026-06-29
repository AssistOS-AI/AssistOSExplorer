import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        redirected: false,
        async json() {
            return body;
        },
    };
}

async function loadDashboard(fetchImpl = async () => {
    throw new Error('unexpected fetch');
}) {
    const source = await readFile(
        new URL('../../dashboard/js/app.mjs', import.meta.url),
        'utf8'
    );
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
        fetch: fetchImpl,
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
    return { window };
}

describe('dashboard keys page', () => {
    it('normalizes numeric legacy revocation flags to booleans', async () => {
        const { window } = await loadDashboard();
        const page = window.keysPage();

        assert.equal(
            page.isRevoked({ status: 'active', is_revoked: 0 }),
            false
        );
        assert.equal(
            page.isRevoked({ status: 'active', is_revoked: 1 }),
            true
        );
        assert.equal(page.isRevoked({ status: 'revoked' }), true);
    });

    it('binds key action disabled states to the boolean revocation helper', async () => {
        const html = await readFile(
            new URL('../../dashboard/index.html', import.meta.url),
            'utf8'
        );

        assert.match(html, /:disabled="isRevoked\(k\)"/);
        assert.doesNotMatch(
            html,
            /:disabled="k\.status === 'revoked' \|\| k\.is_revoked"/
        );
    });

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
                if (String(url).endsWith('/management/me')) {
                    return jsonResponse({
                        authenticated: true,
                        user: { keyOwner: 'alice' },
                    });
                }
                if (String(url).endsWith('/management/keys')) {
                    return {
                        status: 200,
                        ok: true,
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

    it('prefills the create-key owner from the current management user and falls back on submit', async () => {
        const calls = [];
        const { window } = await loadDashboard(async (url, options = {}) => {
            calls.push({ url: String(url), options });

            if (String(url).endsWith('/management/me')) {
                return jsonResponse({
                    authenticated: true,
                    user: { keyOwner: 'admin' },
                });
            }

            if (
                String(url).endsWith('/management/keys') &&
                (options.method || 'GET') === 'GET'
            ) {
                return jsonResponse({ keys: [] });
            }

            if (
                String(url).endsWith('/management/keys') &&
                options.method === 'POST'
            ) {
                return jsonResponse({ key: { id: 'key-1' } }, 201);
            }

            if (String(url).endsWith('/api/router/identity/user-api-key')) {
                return jsonResponse({ apiKey: 'sk-user-admin-laptop' });
            }

            throw new Error(`unexpected fetch ${url}`);
        });

        const page = window.keysPage();
        await page.init();
        page.openCreateKey();

        assert.equal(page.createKeyForm.owner, 'admin');

        page.createKeyForm.owner = '';
        page.createKeyForm.name = 'laptop';
        await page.submitCreateKey();

        const createCall = calls.find(
            (call) =>
                call.url.endsWith('/management/keys') &&
                call.options.method === 'POST'
        );
        const mintCall = calls.find((call) =>
            call.url.endsWith('/api/router/identity/user-api-key')
        );

        assert.equal(JSON.parse(createCall.options.body).subjectId, 'user:admin:laptop');
        assert.equal(JSON.parse(mintCall.options.body).userId, 'admin:laptop');
    });

    it('uses an admin-entered owner instead of the current user default', async () => {
        const calls = [];
        const { window } = await loadDashboard(async (url, options = {}) => {
            calls.push({ url: String(url), options });

            if (String(url).endsWith('/management/me')) {
                return jsonResponse({
                    authenticated: true,
                    user: { keyOwner: 'admin' },
                });
            }

            if (
                String(url).endsWith('/management/keys') &&
                (options.method || 'GET') === 'GET'
            ) {
                return jsonResponse({ keys: [] });
            }

            if (
                String(url).endsWith('/management/keys') &&
                options.method === 'POST'
            ) {
                return jsonResponse({ key: { id: 'key-1' } }, 201);
            }

            if (String(url).endsWith('/api/router/identity/user-api-key')) {
                return jsonResponse({ apiKey: 'sk-user-bob-laptop' });
            }

            throw new Error(`unexpected fetch ${url}`);
        });

        const page = window.keysPage();
        await page.init();
        page.openCreateKey();

        assert.equal(page.createKeyForm.owner, 'admin');

        page.createKeyForm.owner = 'bob';
        page.createKeyForm.name = 'laptop';
        await page.submitCreateKey();

        const createCall = calls.find(
            (call) =>
                call.url.endsWith('/management/keys') &&
                call.options.method === 'POST'
        );
        const mintCall = calls.find((call) =>
            call.url.endsWith('/api/router/identity/user-api-key')
        );

        assert.equal(JSON.parse(createCall.options.body).subjectId, 'user:bob:laptop');
        assert.equal(JSON.parse(mintCall.options.body).userId, 'bob:laptop');
    });

    it('treats whitespace-only owner input as blank and falls back to current owner', async () => {
        const calls = [];
        const { window } = await loadDashboard(async (url, options = {}) => {
            calls.push({ url: String(url), options });

            if (String(url).endsWith('/management/me')) {
                return jsonResponse({
                    authenticated: true,
                    user: { keyOwner: 'admin' },
                });
            }

            if (
                String(url).endsWith('/management/keys') &&
                (options.method || 'GET') === 'GET'
            ) {
                return jsonResponse({ keys: [] });
            }

            if (
                String(url).endsWith('/management/keys') &&
                options.method === 'POST'
            ) {
                return jsonResponse({ key: { id: 'key-1' } }, 201);
            }

            if (String(url).endsWith('/api/router/identity/user-api-key')) {
                return jsonResponse({ apiKey: 'sk-user-admin-laptop' });
            }

            throw new Error(`unexpected fetch ${url}`);
        });

        const page = window.keysPage();
        await page.init();
        page.openCreateKey();

        page.createKeyForm.owner = '   ';
        page.createKeyForm.name = 'laptop';
        await page.submitCreateKey();

        const createCall = calls.find(
            (call) =>
                call.url.endsWith('/management/keys') &&
                call.options.method === 'POST'
        );
        const mintCall = calls.find((call) =>
            call.url.endsWith('/api/router/identity/user-api-key')
        );

        assert.equal(page.createKeyError, '');
        assert.equal(JSON.parse(createCall.options.body).subjectId, 'user:admin:laptop');
        assert.equal(JSON.parse(mintCall.options.body).userId, 'admin:laptop');
    });
});
