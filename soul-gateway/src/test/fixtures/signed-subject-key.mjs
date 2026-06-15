/**
 * Test fixture: mint Ploinky-compatible signed-subject API keys.
 *
 * Byte-compatible with the production signer
 * (ploinky/cli/services/soulGatewaySubjectKey.js): the key is
 * `<subjectId>|<base64url(ed25519(subjectId))>` and the public key is the raw
 * 32-byte Ed25519 key as base64url (no padding), exactly what the gateway
 * verifier expects in PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY.
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

/**
 * Generate an Ed25519 keypair and return a signer plus the encoded public key.
 *
 * @returns {{
 *   publicKeyBase64url: string,
 *   sign: (subjectId: string) => string,
 *   makeKey: (subjectId: string) => string,
 * }}
 */
export function makeSignedSubjectSigner() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // jwk.x is already the base64url of the raw 32-byte key (no padding).
    const publicKeyBase64url = publicKey.export({ format: 'jwk' }).x;

    function sign(subjectId) {
        return edSign(null, Buffer.from(subjectId, 'utf8'), privateKey).toString(
            'base64url'
        );
    }

    function makeKey(subjectId) {
        return `${subjectId}|${sign(subjectId)}`;
    }

    return { publicKeyBase64url, sign, makeKey };
}

/**
 * One-shot helper: keypair + a key for `subjectId`.
 *
 * @param {string} subjectId
 * @returns {{ apiKey: string, subjectId: string, publicKeyBase64url: string, sign: Function }}
 */
export function makeSignedSubjectKey(subjectId) {
    const signer = makeSignedSubjectSigner();
    return {
        apiKey: signer.makeKey(subjectId),
        subjectId,
        publicKeyBase64url: signer.publicKeyBase64url,
        sign: signer.sign,
    };
}
