// Browser copy of the password creation rules shared by the sign-in wizard and
// My Account. The server applies the same rules and is authoritative; equality
// with the email and the common-password list are left to it.
const CONTROL_CHARACTERS = /\p{Cc}/u;

export const DEFAULT_PASSWORD_POLICY = Object.freeze({ minLength: 15, maxLength: 128, maxRawLength: 1024 });

// Returns `{ code, reason? }` in the server's error vocabulary, or null.
export function newPasswordProblem(password, confirmation, policy = DEFAULT_PASSWORD_POLICY) {
    if (password.normalize('NFKC') !== confirmation.normalize('NFKC')) return { code: 'password_mismatch' };
    if (!password) return { code: 'invalid_password', reason: 'too_short' };
    if (password.length > policy.maxRawLength) return { code: 'invalid_password', reason: 'too_long' };
    if (typeof password.isWellFormed === 'function' && !password.isWellFormed()) return { code: 'invalid_password', reason: 'invalid_characters' };
    const normalized = password.normalize('NFKC');
    if (CONTROL_CHARACTERS.test(normalized)) return { code: 'invalid_password', reason: 'invalid_characters' };
    const length = [...normalized].length;
    if (length < policy.minLength) return { code: 'invalid_password', reason: 'too_short' };
    if (length > policy.maxLength) return { code: 'invalid_password', reason: 'too_long' };
    return null;
}

export function passwordReasonMessage(reason, policy = DEFAULT_PASSWORD_POLICY) {
    if (reason === 'too_short') return `Use at least ${policy.minLength} characters.`;
    if (reason === 'too_long') return `Use at most ${policy.maxLength} characters.`;
    if (reason === 'invalid_characters') return 'Remove control characters or unsupported symbols from the password.';
    return 'Choose a password that is harder to guess.';
}
