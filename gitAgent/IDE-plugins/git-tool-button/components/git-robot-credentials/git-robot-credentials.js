import {
    normalizeRobotTargets,
    describeRobotRow,
    planAutomaticRobotSave,
    describeRobotSaveResult,
    describeRobotRemoveResult,
    combineRobotResults
} from './robot-credentials-state.js';

// Robot access section of the Git credentials prompt. It lists every RoboTeam robot with its own actions to add or
// remove the user's GitHub credentials through the git panel's service; sign-in also saves them to the default robot.
// The token never reaches the browser: gitAgent reads it from DPU on the server side.
export class GitRobotCredentials {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: false,
            connected: false,
            loading: false,
            loaded: false,
            // { robot, kind } while one robot's save or removal runs; actions on every robot wait for it.
            busy: null,
            targets: normalizeRobotTargets(null),
            // Last save or removal outcome per robot name, shown on that robot.
            results: {}
        };
        this.loadVersion = 0;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.git-robot-credentials');
        this.unavailableNode = this.element.querySelector('[data-role="unavailable"]');
        this.bodyNode = this.element.querySelector('[data-role="body"]');
        this.listNode = this.element.querySelector('[data-role="list"]');
        this.renderedListKey = '';
        const context = this.element.closest('git-credentials-prompt')?.webSkelPresenter?.getRobotCredentialsContext?.();
        if (context) this.setContext(context);
        this.project();
    }

    afterUnload() {
        this.loadVersion += 1;
    }

    getPanelPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }

    // Called by the credentials prompt whenever its visibility or sign-in state changes.
    setContext({ visible = false, connected = false } = {}) {
        const becameVisible = Boolean(visible) && !this.state.visible;
        this.state.visible = Boolean(visible);
        this.state.connected = Boolean(connected);
        if (becameVisible) {
            this.state.results = {};
            void this.loadTargets();
            return;
        }
        this.project();
    }

    async loadTargets() {
        const panel = this.getPanelPresenter();
        if (!panel?.listRobotCredentialTargets) return this.state.targets;
        const version = ++this.loadVersion;
        this.state.loading = true;
        this.project();
        let payload = null;
        try {
            payload = await panel.listRobotCredentialTargets();
        } catch (_) {
            payload = null;
        }
        if (version !== this.loadVersion) return this.state.targets;
        this.state.targets = normalizeRobotTargets(payload);
        this.state.loading = false;
        this.state.loaded = true;
        this.project();
        return this.state.targets;
    }

    rowFor(robotName) {
        const robot = this.state.targets.robots.find((entry) => entry.name === robotName);
        return robot ? describeRobotRow(robot, this.state.targets, { connected: this.state.connected }) : null;
    }

    // Link actions carry the robot name in data-robot.
    async saveToRobot(target) {
        const robotName = String(target?.dataset?.robot || '');
        if (!this.rowFor(robotName)?.canSave || this.state.busy) return null;
        const [outcome] = await this.runSave([robotName]);
        return outcome;
    }

    async removeFromRobot(target) {
        const robotName = String(target?.dataset?.robot || '');
        if (!this.rowFor(robotName)?.canRemove || this.state.busy) return null;
        const panel = this.getPanelPresenter();
        if (!panel?.deleteRobotCredentials) return null;
        this.state.busy = { robot: robotName, kind: 'removing' };
        delete this.state.results[robotName];
        this.project();
        const result = await panel.deleteRobotCredentials(robotName).catch((error) => ({ ok: false, message: error?.message }));
        const outcome = describeRobotRemoveResult(result, robotName);
        this.state.busy = null;
        this.state.results[robotName] = outcome;
        await this.loadTargets();
        return outcome;
    }

    // Called after a successful GitHub sign-in or manual token save.
    async saveAfterSignIn() {
        this.state.connected = true;
        if (!this.state.loaded) await this.loadTargets();
        const plan = planAutomaticRobotSave({ targets: this.state.targets });
        if (!plan.save) {
            if (plan.message && plan.robotName) {
                this.state.results[plan.robotName] = { tone: plan.tone || 'warning', text: plan.message };
                this.project();
            }
            return { saved: false, message: plan.message };
        }
        const outcomes = await this.runSave(plan.robotNames);
        return {
            saved: outcomes.length > 0 && outcomes.every((outcome) => outcome.tone === 'success'),
            message: combineRobotResults(outcomes)?.text || ''
        };
    }

    async runSave(robotNames) {
        const panel = this.getPanelPresenter();
        if (!panel?.saveRobotCredentials) return [];
        const outcomes = [];
        for (const robotName of robotNames) {
            this.state.busy = { robot: robotName, kind: 'saving' };
            delete this.state.results[robotName];
            this.project();
            const result = await panel.saveRobotCredentials(robotName).catch((error) => ({ ok: false, message: error?.message }));
            const outcome = describeRobotSaveResult(result, robotName);
            this.state.results[robotName] = outcome;
            outcomes.push(outcome);
        }
        this.state.busy = null;
        await this.loadTargets();
        return outcomes;
    }

    buildLink(action, robotName, label, busyLabel, isBusy, disabled) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'git-robot-credentials-link';
        link.dataset.localAction = action;
        link.dataset.robot = robotName;
        link.textContent = isBusy ? busyLabel : label;
        link.disabled = disabled;
        link.setAttribute('aria-busy', isBusy ? 'true' : 'false');
        return link;
    }

    buildRow(row) {
        const busy = this.state.busy;
        const anyBusy = Boolean(busy) || this.state.loading;
        const item = document.createElement('li');
        item.className = 'git-robot-credentials-item';
        item.dataset.tone = row.tone;
        if (row.isDefault) item.dataset.default = 'true';
        const name = document.createElement('span');
        name.className = 'git-robot-credentials-item-name';
        name.textContent = row.label;
        const status = document.createElement('span');
        status.className = 'git-robot-credentials-item-status';
        status.textContent = row.note ? `${row.status}. ${row.note}` : row.status;
        item.append(name, status);
        const actions = document.createElement('div');
        actions.className = 'git-robot-credentials-item-actions';
        const mine = busy?.robot === row.name;
        if (row.canSave) {
            actions.append(this.buildLink('saveToRobot', row.name, row.saveLabel, 'Adding…', mine && busy.kind === 'saving', anyBusy));
        }
        if (row.canRemove) {
            actions.append(this.buildLink('removeFromRobot', row.name, 'Remove', 'Removing…', mine && busy.kind === 'removing', anyBusy));
        }
        if (actions.childElementCount) item.append(actions);
        const result = this.state.results[row.name];
        if (result?.text) {
            const note = document.createElement('span');
            note.className = 'git-robot-credentials-item-result';
            note.dataset.tone = result.tone;
            note.setAttribute('role', 'status');
            note.textContent = result.text;
            item.append(note);
        }
        return item;
    }

    syncList() {
        if (!this.listNode) return;
        const rows = this.state.targets.robots.map((robot) => describeRobotRow(robot, this.state.targets, { connected: this.state.connected }));
        const key = JSON.stringify({ rows, busy: this.state.busy, loading: this.state.loading, results: this.state.results });
        if (key === this.renderedListKey) return;
        this.renderedListKey = key;
        const scroll = this.listNode.scrollTop;
        this.listNode.replaceChildren(...rows.map((row) => this.buildRow(row)));
        this.listNode.scrollTop = scroll;
    }

    project() {
        if (!this.root) return;
        const { targets, loading } = this.state;
        let stateName = 'ready';
        if (loading && !this.state.loaded) stateName = 'loading';
        else if (!targets.available) stateName = 'unavailable';
        this.root.dataset.state = stateName;

        if (this.unavailableNode) {
            const note = stateName === 'loading' ? 'Loading robots…' : (targets.note || '');
            this.unavailableNode.hidden = !note || (stateName === 'ready' && targets.robots.length > 0);
            this.unavailableNode.textContent = note;
        }
        if (this.bodyNode) this.bodyNode.hidden = stateName !== 'ready' || targets.robots.length === 0;
        this.syncList();
    }
}
