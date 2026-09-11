import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledGoogleProvider } from './helpers/googleProvider.mjs';

test('upstream authorization code uses S256, secret-post and verified signed identity', async () => {
    const fixture = await controlledGoogleProvider();
    try {
        const config = { clientId: 'controlled-google-client', clientSecret: 'controlled-google-secret', redirectUri: `${fixture.origin}/callback`, fingerprint: 'fixture' };
        const start = await fixture.protocol.authorization(config);
        const url = new URL(start.url);
        assert.equal(url.searchParams.get('scope'), 'openid email');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('access_type'), null);
        const callback = await fixture.approve(start.url);
        const identity = await fixture.protocol.exchange(config, callback, start);
        assert.deepEqual(identity, { issuer: 'https://accounts.google.com', subject: 'controlled-user', email: 'controlled@gmail.com', emailVerified: true });
        await assert.rejects(fixture.protocol.exchange(config, callback, start));
    } finally { await fixture.close(); }
});

test('upstream rejects bad signatures, claims, nonce, state, PKCE, and absent ID tokens', async () => {
    const fixture = await controlledGoogleProvider();
    try {
        const config = { clientId: 'controlled-google-client', clientSecret: 'controlled-google-secret', redirectUri: `${fixture.origin}/callback`, fingerprint: 'fixture' };
        const now = Math.floor(Date.now() / 1000);
        for (const variant of [{ mode: 'bad-signature' }, { mode: 'no-id-token' }, { claims: { iss: 'https://wrong.invalid' } },
            { claims: { aud: 'wrong' } }, { claims: { azp: 'wrong' } }, { claims: { aud: ['controlled-google-client', 'other'] } },
            { claims: { exp: now - 120 } }, { claims: { iat: now + 120 } }, { claims: { nonce: 'wrong' } },
            { claims: { email_verified: false } }, { claims: { sub: '' } }, { claims: { sub: 'a'.repeat(256) } },
            { mutate: 'state' }, { mutate: 'verifier' }]) {
            fixture.state.claims = variant.claims || {};
            fixture.state.mode = variant.mode || '';
            const start = await fixture.protocol.authorization(config);
            const callback = await fixture.approve(start.url);
            if (variant.mutate) start[variant.mutate] = 'wrong';
            await assert.rejects(fixture.protocol.exchange(config, callback, start), { code: 'google_authentication_failed' }, JSON.stringify(variant));
        }
    } finally { await fixture.close(); }
});

test('failed discovery can retry; token and JWKS failures never return identity', async () => {
    const fixture = await controlledGoogleProvider();
    try {
        const config = { clientId: 'controlled-google-client', clientSecret: 'controlled-google-secret', redirectUri: `${fixture.origin}/callback`, fingerprint: 'fixture' };
        fixture.state.metadataStatus = 503;
        await assert.rejects(fixture.protocol.authorization(config), { code: 'google_provider_unavailable' });
        fixture.state.metadataStatus = 0;
        for (const failure of ['tokenStatus', 'jwksStatus']) {
            const start = await fixture.protocol.authorization(config);
            const callback = await fixture.approve(start.url);
            fixture.state[failure] = 503;
            await assert.rejects(fixture.protocol.exchange(config, callback, start), { code: 'google_authentication_failed' });
            fixture.state[failure] = 0;
        }
        const start = await fixture.protocol.authorization(config);
        const callback = await fixture.approve(start.url);
        assert.equal((await fixture.protocol.exchange(config, callback, start)).subject, fixture.state.subject);
    } finally { await fixture.close(); }
});

test('a rotated signing key is verified after the library JWKS refresh interval', async (context) => {
    const fixture = await controlledGoogleProvider();
    try {
        const config = { clientId: 'controlled-google-client', clientSecret: 'controlled-google-secret', redirectUri: `${fixture.origin}/callback`, fingerprint: 'fixture' };
        const first = await fixture.protocol.authorization(config);
        await fixture.protocol.exchange(config, await fixture.approve(first.url), first);
        fixture.rotate();
        context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
        context.mock.timers.tick(61_000);
        const next = await fixture.protocol.authorization(config);
        assert.equal((await fixture.protocol.exchange(config, await fixture.approve(next.url), next)).subject, fixture.state.subject);
    } finally { context.mock.timers.reset(); await fixture.close(); }
});
