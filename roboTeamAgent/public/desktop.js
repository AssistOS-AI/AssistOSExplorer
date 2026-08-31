const config = globalThis.ROBOTEAM_CONFIG || {};
const basePath = config.publicBasePath || './';
const routeKey = config.routeKey || 'roboTeamAgent';
const profileId = new URLSearchParams(location.search).get('profile') || '';
const screen = document.querySelector('#desktopScreen');
const placeholder = document.querySelector('#desktopPlaceholder');
const connectionState = document.querySelector('#connectionState');
const desktopName = document.querySelector('#desktopName');
const stopButton = document.querySelector('#stopButton');
const fullscreenButton = document.querySelector('#fullscreenButton');
const backLink = document.querySelector('#backLink');

function endpoint(relativePath) {
    return new URL(relativePath.replace(/^\/+/, ''), new URL(basePath, location.origin)).toString();
}

async function browserMutationToken() {
    const tokenUrl = new URL('/auth/token', location.origin);
    tokenUrl.searchParams.set('mutationRoute', routeKey);
    const response = await fetch(tokenUrl, { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.browserMutation?.csrfToken) throw new Error('Ploinky mutation proof is unavailable');
    return payload.browserMutation.csrfToken;
}

async function api(relativePath, options = {}) {
    const headers = new Headers({ accept: 'application/json', ...(options.headers || {}) });
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        headers.set('content-type', 'application/json');
        headers.set('x-ploinky-browser-csrf-token', await browserMutationToken());
    }
    const response = await fetch(endpoint(relativePath), {
        ...options,
        method,
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
}

function updateConnection(label, state) {
    connectionState.textContent = label;
    connectionState.className = `desktop-state state-${state}`;
}

async function connect() {
    if (!profileId) throw new Error('Profile id is missing from the desktop URL');
    const status = await api(`api/profiles/${profileId}/desktop`);
    desktopName.textContent = status.profile.name;
    document.title = `${status.profile.name} — RoboTeam Desktop`;
    if (status.profile.desktop.state !== 'running') {
        updateConnection('Starting', 'starting');
        await api(`api/profiles/${profileId}/desktop/start`, { method: 'POST', body: {} });
    }

    const moduleUrl = endpoint('vendor/novnc/core/rfb.js');
    const { default: RFB } = await import(moduleUrl);
    const socketUrl = new URL(endpoint(`api/profiles/${profileId}/desktop/ws`));
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(screen, socketUrl.toString(), { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.background = '#10151c';
    rfb.addEventListener('connect', () => {
        placeholder.hidden = true;
        updateConnection('Connected', 'running');
        screen.focus();
    });
    rfb.addEventListener('disconnect', (event) => {
        placeholder.hidden = false;
        placeholder.querySelector('p').textContent = event.detail.clean ? 'Desktop disconnected.' : 'Desktop connection was interrupted.';
        updateConnection('Disconnected', 'stopped');
    });
    rfb.addEventListener('credentialsrequired', () => updateConnection('Credentials required', 'starting'));
    return rfb;
}

backLink.href = endpoint('');
fullscreenButton.addEventListener('click', () => screen.requestFullscreen?.());
stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    try {
        await api(`api/profiles/${profileId}/desktop/stop`, { method: 'POST', body: {} });
        updateConnection('Stopped', 'stopped');
        location.href = endpoint('');
    } catch (error) {
        updateConnection(error.message, 'stopped');
        stopButton.disabled = false;
    }
});

try {
    await connect();
} catch (error) {
    placeholder.querySelector('p').textContent = error.message;
    updateConnection('Unavailable', 'stopped');
}
