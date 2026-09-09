const IDENTIFIER = /^[A-Za-z0-9_-]{32,128}$/;

function csrfToken(cookie) {
    return String(cookie).split(';').map(part => part.trim()).find(part => part.startsWith('ploinky_browser_csrf='))?.slice('ploinky_browser_csrf='.length) || '';
}

export async function discoverRobotTerminal(directory, { fetchImpl = fetch, cookie = document.cookie } = {}) {
    const headers = { 'content-type': 'application/json', 'x-ploinky-browser-csrf-token': csrfToken(cookie) };
    const response = await fetchImpl('/webtty/target-discoveries', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({ dir: directory }), signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    const discovery = payload?.discovery;
    if (!response.ok || !payload.ok || !IDENTIFIER.test(discovery?.id || '')) {
        throw new Error('WebTTY discovery failed. Administrator access and an active Ploinky router are required.');
    }
    const cancel = () => fetchImpl(`/webtty/target-discoveries/${discovery.id}`, {
        method: 'DELETE', credentials: 'same-origin', headers, keepalive: true,
    }).catch(() => {});
    const matches = Array.isArray(discovery.targets) ? discovery.targets.filter(target =>
        target.kind === 'agent' && target.detail === 'AchillesCLI/roboTeamAgent' && target.access === 'rw') : [];
    if (discovery.directory !== directory || !Number.isSafeInteger(discovery.expiresAt) || discovery.expiresAt <= Date.now()
        || matches.length !== 1 || !IDENTIFIER.test(matches[0]?.launch || '')) {
        await cancel();
        throw new Error('No unique running RoboTeam terminal is available for this robot home.');
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
        const result = await api(`api/robots/${robot.id}/terminal`, { method: 'POST', body: {} });
        launch = await discover(result.directory);
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
        if (!popup.closed) {
            try {
                popup.document.title = 'Robot terminal could not open';
                popup.document.body.textContent = `${error.message}\n\nClose this tab and retry Open Terminal from RoboTeam.`;
            } catch (_) { /* The parent page still reports errors if the popup navigated away. */ }
        }
        throw error;
    }
}
