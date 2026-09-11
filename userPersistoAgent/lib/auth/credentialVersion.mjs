import { createHash } from 'node:crypto';

// Bind a pending proof to the material actually verified, excluding counters
// that advance on ordinary use. Only the digest enters the retained transaction.
export function credentialVersion(method, credential) {
    let material;
    if (method === 'password') material = credential;
    else if (method === 'totp') {
        material = [credential?.secretEncrypted, credential?.algorithm, credential?.digits,
            credential?.periodSeconds, credential?.enabledAt];
    } else if (method === 'passkey') {
        const jwk = credential?.publicKeyJwk || {};
        material = [credential?.credentialId, credential?.alg, credential?.clientDataHash,
            Object.keys(jwk).sort().map((key) => [key, jwk[key]])];
    } else throw new Error('Unsupported credential proof method.');
    return createHash('sha256').update(JSON.stringify([method, material])).digest('hex');
}
