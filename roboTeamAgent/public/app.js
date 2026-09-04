const config = globalThis.ROBOTEAM_CONFIG || {};
const basePath = config.publicBasePath || './';
const routeKey = config.routeKey || 'roboTeamAgent';
const robotsList = document.querySelector('#robotsList');
const robotTemplate = document.querySelector('#robotTemplate');
const robotCount = document.querySelector('#robotCount');
const createForm = document.querySelector('#createForm');
const formMessage = document.querySelector('#formMessage');
const refreshButton = document.querySelector('#refreshButton');
const logPollers = new Set();

function endpoint(relativePath) {
    return new URL(relativePath.replace(/^\/+/, ''), new URL(basePath, location.origin)).toString();
}

async function browserMutationToken() {
    const tokenUrl = new URL('/auth/token', location.origin);
    tokenUrl.searchParams.set('mutationRoute', routeKey);
    const response = await fetch(tokenUrl, { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const proof = payload.browserMutation;
    if (!response.ok || !proof?.csrfToken || proof.routeKey !== routeKey) throw new Error('Could not obtain the Ploinky browser mutation proof.');
    return proof.csrfToken;
}

async function api(relativePath, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('accept', 'application/json');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-ploinky-browser-csrf-token', await browserMutationToken());
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

function initials(name) {
    return String(name || 'R').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function showError(error) {
    formMessage.textContent = error.message;
    formMessage.className = 'message error';
}

function sessionUrl(run) {
    return new URL(String(run.sessionUrl || '').replace(/^\/+/, ''), location.origin).toString();
}

function openPendingSession(robot, mode) {
    const sessionWindow = window.open('', `_roboteam_${robot.id}`);
    if (!sessionWindow) return null;
    sessionWindow.opener = null;
    sessionWindow.document.title = `Starting ${robot.name}`;
    sessionWindow.document.body.textContent = `Starting ${mode} session for ${robot.name}…`;
    return sessionWindow;
}

function navigateToSession(sessionWindow, run) {
    const url = sessionUrl(run);
    if (sessionWindow && !sessionWindow.closed) sessionWindow.location.replace(url);
    else window.location.assign(url);
}

function reportSessionFailure(sessionWindow, error) {
    if (!sessionWindow || sessionWindow.closed) return;
    sessionWindow.document.title = 'RoboTeam session failed';
    sessionWindow.document.body.textContent = error.message;
}

function clearLogPollers() {
    for (const poller of logPollers) clearInterval(poller);
    logPollers.clear();
}

async function startRobot(robot, mode, button) {
    const sessionWindow = openPendingSession(robot, mode);
    button.disabled = true;
    try {
        const result = await api(`api/robots/${robot.id}/run`, { method: 'POST', body: { mode } });
        navigateToSession(sessionWindow, result.robot.run);
        await loadRobots();
    } catch (error) {
        reportSessionFailure(sessionWindow, error);
        showError(error);
    } finally {
        button.disabled = false;
    }
}

async function stopRobot(robot, button) {
    button.disabled = true;
    button.textContent = `Stopping ${robot.run.mode === 'desktop' ? 'Desktop' : 'Browser'}…`;
    try {
        await api(`api/robots/${robot.id}/run`, { method: 'DELETE' });
        await loadRobots();
    } catch (error) {
        showError(error);
        button.textContent = robot.run.mode === 'desktop' ? 'Stop Desktop' : 'Stop Browser';
        button.disabled = false;
    }
}

function renderRobots(robots) {
    clearLogPollers();
    robotsList.replaceChildren();
    robotCount.textContent = `${robots.length} ${robots.length === 1 ? 'robot' : 'robots'}`;
    if (!robots.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<h3>No robots yet</h3><p>Create the first persistent robot above.</p>';
        robotsList.append(empty);
        return;
    }
    for (const robot of robots) {
        const card = robotTemplate.content.firstElementChild.cloneNode(true);
        card.querySelector('.avatar').textContent = initials(robot.name);
        card.querySelector('h3').textContent = robot.name;
        card.querySelector('.specialization').textContent = robot.specialization || 'General-purpose robot';
        card.querySelector('.robot-id').textContent = robot.id;
        const state = card.querySelector('.run-state');
        state.textContent = robot.run.mode ? `${robot.run.state} · ${robot.run.mode}` : robot.run.state;
        state.classList.add(`state-${robot.run.state}`);
        const running = robot.run.state !== 'stopped';
        const ready = robot.run.state === 'running' && robot.run.sessionUrl;
        const browserButton = card.querySelector('.open-browser');
        const desktopButton = card.querySelector('.open-desktop');
        const browserRunning = running && robot.run.mode === 'browser';
        const desktopRunning = running && robot.run.mode === 'desktop';
        browserButton.textContent = browserRunning ? 'Stop Browser' : 'Start Browser';
        desktopButton.textContent = desktopRunning ? 'Stop Desktop' : 'Start Desktop';
        if (browserRunning) browserButton.className = 'button danger open-browser';
        if (desktopRunning) desktopButton.className = 'button danger open-desktop';
        browserButton.disabled = running && !(ready && robot.run.mode === 'browser');
        desktopButton.disabled = running && !(ready && robot.run.mode === 'desktop');
        const session = card.querySelector('.robot-session');
        if (ready) {
            const url = sessionUrl(robot.run);
            session.querySelector('span').textContent = `${robot.run.mode === 'desktop' ? 'Desktop' : 'Browser'} session:`;
            const link = session.querySelector('.session-url');
            link.href = url;
            link.textContent = url;
            link.target = `_roboteam_${robot.id}`;
            session.hidden = false;
        }
        browserButton.addEventListener('click', (event) => {
            if (ready && robot.run.mode === 'browser') stopRobot(robot, event.currentTarget);
            else startRobot(robot, 'browser', event.currentTarget);
        });
        desktopButton.addEventListener('click', (event) => {
            if (ready && robot.run.mode === 'desktop') stopRobot(robot, event.currentTarget);
            else startRobot(robot, 'desktop', event.currentTarget);
        });
        const logsButton = card.querySelector('.view-logs');
        const logsPanel = card.querySelector('.robot-logs');
        logsPanel.id = `robot-logs-${robot.id}`;
        logsButton.setAttribute('aria-controls', logsPanel.id);
        let logPoller = null;
        let logRequestActive = false;
        const stopLogPolling = () => {
            if (logPoller === null) return;
            clearInterval(logPoller);
            logPollers.delete(logPoller);
            logPoller = null;
        };
        const refreshContainerLogs = async () => {
            if (logsPanel.hidden || logRequestActive) return;
            logRequestActive = true;
            const distanceFromBottom = logsPanel.scrollHeight - logsPanel.clientHeight - logsPanel.scrollTop;
            const followLatest = distanceFromBottom <= 12;
            const previousScrollTop = logsPanel.scrollTop;
            try {
                const result = await api(`api/robots/${robot.id}/logs?tail=200`);
                const nextText = result.logs || 'No container output yet.';
                if (logsPanel.textContent !== nextText) {
                    logsPanel.textContent = nextText;
                    requestAnimationFrame(() => {
                        logsPanel.scrollTop = followLatest
                            ? logsPanel.scrollHeight
                            : Math.min(previousScrollTop, logsPanel.scrollHeight);
                    });
                }
            } catch (error) {
                stopLogPolling();
                showError(error);
            } finally {
                logRequestActive = false;
            }
        };
        logsButton.addEventListener('click', async () => {
            if (!logsPanel.hidden) {
                stopLogPolling();
                logsPanel.hidden = true;
                logsButton.setAttribute('aria-expanded', 'false');
                logsButton.classList.remove('is-active');
                return;
            }
            logsPanel.textContent = 'Loading container logs…';
            logsPanel.hidden = false;
            logsButton.setAttribute('aria-expanded', 'true');
            logsButton.classList.add('is-active');
            await refreshContainerLogs();
            if (!logsPanel.hidden && logPoller === null) {
                logPoller = setInterval(refreshContainerLogs, 1000);
                logPollers.add(logPoller);
            }
        });
        robotsList.append(card);
    }
}

async function loadRobots() {
    refreshButton.disabled = true;
    try {
        const result = await api('api/robots');
        renderRobots(result.robots || []);
    } catch (error) {
        robotsList.textContent = `Robots unavailable: ${error.message}`;
    } finally {
        refreshButton.disabled = false;
    }
}

createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = createForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    const data = new FormData(createForm);
    try {
        await api('api/robots', { method: 'POST', body: { name: data.get('name'), specialization: data.get('specialization') } });
        createForm.reset();
        formMessage.textContent = 'Robot created.';
        formMessage.className = 'message success';
        await loadRobots();
    } catch (error) {
        showError(error);
    } finally {
        submit.disabled = false;
    }
});

refreshButton.addEventListener('click', loadRobots);
await loadRobots();
