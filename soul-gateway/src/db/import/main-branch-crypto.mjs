import { createDecipheriv } from 'node:crypto';

const LEGACY_ALGO = 'aes-256-gcm';
const LEGACY_IV_BYTES = 12;
const LEGACY_AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Decode a 32-byte encryption key from hex, base64, or Buffer input.
 *
 * @param {string|Buffer|Uint8Array|null|undefined} raw
 * @param {{ label?: string }} [options]
 * @returns {Buffer|null}
 */
export function decodeEncryptionKey(raw, { label = 'encryption key' } = {}) {
    if (raw == null || raw === '') return null;

    let key;
    if (Buffer.isBuffer(raw)) {
        key = Buffer.from(raw);
    } else if (raw instanceof Uint8Array) {
        key = Buffer.from(raw);
    } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (/^[0-9a-f]{64}$/i.test(trimmed)) {
            key = Buffer.from(trimmed, 'hex');
        } else {
            key = Buffer.from(trimmed, 'base64');
        }
    } else {
        throw new TypeError(`${label} must be a string or Buffer`);
    }

    if (key.length !== KEY_BYTES) {
        throw new Error(`${label} must decode to exactly ${KEY_BYTES} bytes`);
    }

    return key;
}

/**
 * Decrypt the legacy `main` branch AES-GCM blob format:
 *   iv (12 bytes) + auth tag (16 bytes) + ciphertext
 *
 * @param {Buffer|string|null|undefined} blob
 * @param {Buffer} key
 * @returns {string|null}
 */
export function decryptLegacyBlob(blob, key) {
    if (blob == null) return null;

    const value = Buffer.isBuffer(blob)
        ? blob
        : Buffer.from(
              blob,
              typeof blob === 'string' && /^[0-9a-f]+$/i.test(blob)
                  ? 'hex'
                  : undefined
          );

    if (value.length < LEGACY_IV_BYTES + LEGACY_AUTH_TAG_BYTES) {
        throw new Error('Legacy encrypted value is too short');
    }

    const iv = value.subarray(0, LEGACY_IV_BYTES);
    const authTag = value.subarray(
        LEGACY_IV_BYTES,
        LEGACY_IV_BYTES + LEGACY_AUTH_TAG_BYTES
    );
    const ciphertext = value.subarray(LEGACY_IV_BYTES + LEGACY_AUTH_TAG_BYTES);

    const decipher = createDecipheriv(LEGACY_ALGO, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString('utf8');
}

export function resolveSourceEncryptionKey(env = process.env) {
    return decodeEncryptionKey(
        env.SOURCE_ENCRYPTION_KEY_HEX || env.SOURCE_ENCRYPTION_KEY || null,
        { label: 'SOURCE_ENCRYPTION_KEY' }
    );
}

export function resolveTargetEncryptionKey(env = process.env) {
    const key = decodeEncryptionKey(
        env.TARGET_ENCRYPTION_KEY || env.ENCRYPTION_KEY || null,
        { label: 'TARGET_ENCRYPTION_KEY' }
    );

    if (!key) {
        throw new Error('TARGET_ENCRYPTION_KEY or ENCRYPTION_KEY is required');
    }
    return key;
}

export function resolveTargetApiKeyPepper(env = process.env) {
    const pepper =
        env.TARGET_API_KEY_HASH_PEPPER ||
        env.API_KEY_HASH_PEPPER ||
        env.TARGET_ENCRYPTION_KEY ||
        env.ENCRYPTION_KEY ||
        null;

    if (!pepper) {
        throw new Error(
            'TARGET_API_KEY_HASH_PEPPER, API_KEY_HASH_PEPPER, TARGET_ENCRYPTION_KEY, or ENCRYPTION_KEY is required'
        );
    }
    return pepper;
}
