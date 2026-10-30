import { api, endpoint, routeKey } from './roboflow-api.js';
import { openSkillsDialog, codingAgentLabel, openCodingAgentsDialog } from './skills-dialog.js';
import { openRobotTerminal } from './terminal.js';
import { initDashboardTabs } from './dashboard-tabs.js';
import { initCreateRobotDialog, initRobotMenu } from './robot-controls.js';
import { initPageNavigation, restoreNavigationFocus } from './page-navigation.js';
import { initCronJobs } from './cron-jobs.js';
import { initRobotImport } from './robot-import.js';
import { filterRobots, filtersActive, loginSummary, readRobotFilters, writeRobotFilters } from './robot-filters.js';

const robotsList = document.querySelector('#robotsList');
const robotTemplate = document.querySelector('#robotTemplate');
const robotCount = document.querySelector('#robotCount');
const createForm = document.querySelector('#createForm');
const formMessage = document.querySelector('#formMessage');
const createFormMessage = document.querySelector('#createFormMessage');
const createRobotButton = document.querySelector('#createRobotButton');
const useProxyField = document.querySelector('#useProxyField');
const useProxyToggle = document.querySelector('#useProxyToggle');
let canCreateRobots = false;
let allRobots = [];
const robotFilters = readRobotFilters(location.search);
const robotSearch = document.querySelector('#robotSearch');
const robotLoginFilter = document.querySelector('#robotLoginFilter');
const robotAgentFilter = document.querySelector('#robotAgentFilter');
const robotFilterSummary = document.querySelector('#robotFilterSummary');
let creatingRobot = false;
const workflowsList = document.querySelector('#workflowsList');
const workflowTemplate = document.querySelector('#workflowTemplate');
const workflowCount = document.querySelector('#workflowCount');
const workflowListMessage = document.querySelector('#workflowListMessage');
const workflowFileErrors = document.querySelector('#workflowFileErrors');
const addWorkflowButton = document.querySelector('#addWorkflowButton');
const launchingWorkflows = new Set();

const warningText = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';

const navigation = initPageNavigation({
    fallbackUrl: endpoint('?tab=workflow-types'),
    captureView: () => ({
        tabId: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
        scrollX: window.scrollX, scrollY: window.scrollY,
        focusKey: document.activeElement?.dataset.navigationKey,
        keyboardFocus: Boolean(document.activeElement?.matches(':focus-visible') && !document.activeElement.classList.contains('pointer-restored-focus')),
        robotName: createForm.querySelector('input[name="name"]').value,
    }),
});
const initialView = navigation.view;
const cronJobs = initCronJobs({ api, endpoint, bindLink: navigation.bindLink, closeMenus: closeOpenMenus });
const requestedTab = new URL(location.href).searchParams.get('tab');
const requestedTabIds = { 'workflow-types': 'workflowTypesTab', 'cron-jobs': 'kronJobsTab' };
initDashboardTabs({ initialTabId: initialView?.tabId || requestedTabIds[requestedTab],
    onChange: () => { closeOpenMenus(); void cronJobs.refresh(); } });
navigation.bindLink(addWorkflowButton);
navigation.bindLink(document.querySelector('#flowsHistoryButton'));

function restoreDashboardView(view) {
    if (!view) return;
    if (typeof view.robotName === 'string') createForm.querySelector('input[name="name"]').value = view.robotName;
    requestAnimationFrame(() => {
        const focus = Array.from(document.querySelectorAll('[data-navigation-key]')).find(element => element.dataset.navigationKey === view.focusKey);
        restoreNavigationFocus(focus, view.keyboardFocus);
        window.scrollTo(view.scrollX || 0, view.scrollY || 0);
    });
}
const createDialog = initCreateRobotDialog({
    dialog: document.querySelector('#createRobotDialog'),
    trigger: createRobotButton,
    closeButton: document.querySelector('#createRobotClose'),
    cancelButton: document.querySelector('#createRobotCancel'),
    onOpen() {
        closeOpenMenus();
        createFormMessage.textContent = '';
    },
});

const robotImport = initRobotImport({
    button: document.querySelector('#importRobotsButton'),
    fileInput: document.querySelector('#robotCsvFile'),
    api,
    report(text, tone) { formMessage.textContent = text; formMessage.className = `message ${tone}`; },
    onImported: () => loadRobots(),
});

function closeOpenMenus(except) {
    for (const menu of document.querySelectorAll('.robot-open, .robot-manage')) {
        if (menu === except) continue;
        menu.querySelector('[data-robot-menu-toggle]').setAttribute('aria-expanded', 'false');
        menu.querySelector('[data-robot-menu-options]').hidden = true;
    }
}

