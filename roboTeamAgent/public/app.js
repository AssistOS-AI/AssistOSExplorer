import { openRobotTerminal } from './terminal.js';

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

function renderSkillsets(card, robot, canAdmin) {
    const list = card.querySelector('.skillset-list');
    if (!robot.skillsets?.length) list.textContent = 'No skillsets configured.';
    for (const set of robot.skillsets || []) {
        const section = document.createElement('section');
        section.className = 'skillset-entry';
        const title = document.createElement('strong');
        title.textContent = set.name;
        const description = document.createElement('p');
        description.textContent = set.description || set.source;
        section.append(title, description);
        const skills = document.createElement('ul');
        for (const skill of set.skills || []) {
            const item = document.createElement('li');
            item.textContent = `${skill.id}: ${skill.description}`;
            skills.append(item);
        }
        section.append(skills);
        if (canAdmin && !set.builtin) {
            const remove = document.createElement('button');
            remove.className = 'button danger';
            remove.type = 'button';
            remove.textContent = 'Remove skillset';
            remove.addEventListener('click', async () => {
                if (!confirm(`Remove ${set.name} from ${robot.name}? Existing tasks keep their saved skills.`)) return;
                remove.disabled = true;
                try {
                    await api(`api/robots/${robot.id}/skillsets`, { method: 'DELETE', body: { name: set.name } });
                    await loadRobots();
                } catch (error) { showError(error); remove.disabled = false; }
            });
            section.append(remove);
        }
        list.append(section);
    }
    const form = card.querySelector('.skillset-form');
    form.hidden = !canAdmin;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button');
        submit.disabled = true;
        submit.textContent = 'Importing…';
        try {
            await api(`api/robots/${robot.id}/skillsets`, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
            await loadRobots();
        } catch (error) { showError(error); }
        finally { submit.disabled = false; submit.textContent = 'Add skillset'; }
    });
}

function renderRobots(robots, canAdmin = false) {
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
        const terminalButton = card.querySelector('.open-terminal');
        terminalButton.hidden = !canAdmin;
        terminalButton.addEventListener('click', async () => {
            terminalButton.disabled = true;
            try { await openRobotTerminal(robot, api); }
            catch (error) { showError(error); }
            finally { terminalButton.disabled = false; }
        });
        card.querySelector('.open-chat').addEventListener('click', () => {
            const params = new URLSearchParams({ agent: routeKey, robot: robot.name, 'workspace-dir': '.', 'forward-envelope': '1' });
            window.open(`/webchat?${params}`, '_blank', 'noopener');
        });
        renderSkillsets(card, robot, canAdmin);
        const deleteButton = card.querySelector('.delete-robot');
        deleteButton.hidden = !canAdmin;
        deleteButton.disabled = robot.run.state !== 'stopped'
            || ['queued', 'starting', 'running', 'stopping'].includes(robot.run.task?.state);
        deleteButton.title = 'Stop the container and all unfinished tasks before deleting this robot.';
        deleteButton.addEventListener('click', async () => {
            if (!confirm(`Permanently delete ${robot.name}, its saved logins, files and skillsets? This cannot be undone.`)) return;
            deleteButton.disabled = true;
            try {
                await api('api/control', { method: 'POST', body: { operation: 'robot-delete', robotId: robot.id } });
                await loadRobots();
            } catch (error) { showError(error); deleteButton.disabled = false; }
        });
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
        renderRobots(result.robots || [], result.canAdmin === true);
        for (const field of createForm.elements) field.disabled = result.canAdmin !== true;
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
