import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadDashboard() {
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
        fetch: async () => {
            throw new Error('unexpected fetch');
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
});
