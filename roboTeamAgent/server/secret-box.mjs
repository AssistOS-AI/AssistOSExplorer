import crypto from 'node:crypto';

// Secrets RoboTeam must use itself (proxy provider configuration and proxy credentials) are stored
// sealed with AES-256-GCM. The key comes from ROBOTEAM_VAULT_KEY, a Ploinky generated secret
// derived from the workspace master key, so a copy of /data alone reveals none of them.
export const VAULT_KEY_ENV = 'ROBOTEAM_VAULT_KEY';
const PREFIX = 'rtv1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

export class SecretBox {
    constructor(secret) {
        const material = String(secret || '');
        if (material.length < 16) throw new Error(`${VAULT_KEY_ENV} must contain at least 16 characters`);
        this.key = Buffer.from(crypto.hkdfSync('sha256', material, Buffer.alloc(0), 'roboteam/vault/encryption', 32));
        this.fingerprintKey = Buffer.from(crypto.hkdfSync('sha256', material, Buffer.alloc(0), 'roboteam/vault/fingerprint', 32));
    }

    static isSealed(value) {
        return typeof value === 'string' && value.startsWith(PREFIX);
    }

    seal(plaintext) {
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
        return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    }

    open(sealed) {
        if (!SecretBox.isSealed(sealed)) throw new Error('stored secret is not sealed');
        const packed = Buffer.from(sealed.slice(PREFIX.length), 'base64');
        if (packed.length < IV_BYTES + TAG_BYTES) throw new Error('stored secret is incomplete');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, IV_BYTES));
        decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        try {
            return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
        } catch {
            throw new Error(`stored secret cannot be decrypted; ${VAULT_KEY_ENV} differs from the key it was sealed with`);
        }
    }

    // A keyed digest that finds duplicates without storing the secret or a plain hash of it.
    fingerprint(value) {
        return crypto.createHmac('sha256', this.fingerprintKey).update(String(value)).digest('hex');
    }
}

// Reads the key once and removes it from the environment, so processes this service starts
// (coding agents, tools, Podman) never inherit it.
export function secretBoxFromEnvironment(environment = process.env) {
    const secret = environment[VAULT_KEY_ENV];
    delete environment[VAULT_KEY_ENV];
    return secret ? new SecretBox(secret) : null;
}

export function requireSecretBox(box) {
    if (!box) throw httpError(503, `${VAULT_KEY_ENV} is not configured; RoboTeam cannot store or use secrets`);
    return box;
}