document.addEventListener('click', event => closeOpenMenus(event.target.closest('.robot-open, .robot-manage')));
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const toggle = document.querySelector('[data-robot-menu-toggle][aria-expanded="true"]');
    if (toggle) { closeOpenMenus(); toggle.focus(); }
});

function prepareOpenMenu(card, robot) {
    initRobotMenu({ menu: card.querySelector('.robot-open'), id: `open-options-${robot.id}`, closeMenus: closeOpenMenus });
    initRobotMenu({ menu: card.querySelector('.robot-manage'), id: `manage-options-${robot.id}`,
        label: `More actions for ${robot.name}`, closeMenus: closeOpenMenus });
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

function applyRobotFilters() {
    // Only administrators receive login state, so the login filter does not apply to anyone else.
    document.querySelector('#robotLoginFilterField').hidden = !canCreateRobots;
    if (!canCreateRobots) robotFilters.login = '';
    robotSearch.value = robotFilters.query;
    robotLoginFilter.value = robotFilters.login;
    robotAgentFilter.value = robotFilters.agent;
    const visible = filterRobots(allRobots, robotFilters);
    robotFilterSummary.hidden = !filtersActive(robotFilters);
    robotFilterSummary.querySelector('span').textContent = `Showing ${visible.length} of ${allRobots.length} ${allRobots.length === 1 ? 'robot' : 'robots'}`;
    renderRobots(visible, canCreateRobots, allRobots.length);
    showRobotProxies();
}

function updateRobotFilters(change) {
    Object.assign(robotFilters, change);
    history.replaceState(history.state, '', writeRobotFilters(location.href, robotFilters));
    applyRobotFilters();
}

robotSearch.addEventListener('input', () => updateRobotFilters({ query: robotSearch.value }));
robotLoginFilter.addEventListener('change', () => updateRobotFilters({ login: robotLoginFilter.value }));
robotAgentFilter.addEventListener('change', () => updateRobotFilters({ agent: robotAgentFilter.value }));
document.querySelector('#robotFilterClear').addEventListener('click', () => updateRobotFilters({ query: '', login: '', agent: '' }));

function renderRobots(robots, canAdmin = false, total = robots.length) {
    robotsList.replaceChildren();
    robotCount.textContent = `${total} ${total === 1 ? 'robot' : 'robots'}`;
    if (!robots.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = total ? '<h3>No robots match these filters</h3><p>Change the search or the filters, or clear them.</p>'
            : '<h3>No robots yet</h3><p>Use Create robot to add your first persistent robot.</p>';
        robotsList.append(empty);
        return;
    }
    for (const robot of robots) {
        const card = robotTemplate.content.firstElementChild.cloneNode(true);
        prepareOpenMenu(card, robot);
        const terminalButton = card.querySelector('.open-terminal');
        terminalButton.hidden = !canAdmin;
        terminalButton.addEventListener('click', async () => {
            terminalButton.disabled = true;
            try { await openRobotTerminal(robot, api); }
            catch (error) { showError(error); }
            finally { terminalButton.disabled = false; }
        });
        card.querySelector('.open-chat').addEventListener('click', () => {
            const params = new URLSearchParams({ agent: routeKey, robot: robot.name, 'workspace-dir': 'achilles-cli', 'forward-envelope': '1' });
            window.open(`/webchat?${params}`, '_blank', 'noopener');
        });
        card.querySelector('.manage-skills').addEventListener('click', () => openSkillsDialog(robot, { api, onChanged: loadRobots, canAdmin }));
        const deleteButton = card.querySelector('.delete-robot');
        deleteButton.hidden = !canAdmin;
        card.querySelector('.robot-danger-actions').hidden = !canAdmin;
        deleteButton.disabled = robot.run.state !== 'stopped'
            || ['queued', 'starting', 'running', 'pausing'].includes(robot.run.task?.state);
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
        card.querySelector('.robot-id').textContent = robot.id;
        const codingAgents = robot.codingAgents || ['codex', 'opencode', 'pi', 'claude'];
        const agentLine = card.querySelector('.active-coding-agent');
        agentLine.textContent = `Coding agent: ${codingAgentLabel(codingAgents)}`;
        const logins = loginSummary(robot);
        if (logins) {
            const marker = document.createElement('span');
            marker.className = 'robot-logins';
            marker.textContent = ` · ${logins.text}`;
            marker.title = logins.title;
            agentLine.append(marker);
        }
        card.dataset.robotId = robot.id;
        const releaseProxy = card.querySelector('.release-proxy');
        releaseProxy.disabled = robot.run.state !== 'stopped';
        releaseProxy.title = robot.run.state === 'stopped' ? 'The robot receives a proxy again when its workstation next starts' : 'Stop the workstation before releasing its proxy';
        releaseProxy.addEventListener('click', async () => {
            releaseProxy.disabled = true;
            try {
                await api(`api/robots/${encodeURIComponent(robot.id)}/proxy`, { method: 'DELETE' });
                formMessage.textContent = `${robot.name} no longer holds a proxy.`;
                formMessage.className = 'message success';
                await loadRobotProxies();
            } catch (error) { showError(error); releaseProxy.disabled = false; }
        });
        const codingButton = card.querySelector('.configure-coding-agent');
        codingButton.hidden = !canAdmin;
        codingButton.addEventListener('click', () => openCodingAgentsDialog(robot, { api, onChanged: loadRobots }));
        const state = card.querySelector('.run-state');
        state.textContent = robot.run.state;
        state.title = robot.run.mode ? `${robot.run.state} · ${robot.run.mode}` : robot.run.state;
        state.classList.add(`state-${robot.run.state}`);
        const mode = card.querySelector('.robot-mode');
        mode.textContent = robot.run.mode || '';
        mode.hidden = !robot.run.mode;
        const running = robot.run.state !== 'stopped';
        const ready = robot.run.state === 'running' && robot.run.sessionUrl;
        const browserButton = card.querySelector('.open-browser');
        const desktopButton = card.querySelector('.open-desktop');
        const browserRunning = running && robot.run.mode === 'browser';
        const desktopRunning = running && robot.run.mode === 'desktop';
        browserButton.disabled = running && !(ready && robot.run.mode === 'browser');
        desktopButton.disabled = running && !(ready && robot.run.mode === 'desktop');
        const stopButton = card.querySelector('.stop-workstation');
        stopButton.hidden = !running;
        stopButton.disabled = !ready;
        stopButton.textContent = desktopRunning ? 'Stop Desktop' : 'Stop Browser';
        stopButton.addEventListener('click', event => stopRobot(robot, event.currentTarget));
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
            if (ready && browserRunning) navigateToSession(openPendingSession(robot, 'browser'), robot.run);
            else startRobot(robot, 'browser', event.currentTarget);
        });
        desktopButton.addEventListener('click', (event) => {
            if (ready && desktopRunning) navigateToSession(openPendingSession(robot, 'desktop'), robot.run);
            else startRobot(robot, 'desktop', event.currentTarget);
        });
        const logsLink = card.querySelector('.robot-logs-link');
        logsLink.href = endpoint(`robots/${encodeURIComponent(robot.id)}/logs`);
        logsLink.setAttribute('aria-label', `Open logs for ${robot.name} (new tab)`);
        robotsList.append(card);
    }
}

