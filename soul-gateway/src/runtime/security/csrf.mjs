/**
 * CSRF token generation and verification.
 */

import { randomBytes } from 'node:crypto';
import { HEADER_NAMES } from '../../core/constants.mjs';
import { BadRequestError } from '../../core/errors.mjs';

const TOKEN_BYTES = 32;

/**
 * Generate a random hex CSRF token.
 * @returns {string} 64-character hex string
 */
export function generateCsrfToken() {
    return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Verify the CSRF token submitted in the request matches the one
 * stored in the session.
 *
 * @param {{ headers: Record<string,string>, session?: { csrfToken?: string } }} reqCtx
 *   Must have `headers['x-csrf-token']` and `session.csrfToken`.
 * @returns {boolean} true when valid
 * @throws {Error} if token is missing or mismatched
 */
export function verifyCsrf(reqCtx) {
    const headerToken = reqCtx.headers?.[HEADER_NAMES.X_CSRF_TOKEN];
    const sessionToken = reqCtx.session?.csrfToken;

    if (!headerToken) {
        throw new BadRequestError('Missing CSRF token header');
    }
    if (!sessionToken) {
        throw new BadRequestError('No CSRF token in session');
    }
    if (headerToken !== sessionToken) {
        throw new BadRequestError('CSRF token mismatch');
    }

    return true;
}

/**
 * Enforce CSRF validation for a state-changing admin request.
 *
 * @param {{ headers: Record<string,string>, session?: { csrfToken?: string } }} reqCtx
 * @returns {boolean}
 * @throws {BadRequestError} when the submitted header is missing/mismatched
 */
export function verifyRequiredCsrf(reqCtx) {
    return verifyCsrf(reqCtx);
}
