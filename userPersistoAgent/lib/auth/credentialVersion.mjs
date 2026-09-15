import { createHash } from 'node:crypto';

// Bind a pending proof to the material actually verified, excluding counters
// that advance on ordinary use. Only the digest enters the retained transaction.
export function credentialVersion(method, credential) {
    let material;
    if (method === 'totp') {
        material = [credential?.secretEncrypted, credential?.algorithm, credential?.digits,
            credential?.periodSeconds, credential?.enabledAt];
    } else if (method === 'passkey') {
        const jwk = credential?.publicKeyJwk || {};
        material = [credential?.credentialId, credential?.alg, credential?.clientDataHash,
            Object.keys(jwk).sort().map((key) => [key, jwk[key]])];
    } else if (method === 'mailbox') {
        // A sign-in mailbox proof is stale once the address, its verification or
        // the account's credential generation changes.
        material = [credential?.email, credential?.emailVerifiedAt,
            Number.isSafeInteger(credential?.authGeneration) ? credential.authGeneration : 0];
    } else throw new Error('Unsupported credential proof method.');
    return createHash('sha256').update(JSON.stringify([method, material])).digest('hex');
}
