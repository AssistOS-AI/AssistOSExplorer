import { openSkillsDialog, codingAgentLabel, openCodingAgentsDialog } from './skills-dialog.js';
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
const workflowForm = document.querySelector('#workflowForm');
const workflowMessage = document.querySelector('#workflowMessage');
const workflowListMessage = document.querySelector('#workflowListMessage');
const workflowsList = document.querySelector('#workflowsList');
const workflowCount = document.querySelector('#workflowCount');
const robotToAdd = document.querySelector('#robotToAdd');
const addMemberButton = document.querySelector('#addMemberButton');
const membersEditor = document.querySelector('#membersEditor');
const membersHint = document.querySelector('#membersHint');
const addWorkflowButton = document.querySelector('#addWorkflowButton');
const workflowDialog = document.querySelector('#workflowDialog');
const workflowBackButton = document.querySelector('#workflowBackButton');
const workflowNextButton = document.querySelector('#workflowNextButton');
const workflowCreateButton = document.querySelector('#workflowCreateButton');
const workflowCancelButton = document.querySelector('#workflowCancelButton');
const workflowDialogClose = document.querySelector('#workflowDialogClose');
const logPollers = new Set();

function closeOpenMenus(except) {
    for (const menu of document.querySelectorAll('.robot-open')) {
        if (menu === except) continue;
        menu.querySelector('.open-toggle').setAttribute('aria-expanded', 'false');
        menu.querySelector('.open-options').hidden = true;
    }
}

document.addEventListener('click', event => closeOpenMenus(event.target.closest('.robot-open')));
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const toggle = document.querySelector('.open-toggle[aria-expanded="true"]');
    if (toggle) { closeOpenMenus(); toggle.focus(); }
});

function prepareOpenMenu(card, robot) {
    const menu = card.querySelector('.robot-open');
    const toggle = menu.querySelector('.open-toggle');
    const options = menu.querySelector('.open-options');
    options.id = `open-options-${robot.id}`;
    toggle.setAttribute('aria-controls', options.id);
    toggle.addEventListener('click', () => {
        const opening = options.hidden;
        closeOpenMenus();
        options.hidden = !opening;
        toggle.setAttribute('aria-expanded', String(opening));
    });
    toggle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        closeOpenMenus();
        options.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        options.querySelector('button:not([hidden]):not(:disabled)')?.focus();
    });
    options.addEventListener('click', event => {
        if (event.target.closest('button')) { closeOpenMenus(); toggle.focus(); }
    });
    menu.addEventListener('focusout', event => {
        if (!menu.contains(event.relatedTarget)) closeOpenMenus();
    });
}

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
            const params = new URLSearchParams({ agent: routeKey, robot: robot.name, 'workspace-dir': '.', 'forward-envelope': '1' });
            window.open(`/webchat?${params}`, '_blank', 'noopener');
        });
        card.querySelector('.manage-skills').addEventListener('click', () => openSkillsDialog(robot, { api, onChanged: loadRobots, canAdmin }));
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
        const codingAgents = robot.codingAgents || ['codex', 'opencode', 'pi'];
        card.querySelector('.active-coding-agent').textContent = `Coding agent: ${codingAgentLabel(codingAgents)}`;
        const codingButton = card.querySelector('.configure-coding-agent');
        codingButton.hidden = !canAdmin;
        codingButton.addEventListener('click', () => openCodingAgentsDialog(robot, { api, onChanged: loadRobots }));
        const state = card.querySelector('.run-state');
        state.textContent = robot.run.mode ? `${robot.run.state} · ${robot.run.mode}` : robot.run.state;
        state.classList.add(`state-${robot.run.state}`);
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
        workflowState.robots = result.robots || [];
        populateRobotPicker();
        await loadWorkflows(result.canAdmin === true);
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

function setWorkflowMessage(text, kind) {
    workflowMessage.textContent = text || '';
    workflowMessage.className = `message ${kind}`.trim();
}

