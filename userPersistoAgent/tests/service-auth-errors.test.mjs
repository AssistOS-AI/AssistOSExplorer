import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-service-errors-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, updateUser } = await import('../lib/users.mjs');
const { updateAuthPolicy } = await import('../lib/policy.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');
const { createLoginRequest, consumeAuthCode } = await import('../lib/sso.mjs');
const { startService } = await import('../service/index.mjs');
const setup = await import('./helpers/setup.mjs');

let server;
let baseUrl;
let passkeyUser;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentialId = randomBytes(24).toString('base64url');

before(async () => {
    await ensureSeedData();
    setup.configureAdministratorPassword();
    await setup.claimAdministrator();
    const blocked = await createUser({ email: 'blocked@example.test', roles: ['user'], emailVerified: true });
    await updateUser(blocked.id, { status: 'blocked' });
    passkeyUser = await createUser({ email: 'passkey@example.test', roles: ['user'] });
    await (await getStore()).createAuthMethod({
        key: `${passkeyUser.id}:passkey:${credentialId}`,
        userId: passkeyUser.id,
        type: 'passkey',
        enabled: true,
        credential: { credentialId, publicKeyJwk: publicKey.export({ format: 'jwk' }), alg: -7, counter: 0 },
    });
    await flush();
    await updateAuthPolicy({
        enabledAuthMethods: ['emailCode', 'passkey', 'totp'],
    });
    server = startService(0);
    if (!server.listening) await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// UP|UV: passkeys must prove user verification, not only presence.
function signedAssertion(options, { challenge = options.publicKey.challenge, origin = baseUrl, rpId = new URL(baseUrl).hostname, flags = 0x05, counter = 1 } = {}) {
    const authenticatorData = Buffer.alloc(37);
    createHash('sha256').update(rpId).digest().copy(authenticatorData);
    authenticatorData[32] = flags;
    authenticatorData.writeUInt32BE(counter, 33);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
    return { id: credentialId, rawId: credentialId, type: 'public-key', response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
    } };
}

// Passkey challenges are bound to a live SSO parent (purpose sso-login:<requestId>).
async function passkeyOptions(email = passkeyUser.email) {
    const request = await createLoginRequest({ redirectUri: `${baseUrl}/auth/callback` });
    const result = await post('/service/auth/passkey/options', { email, requestId: request.providerState });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.publicKey.userVerification, 'required');
    return { ...result.body, requestId: request.providerState };
}

function assertAuthenticationFailure(result) {
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { ok: false, error: 'authentication_failed' });
}

test('malformed passkey assertions return neutral authentication failures for active, blocked and unknown accounts', async (t) => {
    const options = await passkeyOptions();
    const valid = signedAssertion(options);
    const withClientData = (clientDataJSON) => ({ ...valid, response: { ...valid.response, clientDataJSON } });
    const encodedJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const malformed = [
        ['missing assertion', undefined],
        ['null assertion', null],
        ['string assertion', 'invalid'],
        ['missing response', {}],
        ['null response', { response: null }],
        ['missing client data', withClientData(undefined)],
        ['object client data', withClientData({})],
        ['number client data', withClientData(42)],
        ['invalid base64url', withClientData('!not-base64!')],
        ['invalid JSON', withClientData(Buffer.from('{').toString('base64url'))],
        ['null client JSON', withClientData(encodedJson(null))],
        ['array client JSON', withClientData(encodedJson([]))],
        ['wrong response type', withClientData(encodedJson({ type: 'webauthn.create', challenge: options.publicKey.challenge, origin: baseUrl }))],
        ['ignored base64 characters', withClientData(`${valid.response.clientDataJSON}!`)],
    ];
    for (const [name, assertion] of malformed) {
        await t.test(name, async () => {
            for (const email of [passkeyUser.email, 'blocked@example.test', 'missing@example.test']) {
                assertAuthenticationFailure(await post('/service/auth/passkey/verify', { email, assertion, challengeKey: options.challengeKey, requestId: options.requestId }));
            }
        });
    }
    const store = await getStore();
    assert.ok(await store.getAuthChallengeByChallengeId(options.challengeKey), 'malformed client data cannot consume the valid challenge');
    assert.equal((await store.getAuthMethodByKey(`${passkeyUser.id}:passkey:${credentialId}`)).credential.counter, 0);
    assert.equal((await store.select('ssoAuthCode')).objects.length, 0, 'malformed assertions never issue a sign-in code');
});

test('passkey rejection keeps challenge, origin, relying party, presence and signature checks intact', async (t) => {
    const invalidAssertions = [
        ['wrong challenge', (options) => signedAssertion(options, { challenge: 'different-challenge' })],
        ['wrong browser origin', (options) => signedAssertion(options, { origin: 'https://evil.test' })],
        ['wrong relying party', (options) => signedAssertion(options, { rpId: 'evil.test' })],
        ['missing user presence', (options) => signedAssertion(options, { flags: 0 })],
        ['presence without user verification', (options) => signedAssertion(options, { flags: 0x01 })],
        ['invalid signature', (options) => {
            const assertion = signedAssertion(options);
            assertion.response.signature = randomBytes(64).toString('base64url');
            return assertion;
        }],
        ['truncated authenticator data', (options) => {
            const assertion = signedAssertion(options);
            assertion.response.authenticatorData = Buffer.alloc(2).toString('base64url');
            return assertion;
        }],
    ];
    for (const [name, makeAssertion] of invalidAssertions) {
        await t.test(name, async () => {
            const options = await passkeyOptions();
            assertAuthenticationFailure(await post('/service/auth/passkey/verify', {
                email: passkeyUser.email, assertion: makeAssertion(options), challengeKey: options.challengeKey, requestId: options.requestId,
            }));
        });
    }
    assert.equal((await (await getStore()).getAuthMethodByKey(`${passkeyUser.id}:passkey:${credentialId}`)).credential.counter, 0);
});

