/**
 * Compatibility responses for the removed Soul Gateway dashboard login API.
 */

import { sendJson } from '../core/responses.mjs';

const GONE = 410;

function sendPloinkyAuthRequired(res) {
    sendJson(res, GONE, {
        ok: false,
        error: {
            message: 'Soul Gateway management uses Ploinky login.',
            type: 'ploinky_auth_required',
            detail: {
                loginPath: '/auth/login',
            },
        },
    });
}

export async function handleLogin({ res }) {
    sendPloinkyAuthRequired(res);
}

export async function handleLogout({ res }) {
    sendPloinkyAuthRequired(res);
}

export async function handleSession({ res }) {
    sendPloinkyAuthRequired(res);
}
