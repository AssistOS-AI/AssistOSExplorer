import { createSessionForm } from './coding-session-form.js';
import { isAdminUser } from '../../../services/auth/adminUser.js';
import { codingSessionsRequest } from './coding-sessions-api.js';
import { reserveTerminalWindow, navigateTerminalWindow } from '../terminal-target-modal/terminal-target-modal.js';
import { mintLiveSessionAttach } from '../../../IDE-plugins/live-sessions/live-sessions-api.js';

// Session creation lives on the Router. The modal holds only navigation state, never credentials
// or terminal streams. Tabs use the same single-use attachment handoff as Live Sessions.
export class CodingSessionsModal {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.directory = props.dir ?? element.dataset.dir ?? '';
        this.state = { step: 'sessions', mode: 'coding', role: 'supervisor' };
        this.stack = [];
        this.draft = {};
        this.closed = false;
        this.started = false;
        this.controller = new AbortController();
        invalidate();
    }
    beforeRender() {}
    afterRender() {
        if (this.started) return;
        this.started = true;
        this.list = this.element.querySelector('#codingList');
        this.status = this.element.querySelector('#codingStatus');
        this.heading = this.element.querySelector('#codingStep');
        this.element.querySelector('#codingDirectory').textContent = this.directory || 'Workspace root';
        this.onTabKey = async event => {
            if (this.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const coding = event.key === 'Home' || (event.key !== 'End' && this.state.mode !== 'coding');
            await (coding ? this.codingMode() : this.supervisedMode());
            if (this.closed) return;
            this.element.querySelector(coding ? '#codingTab' : '#supervisedTab').focus();
        };
        this.element.querySelector('[role="tablist"]').addEventListener('keydown', this.onTabKey);
        void this.refresh();
    }
    afterUnload() { this.form?.dispose?.(); this.element.querySelector('[role="tablist"]')?.removeEventListener('keydown', this.onTabKey); this.closed = true; this.controller.abort(); }
    closeModal() { this.afterUnload(); assistOS.UI.closeModal(this.element); }
    api(action, values = {}) { return codingSessionsRequest(action, this.directory, values, { signal: this.controller.signal }); }
    async run(operation) {
        if (this.busy || this.closed) return;
        if (!isAdminUser(globalThis.window?.assistOS?.user)) { this.status.textContent = 'Administrator access is required.'; return; }
        this.busy = true;
        this.form?.update();
        this.list.setAttribute('aria-busy', 'true');
        this.notice = '';
        this.status.textContent = 'Loading…';
        this.element.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try { await operation(); if (!this.closed) this.status.textContent = this.notice || ''; }
        catch (error) { if (!this.closed) this.status.textContent = error.message; }
        finally {
            this.busy = false;
            if (!this.closed) {
                this.list.setAttribute('aria-busy', 'false');
                this.element.querySelectorAll('button').forEach(button => { button.disabled = false; });
                this.element.querySelector('[data-local-action="goBack"]').disabled = this.stack.length === 0;
                this.form?.update();
            }
        }
    }
    sessionBadges(entries, { title = '', roles = false, running = false } = {}) {
        const content = document.createElement('span'); content.className = 'coding-session-content';
        for (const entry of entries) {
            const group = document.createElement('span'); group.className = 'coding-session-metadata';
            if (roles) {
                const role = document.createElement('span'); role.className = 'coding-session-role';
                role.textContent = entry.role === 'worker' ? 'Worker' : 'Supervisor'; group.append(role);
            }
            for (const [kind, value] of [['robot', entry.robotName || entry.robotId], ['agent', entry.codingAgent]]) {
                const pill = document.createElement('span'); pill.className = `coding-session-pill is-${kind}`;
                pill.textContent = value; pill.title = `${kind === 'robot' ? 'Robot' : 'Coding agent'}: ${value}`; group.append(pill);
            }
            content.append(group);
        }
        if (title) { const caption = document.createElement('span'); caption.className = 'coding-session-caption'; caption.textContent = title; content.append(caption); }
        if (running) { const status = document.createElement('span'); status.className = 'coding-session-running'; status.textContent = 'running'; content.append(status); }
        return content;
    }
    row(label, action, terminalId = null, running = false, content = null) {
        const row = document.createElement('div'); row.className = `coding-session-row${label.startsWith('+ ') ? ' is-new' : ''}`;
        row.dataset.searchText = label.toLocaleLowerCase();
        if (terminalId) row.classList.add('has-actions');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'coding-session-choice';
        const text = content || document.createElement('span'); if (!content) text.textContent = label; button.append(text);
        if (running && !content) {
            text.append(document.createTextNode(' · '));
            const status = document.createElement('span'); status.className = 'coding-session-running'; status.textContent = 'running'; text.append(status);
        }
        button.setAttribute('aria-label', `${label}${running ? ' · running' : ''}`); button.addEventListener('click', () => { if (!this.busy) action(); }); row.append(button);
        if (terminalId) {
            const menu = document.createElement('details');
            const summary = document.createElement('summary'); summary.textContent = '⋮'; summary.setAttribute('aria-label', `Actions for ${label}`);
            const kill = document.createElement('button'); kill.type = 'button'; kill.className = 'gray-button'; kill.textContent = 'Kill';
            kill.addEventListener('click', () => {
                if (this.busy) return;
                if (kill.dataset.confirm !== 'true') { kill.dataset.confirm = 'true'; kill.textContent = 'Confirm kill'; return; }
                void this.run(async () => {
                    const result = await this.api('kill', { id: terminalId });
                    await this.render();
                    if (!result.historySaved) this.notice = 'The process was stopped, but its latest history could not be read. Previously saved conversations are still shown.';
                });
            });
            menu.append(summary, kill); row.append(menu);
        }
        this.list.append(row);
    }
    move(state) { this.stack.push({ ...this.state }); this.state = { ...this.state, ...state }; void this.refresh(); }
    goBack() { if (this.busy) return; this.state = this.stack.pop() || { step: 'sessions', mode: 'coding', role: 'supervisor' }; void this.refresh(); }
    codingMode() { if (this.busy) return; this.stack = []; this.state = { step: 'sessions', mode: 'coding', role: 'supervisor' }; return this.refresh(); }
    supervisedMode() { if (this.busy) return; this.stack = []; this.state = { step: 'pairs', mode: 'supervised', role: 'supervisor' }; return this.refresh(); }
    async refresh() { await this.run(() => this.render()); }
    open(action) {
        // Reserve synchronously during the click, before awaiting network requests.
        const popup = reserveTerminalWindow();
        if (!popup) { this.status.textContent = 'Allow popups to open the session in a new tab.'; return; }
        void this.run(async () => {
            let navigated = false;
            try {
                const attach = await action();
                if (this.closed) { popup.close(); return; }
                if (!navigateTerminalWindow(popup, { attach })) throw new Error('Could not open the terminal tab. The session remains in Live Sessions.');
                navigated = true;
                if (this.state.step === 'new') {
                    this.stack = [];
                    this.state = { mode: this.state.mode, step: this.state.mode === 'coding' ? 'sessions' : 'pairs', role: 'supervisor' };
                }
                await this.render();
            } catch (error) { if (!navigated) popup.close(); throw error; }
        });
    }
    openPair(choices) {
        if (this.busy || this.closed || !isAdminUser(globalThis.window?.assistOS?.user)) return;
        // Both reservations belong to the original click, before the API request.
        const supervisor = reserveTerminalWindow();
        const worker = supervisor ? reserveTerminalWindow() : null;
        if (!supervisor || !worker) {
            supervisor?.close(); worker?.close();
            this.status.textContent = 'Allow multiple popups for this site to open Supervisor and Worker in separate tabs.';
            return;
        }
        const tabs = [supervisor, worker], navigated = [false, false];
        void this.run(async () => {
            let created = false;
            try {
                const result = await this.api('create-pair', choices);
                created = true;
                if (this.closed) return;
                this.stack = [];
                this.state = { mode: 'supervised', step: 'pairs', role: 'supervisor' };
                for (const [index, attach] of [result.attach, result.worker?.attach].entries()) {
                    navigated[index] = navigateTerminalWindow(tabs[index], { attach });
                }
                await this.render();
                if (navigated.some(value => !value)) throw new Error('The pair is running, but a terminal tab could not open. Open that role from the session list.');
                supervisor.focus?.();
            } catch (error) {
                if (created && !this.closed) {
                    this.stack = [];
                    this.state = { mode: 'supervised', step: 'pairs', role: 'supervisor' };
                    await this.render();
                }
                throw error;
            } finally {
                tabs.forEach((tab, index) => { if (!navigated[index]) tab.close(); });
            }
        });
    }
    savedRow(entry) {
        this.row(`robot: ${entry.robotName || entry.robotId} · coding agent: ${entry.codingAgent} · ${entry.title || entry.id}`,
            () => this.open(async () => (await this.api('launch', { robot: entry.robotId, codingAgent: entry.codingAgent, resume: entry.id })).attach), null, false, this.sessionBadges([entry], { title: entry.title || entry.id }));
    }
    async render() {

        this.form?.dispose?.(); this.form = null;
        const { step, mode } = this.state;
        const key = JSON.stringify(this.state);
        const scrollTop = key === this.screenKey ? this.list.scrollTop : 0;
        this.screenKey = key;
        this.list.replaceChildren();
        for (const [id, active] of [['codingTab', mode === 'coding'], ['supervisedTab', mode === 'supervised']]) {
            const tab = this.element.querySelector(`#${id}`);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
        }
        this.element.querySelector('#codingPanel').setAttribute('aria-labelledby', mode === 'coding' ? 'codingTab' : 'supervisedTab');
        if (step === 'new') {
            this.heading.textContent = mode === 'supervised' ? 'New supervised session' : 'New coding session';
            const { robots = [], codingAgents = [] } = await this.api('robots');
            if (this.closed) return;
            this.form = createSessionForm({ host: this.list, mode, robots, codingAgents, draft: this.draft,
                isBusy: () => this.busy,
                submit: choices => mode === 'supervised' ? this.openPair(choices)
                    : this.open(async () => (await this.api('launch', { robot: choices.session.robotId, codingAgent: choices.session.codingAgent, resume: null })).attach),
            });
        } else if (step === 'sessions') {
            this.heading.textContent = 'Coding sessions';
            this.row('+ New coding session', () => { this.draft = {}; this.move({ step: 'new' }); });
            const result = await this.api('overview');
            for (const entry of result.running || []) this.row(`● robot: ${entry.robotName || entry.robotId} · coding agent: ${entry.codingAgent}${entry.title ? ` · ${entry.title}` : ''}`, () => this.open(() => mintLiveSessionAttach(entry.id)), entry.id, true, this.sessionBadges([entry], { title: entry.title || '', running: true }));
            for (const entry of result.sessions || []) this.savedRow(entry);
            this.notice = result.errors?.length ? `Some histories could not be updated: ${result.errors.join(', ')}. Previously saved sessions are still shown.`
                : '';
        } else if (step === 'pairs' || step === 'roles') {
            const { pairs } = await this.api('pairs');
            if (step === 'pairs') {
                this.heading.textContent = 'Supervised sessions';
                this.row('+ New supervised session', () => { this.draft = {}; this.move({ step: 'new' }); });
                for (const pair of pairs) this.row(`${pair.roles.some(item => item.running) ? '● ' : ''}${pair.roles.map(item => `${item.role === 'worker' ? 'Worker' : 'Supervisor'}: robot: ${item.robotName || item.robotId} · coding agent: ${item.codingAgent}`).join(' → ')} · ${new Date(pair.createdAt).toLocaleString()}`,
                    () => this.move({ step: 'roles', pairId: pair.id }), null, false, this.sessionBadges(pair.roles, { roles: true, title: new Date(pair.createdAt).toLocaleString(), running: pair.roles.some(item => item.running) }));
            } else {
                this.heading.textContent = 'Choose a role';
                const pair = pairs.find(entry => entry.id === this.state.pairId);
                if (!pair) throw new Error('This supervised session is no longer available. Go back and refresh.');
                for (const entry of pair.roles) this.row(`${entry.running ? '● ' : ''}${entry.role === 'worker' ? 'Worker' : 'Supervisor'} · robot: ${entry.robotName || entry.robotId} · coding agent: ${entry.codingAgent}`,
                    () => this.open(async () => (await this.api('open-role', { id: pair.id, role: entry.role })).attach), entry.running ? entry.terminalId : null, entry.running, this.sessionBadges([entry], { roles: true, running: entry.running }));
            }
        }
        this.list.scrollTop = scrollTop;
    }
}
