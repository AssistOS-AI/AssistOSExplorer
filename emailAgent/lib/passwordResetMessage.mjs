// Content for `email_send_password_reset`. The link is built by UserPersisto
// from a freshly validated origin and is carried in the URL fragment, so it
// never reaches a server access log. EmailAgent validates the shape, never
// logs the URL and never returns it to the caller.
const RESET_URL_MAX = 2048;
const DEFAULT_EXPIRY_MINUTES = 30;
const ADVICE = 'If you did not ask for this, ignore this message; your password stays unchanged.';

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function assertResetUrl(value) {
    if (typeof value !== 'string' || !value.length || value.length > RESET_URL_MAX) throw new Error('resetUrl is invalid.');
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('resetUrl is invalid.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('resetUrl is invalid.');
    return value;
}

export function passwordResetMessage({ resetUrl, expiresInMinutes = DEFAULT_EXPIRY_MINUTES } = {}) {
    assertResetUrl(resetUrl);
    const minutes = Number.isSafeInteger(expiresInMinutes) && expiresInMinutes > 0 ? expiresInMinutes : DEFAULT_EXPIRY_MINUTES;
    return {
        subject: 'Reset your password',
        text: `We received a request to reset your password. Open this link to choose a new one:\n\n${resetUrl}\n\n`
            + `The link expires in ${minutes} minutes and can be used once. ${ADVICE}`,
        html: '<p>We received a request to reset your password. Open this link to choose a new one:</p>'
            + `<p><a href="${escapeHtml(resetUrl)}">Choose a new password</a></p>`
            + `<p>The link expires in ${minutes} minutes and can be used once. ${ADVICE}</p>`,
    };
}