function setWorkflowListMessage(text, kind) {
    if (!workflowListMessage) return;
    workflowListMessage.textContent = text || '';
    workflowListMessage.className = `message ${kind}`.trim();
}

const EXECUTION_TYPES = [
    { value: 'terminal', label: 'Terminal', hint: 'Non-GUI CLI work in the member cwd' },
    { value: 'desktop', label: 'Desktop', hint: 'Visible Linux desktop with computer use' },
    { value: 'browser', label: 'Browser', hint: 'Visible Chromium with browser use' },
];

const workflowState = { robots: [], members: [], canAdmin: false };
let memberSequence = 0;

function robotByName(name) {
    return workflowState.robots.find((robot) => robot.name === name) || null;
}

function populateRobotPicker() {
    if (!robotToAdd) return;
    robotToAdd.replaceChildren();
    if (!workflowState.robots.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No robots available';
        robotToAdd.appendChild(option);
        robotToAdd.disabled = true;
        return;
    }
    for (const robot of workflowState.robots) {
        const option = document.createElement('option');
        option.value = robot.name;
        option.textContent = robot.specialization ? `${robot.name} — ${robot.specialization}` : robot.name;
        robotToAdd.appendChild(option);
    }
    robotToAdd.disabled = workflowState.canAdmin !== true;
}

function memberSupportsExecution(robot, executionType) {
    if (executionType === 'terminal') return true;
    return Array.isArray(robot?.codingAgents) && robot.codingAgents.includes('codex');
}

function addWorkflowMember() {
    const robotName = robotToAdd?.value;
    if (!robotName) return;
    workflowState.members.push({ key: ++memberSequence, robotName, role: '', executionType: 'terminal', skillSets: new Set() });
    renderMembersEditor();
}

function removeWorkflowMember(key) {
    workflowState.members = workflowState.members.filter((member) => member.key !== key);
    renderMembersEditor();
}

function renderMembersEditor() {
    if (!membersEditor) return;
    membersEditor.replaceChildren();
    if (membersHint) membersHint.hidden = workflowState.members.length > 0;
    workflowState.members.forEach((member, index) => membersEditor.appendChild(memberCard(member, index)));
}

