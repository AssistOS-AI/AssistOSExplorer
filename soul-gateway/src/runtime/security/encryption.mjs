/**
 * AES-256-GCM encryption / decryption utilities.
 *
 * The encryption key is a 32-byte Buffer derived from the base64
 * ENCRYPTION_KEY env var.  When no key is configured, one is
 * auto-generated and persisted to DATA_DIR/encryption.key.
 *
 * encrypt() returns Buffers (not hex strings) so the values map
 * cleanly onto Postgres `bytea` columns via node-postgres without any
 * encoding dance. Callers that need to persist the result through a
 * text/JSON channel (e.g. OAuthCredentialStore) must explicitly
 * convert the Buffers to hex on write and back on read.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM recommended nonce length
const KEY_BYTES = 32;

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * @param {string} plaintext
 * @param {Buffer} key  32-byte key
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }}
 */
export function encrypt(plaintext, key) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);

    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return { ciphertext, iv, authTag };
}

/**
 * Decrypt ciphertext encrypted with AES-256-GCM.
 *
 * @param {Buffer} ciphertext
 * @param {Buffer} iv          12-byte GCM nonce
 * @param {Buffer} authTag     16-byte GCM auth tag
 * @param {Buffer} key         32-byte key
 * @returns {string} plaintext
 */
export function decrypt(ciphertext, iv, authTag, key) {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
}

/**
 * Ensure an encryption key is available.
 *
 * Resolution order:
 *   1. config.ENCRYPTION_KEY env var (base64-encoded 32 bytes)
 *   2. Persisted key file at DATA_DIR/encryption.key
 *   3. Generate a new random key and persist it
 *
 * @param {{ ENCRYPTION_KEY: string|null, DATA_DIR: string }} config
 * @returns {Buffer} 32-byte key
 */
export function ensureEncryptionKey(config) {
    // 1. From env
    if (config.ENCRYPTION_KEY) {
        const buf = decodeKey(config.ENCRYPTION_KEY);
        if (buf && buf.length === KEY_BYTES) return buf;
        throw new Error(
            `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`
        );
    }

    // 2. From persisted file
    const keyPath = join(config.DATA_DIR, 'encryption.key');
    try {
        const raw = readFileSync(keyPath, 'utf8').trim();
        const buf = decodeKey(raw);
        if (buf && buf.length === KEY_BYTES) return buf;
    } catch {
        // file doesn't exist — fall through
    }

    // 3. Generate and persist
    const newKey = randomBytes(KEY_BYTES);
    mkdirSync(config.DATA_DIR, { recursive: true });
    writeFileSync(keyPath, newKey.toString('base64') + '\n', { mode: 0o600 });
    return newKey;
}

/**
 * Decode a key string that may be hex or base64 encoded.
 */
function decodeKey(raw) {
    // Try hex first (64 hex chars = 32 bytes)
    if (/^[0-9a-f]{64}$/i.test(raw)) {
        return Buffer.from(raw, 'hex');
    }
    // Try base64
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > 0) return buf;
    return null;
}
