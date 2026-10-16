import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { oauthAdapter } from '../../runtime/providers/oauth/google-gemini.mjs';

const SECRET_ENV = 'SOUL_GATEWAY_GEMINI_OAUTH_CLIENT_SECRET';

describe('google-gemini OAuth client credentials', () => {
    let originalFetch;
    let originalSecret;
    let requests;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalSecret = process.env[SECRET_ENV];
        delete process.env[SECRET_ENV];
        requests = [];
        globalThis.fetch = async (url, init = {}) => {
            requests.push({ url: String(url), body: String(init.body || '') });
            return new Response(JSON.stringify({
                access_token: 'access',
                expires_in: 3600,
                token_type: 'Bearer',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalSecret === undefined) delete process.env[SECRET_ENV];
        else process.env[SECRET_ENV] = originalSecret;
    });

    it('refreshes with the client ID alone when no secret is configured', async () => {
        await oauthAdapter.refreshTokens({ refreshToken: 'refresh' });
        const body = new URLSearchParams(requests[0].body);
        assert.match(body.get('client_id'), /\.apps\.googleusercontent\.com$/);
        assert.equal(body.has('client_secret'), false);
    });

    it('sends a client secret only when the environment supplies one', async () => {
        process.env[SECRET_ENV] = 'operator-secret';
        await oauthAdapter.refreshTokens({ refreshToken: 'refresh' });
        const body = new URLSearchParams(requests[0].body);
        assert.equal(body.get('client_secret'), 'operator-secret');
    });
});
