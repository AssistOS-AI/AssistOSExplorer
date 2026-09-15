import { createHmac, timingSafeEqual } from 'node:crypto';

// Keyed code hashing shared by bound email challenges (`emailAttempts.mjs`),
// Google mailbox/link proofs and account operation grants. Challenges live in
// their bound transactions; there is no unbound email-code login surface.
export function hashCode(code, challengeId) {
    const key = process.env.USERPERSISTO_SETTINGS_KEY || '';
    if (!key) {
        throw new Error('USERPERSISTO_SETTINGS_KEY is required to hash auth codes.');
    }
    return createHmac('sha256', key).update(`${challengeId}:${code}`).digest('base64url');
}

export function codeHashMatches(code, challengeId, expectedHash) {
    const actual = Buffer.from(hashCode(code, challengeId));
    const expected = Buffer.from(String(expectedHash || ''));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