async function runWorkflowNow(workflow, button, remove, toggle) {
    if (launchingWorkflows.has(workflow.id)) return;
    toggle.focus({ preventScroll: true });
    launchingWorkflows.add(workflow.id);
    button.disabled = true;
    remove.disabled = true;
    button.textContent = 'Starting…';
    workflowListMessage.textContent = '';
    try {
        const { flow, workerNotice } = await api('api/roboflow/flows', {
            method: 'POST', body: { workflowTypeId: workflow.id },
        });
        // A start by someone who is not an administrator may name robots that need one: shown on the flow page, not blocking.
        if (workerNotice?.message) sessionStorage.setItem(`roboteam-flow-notice:${flow.id}`, workerNotice.message);
        navigation.navigate(endpoint(`flows?flowId=${encodeURIComponent(flow.id)}`));
    } catch (error) {
        workflowListMessage.textContent = error.message;
    } finally {
        launchingWorkflows.delete(workflow.id);
        button.disabled = false;
        remove.disabled = false;
        button.textContent = 'Run now';
        for (const card of workflowsList.children) {
            const current = card.querySelector('.workflow-run-now');
            if (current?.dataset.navigationKey !== `workflow-run:${workflow.id}`) continue;
            current.disabled = false;
            current.textContent = 'Run now';
            card.querySelector('.delete-workflow').disabled = false;
        }
    }
}