function memberCard(member, index) {
    const robot = robotByName(member.robotName);
    const card = document.createElement('article');
    card.className = 'member-card';

    const header = document.createElement('div');
    header.className = 'member-card-header';
    const title = document.createElement('div');
    title.className = 'member-card-title';
    const name = document.createElement('strong');
    name.textContent = member.robotName;
    title.appendChild(name);
    if (robot?.specialization) {
        const specialization = document.createElement('span');
        specialization.textContent = robot.specialization;
        title.appendChild(specialization);
    }
    header.appendChild(title);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger';
    remove.textContent = 'Remove';
    remove.disabled = workflowState.canAdmin !== true;
    remove.addEventListener('click', () => removeWorkflowMember(member.key));
    header.appendChild(remove);
    card.appendChild(header);

    const role = document.createElement('label');
    role.className = 'field';
    const roleLabel = document.createElement('span');
    roleLabel.textContent = 'Role (optional)';
    const roleInput = document.createElement('input');
    roleInput.type = 'text';
    roleInput.maxLength = 500;
    roleInput.placeholder = 'What this robot does in the team';
    roleInput.value = member.role;
    roleInput.disabled = workflowState.canAdmin !== true;
    roleInput.addEventListener('input', () => { member.role = roleInput.value; });
    role.appendChild(roleLabel);
    role.appendChild(roleInput);
    card.appendChild(role);

    const execution = document.createElement('div');
    execution.className = 'field';
    const executionLabel = document.createElement('span');
    executionLabel.textContent = 'Execution type';
    execution.appendChild(executionLabel);
    const options = document.createElement('div');
    options.className = 'member-execution';
    for (const type of EXECUTION_TYPES) {
        const option = document.createElement('label');
        option.className = `execution-option${member.executionType === type.value ? ' selected' : ''}`;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `execution-${member.key}`;
        input.value = type.value;
        input.checked = member.executionType === type.value;
        input.disabled = workflowState.canAdmin !== true;
        input.addEventListener('change', () => {
            if (!input.checked) return;
            member.executionType = type.value;
            renderMembersEditor();
        });
        const text = document.createElement('span');
        text.className = 'execution-option-text';
        const strong = document.createElement('strong');
        strong.textContent = type.label;
        const small = document.createElement('small');
        small.textContent = type.hint;
        text.appendChild(strong);
        text.appendChild(small);
        option.appendChild(input);
        option.appendChild(text);
        options.appendChild(option);
    }
    execution.appendChild(options);
    if (member.executionType !== 'terminal' && !memberSupportsExecution(robot, member.executionType)) {
        const warning = document.createElement('p');
        warning.className = 'hint';
        warning.textContent = `Robot ${member.robotName} has no Codex enabled; ${member.executionType} tasks need Codex at execution time.`;
        execution.appendChild(warning);
    }
    card.appendChild(execution);

    const skillsets = document.createElement('div');
    skillsets.className = 'field';
    const skillsetsLabel = document.createElement('span');
    skillsetsLabel.textContent = 'Skillsets';
    skillsets.appendChild(skillsetsLabel);
    const available = Array.isArray(robot?.skillsets) ? robot.skillsets : [];
    if (!available.length) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'This robot has no skillsets registered. The member will run with no skills.';
        skillsets.appendChild(hint);
    } else {
        const boxes = document.createElement('div');
        boxes.className = 'skillset-options';
        for (const set of available) {
            const option = document.createElement('label');
            option.className = 'skillset-option';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = set.id;
            input.checked = member.skillSets.has(set.id);
            input.disabled = workflowState.canAdmin !== true;
            input.addEventListener('change', () => {
                if (input.checked) member.skillSets.add(set.id);
                else member.skillSets.delete(set.id);
            });
            const text = document.createElement('span');
            text.className = 'skillset-option-text';
            const strong = document.createElement('strong');
            strong.textContent = set.name;
            text.appendChild(strong);
            if (set.description) {
                const small = document.createElement('small');
                small.textContent = set.description;
                text.appendChild(small);
            }
            option.appendChild(input);
            option.appendChild(text);
            boxes.appendChild(option);
        }
        skillsets.appendChild(boxes);
    }
    card.appendChild(skillsets);

    card.dataset.index = String(index);
    return card;
}

function collectWorkflowMembers() {
    if (!workflowState.members.length) throw new Error('Add at least one robot to the workflow.');
    return workflowState.members.map((member) => ({
        robotName: member.robotName,
        role: member.role.trim(),
        executionType: member.executionType,
        skillSets: [...member.skillSets],
        skills: [],
    }));
}

function showWorkflowStep(step) {
    if (!workflowForm) return;
    for (const panel of workflowForm.querySelectorAll('[data-step]')) {
        panel.hidden = Number(panel.dataset.step) !== step;
    }
    if (workflowBackButton) workflowBackButton.hidden = step !== 2;
    if (workflowNextButton) workflowNextButton.hidden = step !== 1;
    if (workflowCreateButton) workflowCreateButton.hidden = step !== 2;
    setWorkflowMessage('');
}

function workflowDetailsValid() {
    const nameInput = workflowForm?.querySelector('input[name="name"]');
    return nameInput ? nameInput.reportValidity() : true;
}

function openWorkflowDialog() {
    if (!workflowDialog || !workflowForm) return;
    workflowForm.reset();
    workflowState.members = [];
    renderMembersEditor();
    showWorkflowStep(1);
    setWorkflowListMessage('');
    if (typeof workflowDialog.showModal === 'function') workflowDialog.showModal();
    else workflowDialog.setAttribute('open', '');
}

