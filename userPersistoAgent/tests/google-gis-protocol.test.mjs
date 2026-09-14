import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { createGoogleProtocol, getGoogleStatus, requireGoogleConfiguration, GOOGLE_ISSUER,
    GOOGLE_LOCAL_CLIENT_ID, GOOGLE_LOCAL_REDIRECT_URI } from '../lib/auth/google.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { resetStoreForTests } from '../lib/store.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...keys.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'google-test-key' };
const protocol = createGoogleProtocol({ jwks: createLocalJWKSet({ keys: [key] }) });
const config = { mode: 'gis', clientId: GOOGLE_LOCAL_CLIENT_ID };
const attempt = { nonce: randomBytes(32).toString('base64url'), flow: 'sso' };

function credential(overrides = {}, { privateKey = keys.privateKey, header = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: GOOGLE_ISSUER, sub: 'GoogleCaseSensitiveSubject', aud: config.clientId, iat: now, exp: now + 300,
        nonce: attempt.nonce, email: 'Member@Gmail.com', email_verified: true, ...overrides };
    const parts = [JSON.stringify({ alg: 'RS256', kid: key.kid, ...header }), JSON.stringify(claims)].map((value) => Buffer.from(value).toString('base64url'));
    const unsigned = parts.join('.');
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

test('GIS verifies signed Google credentials without client secret, discovery, or code exchange', async () => {
    const expected = { issuer: GOOGLE_ISSUER, subject: 'GoogleCaseSensitiveSubject', email: 'member@gmail.com', emailVerified: true };
    assert.equal(protocol.authorization, undefined);
    assert.equal(protocol.exchange, undefined);
    for (const issuer of [GOOGLE_ISSUER, 'accounts.google.com']) {
        assert.deepEqual(await protocol.verifyCredential(config, credential({ iss: issuer }), attempt), expected);
    }
    assert.deepEqual(await protocol.verifyCredential(config, credential({ aud: [config.clientId, 'other-client'], azp: config.clientId, hd: 'Example.COM' }), attempt), {
        ...expected, hostedDomain: 'example.com',
    });
});

test('GIS rejects forged signatures, algorithm/key substitution, and malformed credentials', async () => {
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const token of [credential({}, { privateKey: forged.privateKey }),
        ...['HS256', 'none', 'RS512'].map((alg) => credential({}, { header: { alg } })),
        credential({}, { header: { kid: 'unknown-key', jwk: { ...key, ...forged.publicKey.export({ format: 'jwk' }) }, jku: 'https://attacker.invalid/jwks' } }),
        '', null, {}, 123, 'bad.token.value', 'a'.repeat(16_385), `${credential()} `]) {
        await assert.rejects(protocol.verifyCredential(config, token, attempt), { code: 'google_authentication_failed' });
    }
    await assert.rejects(protocol.verifyCredential({ ...config, mode: 'authorization_code' }, credential(), attempt), { code: 'google_authentication_failed' });
});

test('GIS rejects missing and malformed identity, audience, issuer, timing, nonce, and email claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const variations = [
        { iss: 'https://attacker.invalid' }, { iss: `${GOOGLE_ISSUER}/` }, { iss: ['accounts.google.com'] },
        { aud: 'other-client' }, { aud: [config.clientId, 12], azp: config.clientId }, { aud: [config.clientId, 'other-client'] },
        { azp: 'other-client' }, { azp: null }, { aud: [] },
        { sub: '' }, { sub: 'x'.repeat(256) }, { sub: 'bad subject' }, { sub: 'bad\u007fsubject' }, { sub: 12 },
        { nonce: 'wrong-nonce' }, { nonce: [attempt.nonce] }, { nonce: null },
        { iat: now + 120 }, { iat: now - 601 }, { iat: String(now) }, { iat: now + 0.5 },
        { exp: now - 31 }, { exp: now }, { exp: String(now + 300) }, { exp: now + 300.5 },
        { email: 'malformed' }, { email: 'member@example.com\n' }, { email: 'm'.repeat(255) + '@gmail.com' },
        { email_verified: false }, { email_verified: 'true' },
        { hd: 'domain/invalid' }, { hd: '' }, { hd: 'a'.repeat(254) }, { hd: 12 },
        ...['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'email', 'email_verified'].map((name) => ({ [name]: undefined })),
    ];
    for (const claims of variations) {
        await assert.rejects(protocol.verifyCredential(config, credential(claims), attempt), { code: 'google_authentication_failed' }, JSON.stringify(claims));
    }
    for (const payload of [{}, { nonce: '' }, { nonce: null }]) {
        await assert.rejects(protocol.verifyCredential(config, credential(), payload), { code: 'google_authentication_failed' });
    }
});

