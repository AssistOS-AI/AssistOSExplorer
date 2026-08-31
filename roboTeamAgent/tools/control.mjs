import process from 'node:process';

async function readPayload() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw || '{}');
}

function authenticatedUserId(payload) {
    const id = String(payload?.metadata?.user?.id || payload?.metadata?.user?.sub || '').trim();
    if (!id) throw new Error('authenticated user identity is required');
    return id;
}

async function request(pathname, { method = 'GET', body, userId }) {
    const port = Number(process.env.ROBOTEAM_SERVICE_PORT || process.env.PORT || 7000);
    const token = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');
    if (!token) throw new Error('RoboTeam internal token is unavailable');
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
            'content-type': 'application/json',
            'x-roboteam-internal-token': token,
            'x-roboteam-user-id': userId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(55000),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid service response' }));
    if (!response.ok) throw new Error(result.error || `RoboTeam request failed with ${response.status}`);
    return result;
}

const operation = process.argv[2] || '';
const payload = await readPayload();
const input = payload.input || {};
const userId = authenticatedUserId(payload);

let result;
if (operation === 'profile-create') {
    result = await request('/api/profiles', { method: 'POST', body: { name: input.name, specialization: input.specialization || '' }, userId });
} else if (operation === 'profile-list') {
    result = await request('/api/profiles', { userId });
} else if (operation === 'desktop-start') {
    result = await request(`/api/profiles/${encodeURIComponent(input.profileId || '')}/desktop/start`, { method: 'POST', body: {}, userId });
} else if (operation === 'desktop-stop') {
    result = await request(`/api/profiles/${encodeURIComponent(input.profileId || '')}/desktop/stop`, { method: 'POST', body: {}, userId });
} else {
    throw new Error('unsupported RoboTeam control operation');
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
