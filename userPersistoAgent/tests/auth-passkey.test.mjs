import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-passkey-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
process.env.USERPERSISTO_AUTH_METHODS = 'password,passkey';
process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = 'https://example.test';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser } = await import('../lib/users.mjs');
const passkey = await import('../lib/auth/passkey.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('passkey options pin an allow-listed origin and matching relying-party id', async () => {
    await ensureSeedData();
    const user = await createUser({ email: 'passkey@x.com', roles: ['user'] });
    const result = await passkey.registrationOptions({
        userId: user.id,
        origin: 'https://example.test',
        rpId: 'example.test',
    });
    assert.equal(result.ok, true);
    assert.equal(result.publicKey.rp.id, 'example.test');

    await assert.rejects(
        () => passkey.registrationOptions({ userId: user.id, origin: 'https://evil.test', rpId: 'evil.test' }),
        (error) => error?.code === 'browser_origin_not_allowed'
    );
    await assert.rejects(
        () => passkey.registrationOptions({ userId: user.id, origin: 'https://example.test', rpId: 'other.test' }),
        (error) => error?.code === 'invalid_webauthn_rp_id'
    );
});

function cbor(value) {
    const head = (major, length) => length < 24 ? Buffer.from([(major << 5) | length])
        : length < 256 ? Buffer.from([(major << 5) | 24, length])
            : Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
    if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

test('credential replacement between passkey validation and save invalidates enrollment', async () => {
    const { getStore, setStoreFaultInjectorForTests, commitStagedPersistence } = await import('../lib/store.mjs');
    const { serializePersisted } = await import('../lib/serial.mjs');
    const { stageCredentialGenerationAdvance } = await import('../lib/auth/generation.mjs');
    const user = await createUser({ email: 'passkey-interleaved@example.test', roles: ['user'] });
    const origin = 'https://example.test';
    const options = await passkey.registrationOptions({ userId: user.id, origin, generation: 0 });
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const id = randomBytes(24);
    const authData = Buffer.concat([createHash('sha256').update('example.test').digest(), Buffer.from([0x45]),
        Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
    const attestation = {
        id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key',
        response: {
            clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.publicKey.challenge, origin })).toString('base64url'),
            attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url'),
        },
    };
    const independent = new AsyncResource('concurrent-passkey-generation');
    let advanced;
    setStoreFaultInjectorForTests((phase, method, args) => {
        if (!advanced && phase === 'after' && method === 'select' && args[0] === 'authMethod') {
            advanced = independent.runInAsyncScope(() => serializePersisted('users', () =>
                commitStagedPersistence(() => stageCredentialGenerationAdvance(user.id))));
        }
    });
    try {
        const result = await passkey.registrationVerify({ userId: user.id, origin, challengeKey: options.challengeKey, attestation });
        await advanced;
        assert.ok(advanced, 'the replacement must occur at the validation boundary');
        assert.equal(result.ok, false, 'validated old-generation enrollment cannot commit after replacement');
        assert.equal((await (await getStore()).getAuthMethodsObjectsByUserId(user.id)).length, 0);
    } finally {
        setStoreFaultInjectorForTests();
        independent.emitDestroy();
    }
});
