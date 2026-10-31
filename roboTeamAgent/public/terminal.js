const IDENTIFIER = /^[A-Za-z0-9_-]{32,128}$/;
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function csrfToken(cookie) {
    return String(cookie).split(';').map(part => part.trim()).find(part => part.startsWith('ploinky_browser_csrf='))?.slice('ploinky_browser_csrf='.length) || '';
}

// Robot terminals (RoboWork M-8, M-51, M-54). A robot terminal is a shell the robo-work worker starts in that robot's own sandbox (its
// HOME, its masks, its network rules); only a verified direct administrator may open one. The card asks RoboTeam for the robot's
// WORKER robot ID (`robot.worker.robotId`, never RoboTeam's own robot ID), which also makes sure the robot is set up and ready on the
// worker, then asks the Ploinky WebTTY for its terminal targets and opens the one provider target with that ID. Without a folder the
// terminal starts in the robot's HOME. The browser never sends a path, a profile or a robot HOME.

// Plain sentences for the refusals a user can act on. Anything else shows its own message or a generic one.
const PLAIN = Object.freeze({
    forbidden: 'Robot terminals are available to administrators only.',
    owner_evidence_unavailable: 'Sign in again as an administrator to open a robot terminal.',
    worker_coordinator_unavailable: 'The robot worker is not available right now. Try again later.',
    worker_unreachable: 'The robot worker is not available right now. Try again later.',
    worker_route_unavailable: 'The robot worker is not available right now. Try again later.',
    worker_reply_unknown: 'The robot worker did not answer. Try again.',
    worker_robot_not_ready: 'The robot is not ready yet. Try again in a moment.',
    worker_robot_failed: 'The robot could not be prepared on the worker, so no terminal can open.',
    not_found: 'This robot no longer exists.',
});

export function terminalFailureMessage(error) {
    if (typeof error?.detail === 'string' && error.detail) return error.detail;
    return PLAIN[error?.code] || PLAIN[error?.message] || (typeof error?.message === 'string' && error.message) || 'The robot terminal could not open.';
}

async function workerCall(api, route, robot) {
    try {
        return await api(route, { method: 'POST', body: { robotId: robot.id } });
    } catch (error) {
        const code = error?.code || error?.message;
        throw Object.assign(new Error(terminalFailureMessage({ code, message: error?.message, detail: error?.detail })), { code });
    }
}

// The worker robot ID of a RoboTeam robot and the label the worker's inventory shows for it, for an administrator (RoboTeam runs the same
// ensure as any administrator use first). Returns { targetId, label }.
export async function robotTerminalTarget(robot, api) {
    const result = await workerCall(api, 'api/worker/robots/terminal-target', robot);
    if (result?.ok !== true || typeof result.targetId !== 'string' || !TARGET_ID.test(result.targetId)
        || typeof result.label !== 'string' || !result.label || result.label.length > 128
        || typeof result.provider !== 'string' || !PROVIDER.test(result.provider)) throw new Error('RoboTeam returned an unexpected robot terminal target.');
    return { targetId: result.targetId, label: result.label, provider: result.provider };
}

// M-54 Close terminals: every open terminal of the robot ends through the worker's normal shutdown path. Returns { closed, unverified }.
export async function closeRobotTerminals(robot, api) {
    const result = await workerCall(api, 'api/worker/robots/terminals/close', robot);
    return { closed: Number.isSafeInteger(result?.closed) ? result.closed : 0, unverified: Number.isSafeInteger(result?.unverified) ? result.unverified : 0 };
}

// Discovers the WebTTY targets for `directory` ('' = no folder: the robot terminal starts in HOME) and picks exactly the provider row of
// `target.targetId` (the worker robot ID) served by `target.provider` (the worker's route key; another terminal provider may advertise the
// same id). A row is bound ONLY by both: a label can name another robot (two robots with one name,
// or the chosen robot dropping out of the inventory between the ensure and the discovery), and a shell in the wrong robot's HOME is the
// harm robot terminals exist to prevent. Rows without targetId therefore refuse. Returns { url, cancel }.
export async function discoverRobotTerminal(directory, target, { fetchImpl = fetch, cookie = document.cookie } = {}) {
    const headers = { 'content-type': 'application/json', 'x-ploinky-browser-csrf-token': csrfToken(cookie) };
    const response = await fetchImpl('/webtty/target-discoveries', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({ dir: directory }), signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    const discovery = payload?.discovery;
    if (!response.ok || !payload.ok || !IDENTIFIER.test(discovery?.id || '')) {
        throw new Error(response.status === 403 ? PLAIN.forbidden : 'The terminal targets could not be loaded. An active Ploinky router is required.');
    }
    const cancel = () => fetchImpl(`/webtty/target-discoveries/${discovery.id}`, {
        method: 'DELETE', credentials: 'same-origin', headers, keepalive: true,
    }).catch(() => {});
    const providerRows = Array.isArray(discovery.targets) ? discovery.targets.filter(row => row?.kind === 'provider' && IDENTIFIER.test(row.launch || '')) : [];
    const rows = providerRows.filter(row => typeof row.targetId === 'string' && row.targetId === target.targetId && row.provider === target.provider);
    if (providerRows.length > 0 && !providerRows.some(row => typeof row.targetId === 'string')) {
        await cancel();
        throw new Error('This Ploinky router does not identify robot terminals, so this robot\'s terminal cannot be opened safely. Ask an administrator to update Ploinky.');
    }
    if (discovery.directory !== directory || !Number.isSafeInteger(discovery.expiresAt) || discovery.expiresAt <= Date.now() || rows.length !== 1) {
        await cancel();
        const unavailable = Array.isArray(discovery.providers) ? discovery.providers.find(entry => entry?.available === false) : null;
        throw new Error(unavailable
            ? 'Robot terminals are unavailable right now: the robot worker is not running or not reachable.'
            : 'This robot has no terminal available right now. Check that it is ready, then try again.');
    }
    return { url: `/webtty/#launch=${encodeURIComponent(rows[0].launch)}`, cancel };
}

export async function openRobotTerminal(robot, api, { windowRef = window, discover = discoverRobotTerminal, target = robotTerminalTarget } = {}) {
    const popup = windowRef.open('about:blank', '_blank');
    if (!popup) throw new Error('Allow popups to open the robot terminal.');
    let launch;
    try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error('Could not isolate the terminal window.');
        popup.document.title = `${robot.name} terminal`;
        popup.document.body.textContent = 'Opening robot terminal…';
        const chosen = await target(robot, api);
        launch = await discover('', chosen);
        if (popup.closed) throw new Error('Terminal window was closed.');
        const anchor = popup.document.createElement('a');
        anchor.href = launch.url;
        anchor.rel = 'noopener noreferrer';
        anchor.referrerPolicy = 'no-referrer';
        anchor.target = '_self';
        popup.document.body.appendChild(anchor);
        anchor.click();
    } catch (error) {
        await launch?.cancel();
        console.error('Robot terminal failed:', error?.message);
        if (!popup.closed) {
            try {
                popup.document.title = 'Robot terminal could not open';
                popup.document.body.textContent = `${error.message}\n\nClose this tab and retry Terminal from RoboTeam.`;
            } catch (_) { /* The parent page still reports errors if the popup navigated away. */ }
        }
        throw error;
    }
}