test('GIS account confirmation still requires signed recent auth_time', async () => {
    const now = Math.floor(Date.now() / 1000);
    const reauth = { ...attempt, flow: 'reauth' };
    for (const authTime of [undefined, now - 301, now + 31, String(now), now - 0.5]) {
        await assert.rejects(protocol.verifyCredential(config, credential({ auth_time: authTime }), reauth), {
            code: 'google_recent_authentication_required', statusCode: 401,
        });
    }
    const result = await protocol.verifyCredential(config, credential({ auth_time: now }), reauth);
    assert.equal(result.authenticatedAt, now * 1000);
    assert.equal(Object.hasOwn(await protocol.verifyCredential(config, credential({ auth_time: now }), attempt), 'authenticatedAt'), false);
});

test('GIS key lookup failure fails closed without returning token or upstream errors', async () => {
    const unavailable = createGoogleProtocol({ jwks: async () => { throw new Error('private upstream diagnostic'); } });
    await assert.rejects(unavailable.verifyCredential(config, credential(), attempt), (error) => {
        assert.equal(error.code, 'google_authentication_failed');
        assert.doesNotMatch(error.message, /private upstream diagnostic|eyJ/);
        return true;
    });
});

test('the pinned Google JWKS resolver shares cached requests, rejects redirects, and refreshes rotated keys after cooldown', async (context) => {
    const productionProtocol = createGoogleProtocol();
    const secondProtocol = createGoogleProtocol();
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let published = key;
    let status = 302;
    let requests = 0;
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    context.mock.method(globalThis, 'fetch', async (url, options) => {
        requests += 1;
        assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.method, 'GET');
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(JSON.stringify({ keys: [published] }), { status, headers: { location: 'https://attacker.invalid/keys' } });
    });
    try {
        await assert.rejects(productionProtocol.verifyCredential(config, credential(), attempt), { code: 'google_authentication_failed' });
        assert.equal(requests, 1);
        status = 200;
        const identities = await Promise.all([productionProtocol, secondProtocol].map((client) => client.verifyCredential(config, credential(), attempt)));
        assert.equal(identities.length, 2);
        assert.equal(requests, 2, 'concurrent verifications share one Google JWKS request');
        await secondProtocol.verifyCredential(config, credential(), attempt);
        assert.equal(requests, 2, 'a cached key is reused across protocol instances');
        published = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated-google-key', alg: 'RS256', use: 'sig' };
        const rotatedToken = () => credential({}, { privateKey: rotated.privateKey, header: { kid: published.kid } });
        await assert.rejects(productionProtocol.verifyCredential(config, rotatedToken(), attempt), { code: 'google_authentication_failed' });
        assert.equal(requests, 2, 'unknown keys cannot bypass the refresh cooldown');
        context.mock.timers.tick(31_000);
        assert.equal((await productionProtocol.verifyCredential(config, rotatedToken(), attempt)).subject, 'GoogleCaseSensitiveSubject');
        assert.equal(requests, 3);
    } finally {
        context.mock.timers.reset();
        context.mock.restoreAll();
    }
});

