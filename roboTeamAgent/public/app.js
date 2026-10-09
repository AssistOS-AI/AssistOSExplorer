import { api, endpoint, routeKey } from './roboflow-api.js';
import { openSkillsDialog, codingAgentLabel, openCodingAgentsDialog } from './skills-dialog.js';
import { openRobotTerminal } from './terminal.js';
import { initDashboardTabs } from './dashboard-tabs.js';
import { initCreateRobotDialog, initRobotMenu } from './robot-controls.js';
import { initPageNavigation, restoreNavigationFocus } from './page-navigation.js';
import { initCronJobs } from './cron-jobs.js';

const robotsList = document.querySelector('#robotsList');
const robotTemplate = document.querySelector('#robotTemplate');
const robotCount = document.querySelector('#robotCount');
const createForm = document.querySelector('#createForm');
const formMessage = document.querySelector('#formMessage');
const createFormMessage = document.querySelector('#createFormMessage');
const createRobotButton = document.querySelector('#createRobotButton');
let canCreateRobots = false;
let creatingRobot = false;
const workflowsList = document.querySelector('#workflowsList');
const workflowTemplate = document.querySelector('#workflowTemplate');
const workflowCount = document.querySelector('#workflowCount');
const workflowListMessage = document.querySelector('#workflowListMessage');
const addWorkflowButton = document.querySelector('#addWorkflowButton');

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
initDashboardTabs({ initialTabId: initialView?.tabId || (requestedTab === 'workflow-types' ? 'workflowTypesTab' : requestedTab === 'cron-jobs' ? 'kronJobsTab' : undefined),
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

function renderRobots(robots, canAdmin = false) {
    robotsList.replaceChildren();
    robotCount.textContent = `${robots.length} ${robots.length === 1 ? 'robot' : 'robots'}`;
    if (!robots.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<h3>No robots yet</h3><p>Use Create robot to add your first persistent robot.</p>';
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
        card.querySelector('.active-coding-agent').textContent = `Coding agent: ${codingAgentLabel(codingAgents)}`;
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
        const logsLink = card.querySelector('.view-logs');
        logsLink.href = endpoint(`robots/${encodeURIComponent(robot.id)}/logs`);
        logsLink.setAttribute('aria-label', `Open logs for ${robot.name} (new tab)`);
        robotsList.append(card);
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
            remove.setAttribute('aria-label', `Delete workflow type ${workflow.name}`);
            remove.addEventListener('click', async () => {
                if (remove.disabled || !confirm(`Delete workflow type "${workflow.name}"? Existing runs and their history will be kept.`)) return;
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

async function loadWorkflows(canAdmin) {
    addWorkflowButton.hidden = !canAdmin;
    try {
        const { workflows } = await api('api/roboflow/workflows');
        cronJobs.setContext(workflows, canAdmin);
        workflowListMessage.textContent = '';
        renderWorkflows(workflows, canAdmin);
    } catch (error) {
        workflowListMessage.textContent = error.message;
    }
}

async function loadRobots() {
    try {
        const result = await api('api/robots');
        canCreateRobots = result.canAdmin === true;
        updateCreateControls();
        renderRobots(result.robots || [], result.canAdmin === true);
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