function renderWorkflows(workflows, canAdmin) {
    workflowCount.textContent = `${workflows.length} ${workflows.length === 1 ? 'workflow' : 'workflows'}`;
    workflowsList.replaceChildren();
    if (!workflows.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<h3>No workflow types yet</h3><p>Workflow types will appear here once created.</p>';
        workflowsList.append(empty);
        return;
    }
    for (const workflow of workflows) {
        const card = workflowTemplate.content.firstElementChild.cloneNode(true);
        const builtIn = workflow.readOnly || workflow.id === 'default' || workflow.kind === 'default';
        card.querySelector('.avatar').textContent = initials(workflow.name);
        card.querySelector('h3').textContent = workflow.name;
        card.querySelector('.robot-id').textContent = workflow.id;
        card.querySelector('.workflow-kind').textContent = builtIn ? 'Built-in' : 'Custom';
        const description = card.querySelector('.workflow-description');
        description.textContent = workflow.description;
        description.hidden = !workflow.description;
        // Only workflows from workspace files show where they come from.
        const source = card.querySelector('.workflow-source');
        source.textContent = workflow.source?.path || '';
        source.hidden = !workflow.source?.path;
        if (workflow.coverage?.warning) {
            const warning = card.querySelector('.workflow-coverage-warning');
            warning.hidden = false;
            warning.textContent = '⚠ Missing matching robots';
            warning.title = warningText;
            warning.setAttribute('aria-label', warningText);
        }
        const counts = card.querySelector('.workflow-counts');
        counts.textContent = `${workflow.tasks.length} ${workflow.tasks.length === 1 ? 'task' : 'tasks'} · ${workflow.edges.length} ${workflow.edges.length === 1 ? 'connection' : 'connections'}`;
        const link = card.querySelector('.workflow-open');
        link.href = endpoint(`flow-types?id=${encodeURIComponent(workflow.id)}`);
        const action = canAdmin && !workflow.readOnly && workflow.kind !== 'default' ? 'Edit workflow' : 'View workflow';
        link.setAttribute('aria-label', `${action} ${workflow.name}`);
        link.title = 'View workflow';
        link.dataset.navigationKey = `workflow:${workflow.id}`;
        navigation.bindLink(link);
        if (canAdmin && !workflow.readOnly && workflow.id !== 'default' && workflow.kind !== 'default') {
            card.classList.add('workflow-card-manageable');
            const menu = card.querySelector('.robot-manage');
            menu.hidden = false;
            initRobotMenu({ menu, id: `workflow-options-${workflow.id}`,
                label: `More actions for workflow ${workflow.name}`, closeMenus: closeOpenMenus });
            const remove = card.querySelector('.delete-workflow');
            const runNow = card.querySelector('.workflow-run-now');
            const toggle = card.querySelector('.manage-toggle');
            toggle.dataset.navigationKey = `workflow-menu:${workflow.id}`;
            runNow.dataset.navigationKey = `workflow-run:${workflow.id}`;
            runNow.setAttribute('aria-label', `Run workflow ${workflow.name} now`);
            runNow.disabled = remove.disabled = launchingWorkflows.has(workflow.id);
            runNow.textContent = runNow.disabled ? 'Starting…' : 'Run now';
            runNow.addEventListener('click', () => runWorkflowNow(workflow, runNow, remove, toggle));
            remove.setAttribute('aria-label', `Delete workflow type ${workflow.name}`);
            remove.addEventListener('click', async () => {
                const file = workflow.source?.path ? ` This deletes its file ${workflow.source.path}.` : '';
                if (remove.disabled || !confirm(`Delete workflow type "${workflow.name}"?${file} Existing runs and their history will be kept.`)) return;
                remove.disabled = true;
                remove.textContent = 'Deleting…';
                workflowListMessage.textContent = '';
                try {
                    await api(`api/roboflow/workflows/${encodeURIComponent(workflow.id)}`, { method: 'DELETE' });
                    await loadWorkflows(canAdmin);
                } catch (error) {
                    workflowListMessage.textContent = error.message;
                } finally {
                    remove.disabled = false;
                    remove.textContent = 'Delete workflow';
                }
            });
        }
        workflowsList.append(card);
    }
}

// Files found in flows folders that are not workflows: they do not validate or reuse an id.
function renderWorkflowFileErrors(errors) {
    const list = workflowFileErrors.querySelector('ul');
    list.replaceChildren(...errors.map(({ path, message }) => {
        const item = document.createElement('li');
        const file = document.createElement('code');
        file.textContent = path;
        item.append(file, `: ${message}`);
        return item;
    }));
    workflowFileErrors.hidden = !errors.length;
}

