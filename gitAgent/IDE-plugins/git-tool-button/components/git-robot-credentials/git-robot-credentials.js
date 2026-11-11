import {
    NO_ROBOT,
    normalizeRobotTargets,
    pickRobotSelection,
    buildRobotOptions,
    describeRobotSelection,
    planAutomaticRobotSave,
    describeRobotSaveResult,
    describeRobotRemoveResult
} from './robot-credentials-state.js';

// Robot access section of the Git credentials prompt. It lists RoboTeam robots, keeps the selected
// robot, and saves or removes the user's GitHub credentials through the git panel's service.
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
            busy: '',
            targets: normalizeRobotTargets(null),
            selection: '',
            result: null
        };
        this.loadVersion = 0;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.git-robot-credentials');
        this.unavailableNode = this.element.querySelector('[data-role="unavailable"]');
        this.bodyNode = this.element.querySelector('[data-role="body"]');
        this.selectNode = this.element.querySelector('#gitRobotCredentialsTarget');
        this.noticeNode = this.element.querySelector('[data-role="notice"]');
        this.warningNode = this.element.querySelector('[data-role="warning"]');
        this.warningTextNode = this.element.querySelector('[data-role="warning-text"]');
        this.adminNoteNode = this.element.querySelector('[data-role="admin-note"]');
        this.saveButton = this.element.querySelector('[data-role="save"]');
        this.removeButton = this.element.querySelector('[data-role="remove"]');
        this.resultNode = this.element.querySelector('[data-role="result"]');
        // The robot picker is a custom-select; its selection arrives as a change event.
        this.handleSelectChange = (event) => this.onSelectionChange(event);
        this.selectNode?.addEventListener('change', this.handleSelectChange);
        const context = this.element.closest('git-credentials-prompt')?.webSkelPresenter?.getRobotCredentialsContext?.();
        if (context) this.setContext(context);
        this.project();
    }

    afterUnload() {
        this.selectNode?.removeEventListener('change', this.handleSelectChange);
        this.handleSelectChange = null;
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
            this.state.result = null;
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
        this.state.selection = pickRobotSelection(this.state.targets.robots, this.state.selection);
        this.state.loading = false;
        this.state.loaded = true;
        this.project();
        return this.state.targets;
    }

    onSelectionChange(event) {
        const value = String(event?.value ?? this.selectNode?.value ?? '').trim();
        this.state.selection = value || NO_ROBOT;
        this.state.result = null;
        this.project();
    }

    async saveToRobot() {
        const description = describeRobotSelection({
            targets: this.state.targets,
            selection: this.state.selection,
            connected: this.state.connected
        });
        if (!description.canSave || this.state.busy) return null;
        return this.runSave(description.robot.name);
    }

    async removeFromRobot() {
        const description = describeRobotSelection({
            targets: this.state.targets,
            selection: this.state.selection,
            connected: this.state.connected
        });
        if (!description.canRemove || this.state.busy) return null;
        const panel = this.getPanelPresenter();
        if (!panel?.deleteRobotCredentials) return null;
        const robotName = description.robot.name;
        this.state.busy = 'removing';
        this.project();
        const result = await panel.deleteRobotCredentials(robotName).catch((error) => ({ ok: false, message: error?.message }));
        this.state.busy = '';
        this.state.result = describeRobotRemoveResult(result, robotName);
        await this.loadTargets();
        return result;
    }

    // Called after a successful GitHub sign-in or manual token save.
    async saveAfterSignIn() {
        this.state.connected = true;
        if (!this.state.loaded) await this.loadTargets();
        const plan = planAutomaticRobotSave({ targets: this.state.targets, selection: this.state.selection });
        if (!plan.save) {
            if (plan.message) {
                this.state.result = { tone: plan.tone || 'warning', text: plan.message };
                this.project();
            }
            return { saved: false, message: plan.message };
        }
        const result = await this.runSave(plan.robotName);
        return { saved: Boolean(result?.ok), message: this.state.result?.text || '' };
    }

    async runSave(robotName) {
        const panel = this.getPanelPresenter();
        if (!panel?.saveRobotCredentials) return null;
        this.state.busy = 'saving';
        this.state.result = null;
        this.project();
        const result = await panel.saveRobotCredentials(robotName).catch((error) => ({ ok: false, message: error?.message }));
        this.state.busy = '';
        this.state.result = describeRobotSaveResult(result, robotName);
        await this.loadTargets();
        return result;
    }

    syncSelect(options) {
        if (!this.selectNode) return;
        const encoded = encodeURIComponent(JSON.stringify(options));
        if (this.selectNode.getAttribute('data-options') !== encoded) {
            this.selectNode.setAttribute('data-options', encoded);
        }
        this.selectNode.setAttribute('data-selected', this.state.selection || NO_ROBOT);
        const disabled = !this.state.targets.available || this.state.loading || Boolean(this.state.busy);
        this.selectNode.toggleAttribute('disabled', disabled);
        const select = this.selectNode.webSkelPresenter;
        if (!select?.setOptions) return;
        const key = `${encoded}|${this.state.selection}`;
        if (this.renderedSelectKey !== key) {
            select.setOptions(options, this.state.selection || NO_ROBOT);
            this.renderedSelectKey = key;
        }
        select.applyDisabledState?.();
    }

    project() {
        if (!this.root) return;
        const { targets, loading, busy, result } = this.state;
        const description = describeRobotSelection({
            targets,
            selection: this.state.selection,
            connected: this.state.connected
        });
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
        this.syncSelect(buildRobotOptions(targets.robots));

        if (this.noticeNode) {
            this.noticeNode.hidden = !description.notice;
            this.noticeNode.textContent = description.notice;
        }
        if (this.warningNode) {
            this.warningNode.hidden = !description.warning;
            if (this.warningTextNode) this.warningTextNode.textContent = description.warning;
            if (this.adminNoteNode) this.adminNoteNode.textContent = description.adminNote;
        }
        if (this.saveButton) {
            this.saveButton.hidden = !this.state.connected || !description.robot;
            this.saveButton.disabled = !description.canSave || Boolean(busy);
            this.saveButton.textContent = busy === 'saving' ? 'Saving…' : description.saveLabel;
            this.saveButton.setAttribute('aria-busy', busy === 'saving' ? 'true' : 'false');
        }
        if (this.removeButton) {
            this.removeButton.hidden = !description.canRemove;
            this.removeButton.disabled = Boolean(busy);
            this.removeButton.textContent = busy === 'removing' ? 'Removing…' : 'Remove from robot';
            this.removeButton.setAttribute('aria-busy', busy === 'removing' ? 'true' : 'false');
        }
        if (this.resultNode) {
            this.resultNode.hidden = !result?.text;
            this.resultNode.textContent = result?.text || '';
            if (result?.tone) this.resultNode.dataset.tone = result.tone;
            else delete this.resultNode.dataset.tone;
        }
    }
}
