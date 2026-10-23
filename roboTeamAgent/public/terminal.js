const IDENTIFIER = /^[A-Za-z0-9_-]{32,128}$/;

function csrfToken(cookie) {
    return String(cookie).split(';').map(part => part.trim()).find(part => part.startsWith('ploinky_browser_csrf='))?.slice('ploinky_browser_csrf='.length) || '';
}

const PROVIDER = 'roboTeamAgent';
const UNAVAILABLE_REASONS = Object.freeze({
    'home-unreachable': 'This RoboTeam terminal cannot see the robot\'s home folder.',
    'home-read-only': 'This RoboTeam terminal can only read the robot\'s home folder.',
});

// The robot is chosen by the card that was clicked. The router resolves its
// home as a profile, so the browser sends only the robot id, never a HOME path.
export async function discoverRobotTerminal(directory, id, { fetchImpl = fetch, cookie = document.cookie } = {}) {
    const headers = { 'content-type': 'application/json', 'x-ploinky-browser-csrf-token': csrfToken(cookie) };
    const response = await fetchImpl('/webtty/target-discoveries', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({ dir: directory, profile: { provider: PROVIDER, id } }), signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    const discovery = payload?.discovery;
    if (!response.ok || !payload.ok || !IDENTIFIER.test(discovery?.id || '')) {
        throw new Error('WebTTY discovery failed. Administrator access, an active Ploinky router and an available robot home are required.');
    }
    const cancel = () => fetchImpl(`/webtty/target-discoveries/${discovery.id}`, {
        method: 'DELETE', credentials: 'same-origin', headers, keepalive: true,
    }).catch(() => {});
    const rows = Array.isArray(discovery.targets) ? discovery.targets.filter(target =>
        target.kind === 'agent' && target.detail === 'AchillesIDE/roboTeamAgent') : [];
    // Exactly one writable RoboTeam row must exist, and that row must carry a launch.
    const writable = rows.filter(target => target.access === 'rw');
    const matches = writable.length === 1 && IDENTIFIER.test(writable[0].launch || '') ? writable : [];
    // Never launch a terminal the router did not bind to this robot.
    const bound = discovery.profile?.provider === PROVIDER && discovery.profile.id === id;
    if (discovery.directory !== directory || !Number.isSafeInteger(discovery.expiresAt) || discovery.expiresAt <= Date.now()
        || !bound || matches.length !== 1) {
        await cancel();
        const reason = bound && rows.length === 1 ? UNAVAILABLE_REASONS[rows[0].unavailable] : '';
        throw new Error(reason || 'No unique running RoboTeam terminal is available for this robot home.');
    }
    return { url: `/webtty/#launch=${encodeURIComponent(matches[0].launch)}`, cancel };
}

export async function openRobotTerminal(robot, api, { windowRef = window, discover = discoverRobotTerminal } = {}) {
    const popup = windowRef.open('about:blank', '_blank');
    if (!popup) throw new Error('Allow popups to open the robot terminal.');
    let launch;
    try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error('Could not isolate the terminal window.');
        popup.document.title = `${robot.name} terminal`;
        popup.document.body.textContent = 'Opening robot terminal…';
        const result = await api(`api/terminal-profiles/${robot.id}/prepare`, { method: 'POST', body: {} });
        if (result?.id !== robot.id || typeof result.root !== 'string' || !result.root) throw new Error('RoboTeam returned an unexpected terminal home.');
        launch = await discover(result.root, robot.id);
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
        console.error('Robot terminal failed:', error);
        if (!popup.closed) {
            try {
                popup.document.title = 'Robot terminal could not open';
                popup.document.body.textContent = `${error.message}\n\nClose this tab and retry Open Terminal from RoboTeam.`;
            } catch (_) { /* The parent page still reports errors if the popup navigated away. */ }
        }
        throw error;
    }
}