test('Google defaults are secret-free and local; partial/invalid configuration fails closed', async () => {
    const saved = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'google-gis-config-'));
    const reset = () => {
        for (const name of ['USERPERSISTO_GOOGLE_MODE', 'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_CLIENT_SECRET', 'USERPERSISTO_GOOGLE_REDIRECT_URI']) delete process.env[name];
        process.env.USERPERSISTO_SETTINGS_KEY = 'installation-private-settings-key';
        process.env.USERPERSISTO_AUTH_METHODS = 'google,emailCode';
    };
    try {
        process.env.PERSISTENCE_FOLDER = folder;
        reset();
        await ensureSeedData();
        const fresh = await getGoogleStatus();
        assert.equal(fresh.available, true);
        assert.equal(fresh.mode, 'gis');
        assert.equal(fresh.secretRequired, false);
        assert.equal(Object.hasOwn(fresh, 'secretPresent'), false);
        assert.equal(fresh.configurationSource, 'local-default');
        assert.equal(fresh.clientId, GOOGLE_LOCAL_CLIENT_ID);
        assert.equal(fresh.redirectUri, GOOGLE_LOCAL_REDIRECT_URI);
        assert.deepEqual(fresh.missing, []);
        assert.doesNotMatch(JSON.stringify(fresh), /installation-private-settings-key|clientSecret/);
        delete process.env.USERPERSISTO_SETTINGS_KEY;
        assert.deepEqual((await getGoogleStatus()).missing, ['USERPERSISTO_SETTINGS_KEY']);
        await assert.rejects(requireGoogleConfiguration(), { code: 'google_unavailable' });

        for (const values of [
            { USERPERSISTO_GOOGLE_CLIENT_ID: 'custom-client' },
            { USERPERSISTO_GOOGLE_REDIRECT_URI: GOOGLE_LOCAL_REDIRECT_URI },
            ...['https://public.example', 'http://[::1]:8080', 'http://localhost:8081', 'http://localhost:8080.evil.test'].map((origin) => ({
                USERPERSISTO_GOOGLE_CLIENT_ID: GOOGLE_LOCAL_CLIENT_ID,
                USERPERSISTO_GOOGLE_REDIRECT_URI: `${origin}/service/auth/google/callback`,
            })),
            ...['http://public.example', 'https://user:pass@public.example', 'https://public.example/service/auth/google/callback?x=1', 'https://public.example//foreign.example'].map((origin) => ({
                USERPERSISTO_GOOGLE_CLIENT_ID: 'custom-client',
                USERPERSISTO_GOOGLE_REDIRECT_URI: origin.includes('?') ? origin : `${origin}/service/auth/google/callback`,
            })),
        ]) {
            reset();
            Object.assign(process.env, values);
            assert.equal((await getGoogleStatus()).available, false, JSON.stringify(values));
            await assert.rejects(requireGoogleConfiguration(), { code: 'google_unavailable' });
        }

        reset();
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = GOOGLE_LOCAL_CLIENT_ID;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = GOOGLE_LOCAL_REDIRECT_URI.replace('localhost', '127.0.0.1');
        assert.equal((await getGoogleStatus()).available, true);
        reset();
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'deployment-client';
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = 'https://public.example/service/auth/google/callback';
        assert.equal((await getGoogleStatus()).available, true);
        assert.equal((await getGoogleStatus()).mode, 'gis');
        const before = await requireGoogleConfiguration();
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'changed-client';
        assert.notEqual((await requireGoogleConfiguration()).fingerprint, before.fingerprint);
        process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'unused-private-client-secret';
        process.env.USERPERSISTO_GOOGLE_MODE = 'unused-mode';
        const current = await requireGoogleConfiguration();
        assert.equal(current.mode, 'gis');
        assert.equal(Object.hasOwn(current, 'clientSecret'), false);
        assert.equal((await getGoogleStatus()).available, true);
        assert.doesNotMatch(JSON.stringify(await getGoogleStatus()), /unused-private-client-secret|unused-mode/);
    } finally {
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(saved, name)) delete process.env[name];
        Object.assign(process.env, saved);
        await rm(folder, { recursive: true, force: true });
    }
});
