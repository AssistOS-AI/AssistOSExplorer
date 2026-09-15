import { createCipheriv, createDecipheriv, createHash, createPrivateKey, generateKeyPair, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { getStore, flush } from '../store.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';

const generateKeyPairAsync = promisify(generateKeyPair);
const SETTING_KEY = 'oidc.signing-material.v1';

function secretError(code) {
    return Object.assign(new Error('OIDC encrypted storage is unavailable. Check the retained settings key and backup.'), { code, statusCode: 503 });
}

function encryptionKey() {
    const raw = process.env.USERPERSISTO_SETTINGS_KEY;
    if (typeof raw !== 'string' || !raw.length) throw secretError('oidc_storage_key_unavailable');
    return createHash('sha256').update('userpersisto:oidc:storage:v1\0').update(raw).digest();
}

export function encryptOidcPayload(value, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(String(context)));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptOidcPayload(blob, context) {
    const key = encryptionKey();
    try {
        const parts = typeof blob === 'string' ? blob.split('.') : [];
        if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('invalid ciphertext');
        const [, iv, tag, data] = parts.map((part, index) => index ? Buffer.from(part, 'base64url') : part);
        if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid ciphertext');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(String(context)));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    } catch {
        throw secretError('oidc_storage_decryption_failed');
    }
}

function validateKeys(material) {
    try {
        const keys = material?.jwks?.keys;
        if (!Array.isArray(keys) || keys.length !== 1 || !Array.isArray(material.cookieKeys) || material.cookieKeys.length < 2) throw new Error('invalid keys');
        const [jwk] = keys;
        if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || !jwk.kid || !jwk.d) throw new Error('invalid signing key');
        const key = createPrivateKey({ key: jwk, format: 'jwk' });
        if (key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('invalid signing key');
        if (material.cookieKeys.some((value) => typeof value !== 'string' || value.length < 43)) throw new Error('invalid cookie keys');
        return material;
    } catch {
        throw secretError('oidc_storage_decryption_failed');
    }
}

export async function getOrCreateOidcKeys() {
    return withPersistenceScope(async () => {
        encryptionKey();
        const store = await getStore();
        const existing = await store.getSystemSettingByKey(SETTING_KEY);
        if (existing) return validateKeys(decryptOidcPayload(existing.value, SETTING_KEY));
        // A missing key row must not silently re-key an existing OIDC database.
        const records = await store.select('oidcRecord', {}, { start: 0, pageSize: 1 });
        if (records.objects?.length) throw secretError('oidc_signing_keys_missing');
        const { privateKey } = await generateKeyPairAsync('rsa', { modulusLength: 2048 });
        const jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: randomBytes(16).toString('base64url') };
        const material = { jwks: { keys: [jwk] }, cookieKeys: [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')] };
        await store.createSystemSetting({ key: SETTING_KEY, value: encryptOidcPayload(material, SETTING_KEY), updatedAt: new Date().toISOString(), updatedBy: 'system' });
        await flush();
        return material;
    });
}