async function loadWorkflows(canAdmin) {
    addWorkflowButton.hidden = !canAdmin;
    try {
        const { workflows, workflowFileErrors: fileErrors = [] } = await api('api/roboflow/workflows');
        cronJobs.setContext(workflows, canAdmin);
        workflowListMessage.textContent = '';
        renderWorkflows(workflows, canAdmin);
        renderWorkflowFileErrors(fileErrors);
    } catch (error) {
        workflowListMessage.textContent = error.message;
    }
}

function robotProxyLabel(proxy) {
    const place = [proxy.country, proxy.city].filter(Boolean).join(' · ');
    const locale = proxy.locale ? `${proxy.locale.timezone} · ${proxy.locale.lang}` : '';
    const label = ['Proxy:', [place, `${proxy.host}:${proxy.port}`, proxy.exitIp, locale].filter(Boolean).join(' · ')].join(' ');
    return proxy.usable === false ? `${label} (unusable; replaced at the next start)` : label;
}

let robotProxies = {};
let useProxy = true;

// The global Use Proxy switch appears only to administrators while proxyAgent is reachable.
async function loadRobotProxies() {
    if (!canCreateRobots) { useProxyField.hidden = true; return; }
    let listing;
    try { listing = await api('api/robot-proxies'); } catch { return; }
    robotProxies = listing.proxies || {};
    useProxy = listing.useProxy !== false;
    showUseProxy();
    useProxyField.hidden = listing.available !== true;
    showRobotProxies();
}

// A workstation picks its connection when it starts, so the switch reaches running robots only after a restart.
function showUseProxy() {
    useProxyToggle.checked = useProxy;
    useProxyField.title = useProxy
        ? 'On for every robot: robots connect through their proxy. A running robot switches at its next start; stop and start it to apply now.'
        : 'Off for every robot: robots connect directly and keep their proxy reserved. A running robot switches at its next start; stop and start it to apply now.';
}

useProxyToggle.addEventListener('change', async () => {
    const requested = useProxyToggle.checked;
    useProxyToggle.disabled = true;
    try {
        useProxy = (await api('api/proxy-settings', { method: 'PUT', body: { useProxy: requested } })).useProxy !== false;
        showUseProxy();
        showRobotProxies();
    } catch (error) { useProxyToggle.checked = !requested; showError(error); }
    finally { useProxyToggle.disabled = false; }
});

function showRobotProxies() {
    for (const card of robotsList.querySelectorAll('[data-robot-id]')) {
        const proxy = robotProxies[card.dataset.robotId];
        const label = card.querySelector('.robot-proxy');
        label.hidden = !proxy;
        label.textContent = proxy ? `${robotProxyLabel(proxy)}${useProxy ? '' : ' (not used: Use Proxy is off)'}` : '';
        if (proxy) label.title = `Account: ${proxy.account}`;
        card.querySelector('.release-proxy').hidden = !proxy;
    }
}

async function loadRobots() {
    try {
        const result = await api('api/robots');
        canCreateRobots = result.canAdmin === true;
        robotImport.setContext(canCreateRobots);
        updateCreateControls();
        allRobots = result.robots || [];
        applyRobotFilters();
        // Leases live in the optional proxyAgent, so a slow or missing one never holds the robot list.
        void loadRobotProxies();
        await loadWorkflows(result.canAdmin === true);
    } catch (error) {
        robotsList.textContent = `Robots unavailable: ${error.message}`;
    }
}

function updateCreateControls() {
    const disabled = !canCreateRobots || creatingRobot;
    createRobotButton.disabled = disabled;
    createForm.querySelector('input[name="name"]').disabled = disabled;
    const submit = createForm.querySelector('button[type="submit"]');
    submit.disabled = disabled;
    submit.textContent = creatingRobot ? 'Creating…' : 'Create robot';
}

createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creatingRobot || !canCreateRobots) return;
    const data = new FormData(createForm);
    creatingRobot = true;
    createDialog.setBusy(true);
    updateCreateControls();
    let created = false;
    createFormMessage.textContent = '';
    try {
        await api('api/robots', { method: 'POST', body: { name: data.get('name') } });
        created = true;
        createForm.reset();
        formMessage.textContent = 'Robot created.';
        formMessage.className = 'message success';
        await loadRobots();
    } catch (error) {
        createFormMessage.textContent = error.message;
        createFormMessage.className = 'message error';
    } finally {
        creatingRobot = false;
        createDialog.setBusy(false);
        updateCreateControls();
        if (created) createDialog.complete();
        else createForm.querySelector('input[name="name"]').focus();
    }
});

await loadRobots();
restoreDashboardView(initialView);
window.addEventListener('pageshow', async event => {
    if (!event.persisted) return;
    await loadRobots();
    restoreDashboardView(navigation.view);
});