function closeWorkflowDialog() {
    if (!workflowDialog) return;
    if (workflowDialog.open && typeof workflowDialog.close === 'function') workflowDialog.close();
    else workflowDialog.removeAttribute('open');
}

function renderWorkflows(workflows, canAdmin) {
    workflowCount.textContent = `${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`;
    workflowsList.replaceChildren();
    if (!workflows.length) {
        const empty = document.createElement('p');
        empty.className = 'lede';
        empty.textContent = 'No workflow types yet.';
        workflowsList.appendChild(empty);
    }
    for (const workflow of workflows) {
        const card = document.createElement('article');
        card.className = 'workflow-card';
        const title = document.createElement('h3');
        title.textContent = workflow.name;
        card.appendChild(title);
        if (workflow.description) {
            const description = document.createElement('p');
            description.textContent = workflow.description;
            card.appendChild(description);
        }
        const list = document.createElement('ul');
        for (const member of workflow.members) {
            const item = document.createElement('li');
            const parts = [`${member.robotName} · ${member.executionType}`];
            if (member.role) parts.push(member.role);
            if (Array.isArray(member.skillSets) && member.skillSets.length) parts.push(`skillsets: ${member.skillSets.join(', ')}`);
            if (Array.isArray(member.skills) && member.skills.length) parts.push(`skills: ${member.skills.join(', ')}`);
            item.textContent = parts.join(' · ');
            list.appendChild(item);
        }
        card.appendChild(list);
        if (canAdmin) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button danger';
            remove.textContent = 'Delete workflow';
            remove.addEventListener('click', async () => {
                remove.disabled = true;
                try {
                    await api(`api/roboflow/workflows/${workflow.id}`, { method: 'DELETE' });
                    await loadWorkflows(workflowState.canAdmin);
                } catch (error) {
                    setWorkflowListMessage(error.message, 'error');
                } finally {
                    remove.disabled = false;
                }
            });
            card.appendChild(remove);
        }
        workflowsList.appendChild(card);
    }
}

async function loadWorkflows(canAdmin) {
    workflowState.canAdmin = canAdmin === true;
    try {
        const result = await api('api/roboflow/workflows');
        renderWorkflows(result.workflows || [], workflowState.canAdmin);
    } catch (error) {
        workflowsList.textContent = `Workflows unavailable: ${error.message}`;
    }
    if (workflowForm) {
        for (const field of workflowForm.querySelectorAll('input, textarea, select, button')) field.disabled = !workflowState.canAdmin;
        populateRobotPicker();
        renderMembersEditor();
    }
    if (addWorkflowButton) addWorkflowButton.disabled = !workflowState.canAdmin;
}

if (workflowForm) {
    addMemberButton?.addEventListener('click', addWorkflowMember);
    addWorkflowButton?.addEventListener('click', openWorkflowDialog);
    workflowNextButton?.addEventListener('click', () => { if (workflowDetailsValid()) showWorkflowStep(2); });
    workflowBackButton?.addEventListener('click', () => showWorkflowStep(1));
    workflowCancelButton?.addEventListener('click', closeWorkflowDialog);
    workflowDialogClose?.addEventListener('click', closeWorkflowDialog);
    workflowDialog?.addEventListener('close', () => {
        workflowForm.reset();
        workflowState.members = [];
        renderMembersEditor();
        setWorkflowMessage('');
    });
    workflowForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = workflowCreateButton || workflowForm.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        const data = new FormData(workflowForm);
        try {
            const members = collectWorkflowMembers();
            await api('api/roboflow/workflows', { method: 'POST', body: {
                name: data.get('name'),
                description: data.get('description'),
                members,
            } });
            closeWorkflowDialog();
            setWorkflowListMessage('Workflow type created.', 'success');
            await loadWorkflows(workflowState.canAdmin);
        } catch (error) {
            setWorkflowMessage(error.message, 'error');
        } finally {
            if (submit) submit.disabled = !workflowState.canAdmin;
        }
    });
}

await loadRobots();
