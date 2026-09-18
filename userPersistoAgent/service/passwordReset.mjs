import { assertSameOrigin, rateSourceOf } from '../lib/auth/browserBinding.mjs';
import { completePasswordReset, inspectPasswordReset } from '../lib/auth/passwordReset.mjs';

// Parentless reset endpoints. The emailed token is the only authority: there
// is no login request, no browser proof and no ambient cookie, so a cross-site
// request has nothing to ride on. `assertSameOrigin` still refuses a forged
// browser origin; a request without one is not a browser request.
const STATUS = '/service/auth/password/reset/status';
const COMPLETE = '/service/auth/password/reset';

function tokenField(body) {
    const value = body?.token;
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 256) {
        throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', statusCode: 400 });
    }
    return value;
}

export function isPasswordResetRoute(path) {
    return path === STATUS || path === COMPLETE;
}

export function createPasswordResetHandlers() {
    async function handle(req, res, path, body, sendJson) {
        if (!isPasswordResetRoute(path)) return false;
        assertSameOrigin(req);
        const rateSource = rateSourceOf(req);
        if (path === STATUS) {
            const inspected = await inspectPasswordReset({ token: tokenField(body), rateSource });
            return sendJson(res, 200, { ok: true, ...inspected });
        }
        // Passwords pass through unmodified; the domain bounds and validates them.
        const result = await completePasswordReset({ token: tokenField(body), password: body?.password,
            passwordConfirmation: body?.passwordConfirmation, rateSource });
        return sendJson(res, 200, { ...result });
    }
    return { handle };
}