test('a valid signed passkey assertion completes SSO once and rejects assertion and counter replay', async () => {
    const options = await passkeyOptions();
    // A challenge issued for one parent cannot complete another.
    const otherRequest = await createLoginRequest({ redirectUri: `${baseUrl}/auth/callback` });
    assertAuthenticationFailure(await post('/service/auth/passkey/verify', { email: passkeyUser.email, assertion: signedAssertion(options),
        challengeKey: options.challengeKey, requestId: otherRequest.providerState }));
    const body = { email: passkeyUser.email, assertion: signedAssertion(options), challengeKey: options.challengeKey, requestId: options.requestId };
    const signedIn = await post('/service/auth/passkey/verify', body);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.ok, true);
    assert.equal((await consumeAuthCode({ providerState: options.requestId, code: signedIn.body.code })).user.id, passkeyUser.id);
    assert.equal((await post('/service/auth/passkey/verify', body)).body.error, 'login_request_invalid');
    const nextOptions = await passkeyOptions();
    assertAuthenticationFailure(await post('/service/auth/passkey/verify', {
        ...body, assertion: signedAssertion(nextOptions, { counter: 1 }), challengeKey: nextOptions.challengeKey, requestId: nextOptions.requestId,
    }));
    assert.equal((await (await getStore()).getAuthMethodByKey(`${passkeyUser.id}:passkey:${credentialId}`)).credential.counter, 1);
});

test('invalid client challenges preserve pending passkey sign-ins with and without a challenge key', async (t) => {
    const user = await createUser({ email: 'pending-passkey@example.test', roles: ['user'] });
    const pendingCredentialId = randomBytes(24).toString('base64url');
    const methodKey = `${user.id}:passkey:${pendingCredentialId}`;
    const store = await getStore();
    await store.createAuthMethod({
        key: methodKey,
        userId: user.id,
        type: 'passkey',
        enabled: true,
        credential: { credentialId: pendingCredentialId, publicKeyJwk: publicKey.export({ format: 'jwk' }), alg: -7, counter: 0 },
    });
    await flush();
    const cases = [['missing', undefined], ['empty', ''], ['null', null], ['number', 0], ['boolean', false], ['object', {}], ['array', []]];
    let counter = 0;
    for (const [name, challenge] of cases) {
        await t.test(name, async () => {
            const options = await passkeyOptions(user.email);
            const assertion = signedAssertion(options, { counter: counter + 1 });
            assertion.id = pendingCredentialId;
            assertion.rawId = pendingCredentialId;
            const malformed = { ...assertion, response: { ...assertion.response, clientDataJSON: Buffer.from(JSON.stringify({
                type: 'webauthn.get', challenge, origin: baseUrl,
            })).toString('base64url') } };
            const request = { providerState: options.requestId };
            for (const challengeKey of [undefined, options.challengeKey]) {
                assertAuthenticationFailure(await post('/service/auth/passkey/verify', {
                    email: user.email, assertion: malformed, challengeKey, requestId: request.providerState,
                }));
                assert.ok(await store.getAuthChallengeByChallengeId(options.challengeKey), 'invalid client challenge must not consume the pending challenge');
                assert.equal((await store.getAuthMethodByKey(methodKey)).credential.counter, counter);
            }
            const completed = await post('/service/auth/passkey/verify', {
                email: user.email, assertion, challengeKey: options.challengeKey, requestId: request.providerState,
            });
            assert.equal(completed.status, 200, 'the legitimate signed assertion must remain usable');
            assert.equal((await consumeAuthCode({ providerState: request.providerState, code: completed.body.code })).user.id, user.id);
            counter += 1;
        });
    }
});

after(async () => {
    if (server?.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await resetStoreForTests();
});

async function post(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

test('public authentication failures do not reveal sensitive internal reasons', async () => {
    const requests = await Promise.all(Array.from({ length: 6 }, () => createLoginRequest({ redirectUri: `${baseUrl}/auth/callback` })));
    const failures = await Promise.all([
        post('/service/auth/admin/login', { requestId: requests[0].providerState, password: 'wrong-administrator-password' }),
        post('/service/auth/passkey/options', { email: 'missing@example.test', requestId: requests[1].providerState }),
        post('/service/auth/passkey/options', { email: 'blocked@example.test', requestId: requests[2].providerState }),
        post('/service/auth/totp/verify', { email: 'missing@example.test', token: '000000', requestId: requests[3].providerState }),
        post('/service/auth/totp/verify', { email: 'blocked@example.test', token: '000000', requestId: requests[4].providerState }),
    ]);
    for (const failure of failures) {
        assert.equal(failure.status, 401);
        assert.deepEqual(failure.body, { ok: false, error: 'authentication_failed' });
    }
    // Retired password endpoints no longer exist at all.
    for (const path of ['/service/auth/password/login', '/service/auth/register']) {
        assert.equal((await post(path, { email: 'blocked@example.test', password: 'guess-password', requestId: requests[5].providerState })).status, 404);
    }
});
