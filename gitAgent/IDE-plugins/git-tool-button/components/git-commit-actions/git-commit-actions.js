export class GitCommitActions {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            commitMessage: '',
            actionsMenuOpen: false,
            actionsDisabled: false,
            hiddenActions: []
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.commitMessageInput = this.element.querySelector('#gitCommitMessage');
        this.actionsMenu = this.element.querySelector('#gitActionsMenu');
        this.actionsButton = this.element.querySelector('#gitActionsButton');
        this.actionsSplit = this.element.querySelector('#gitActionsSplit');
        this.attachDelegatedListeners();
        this.applyState(this.state);
    }

    afterUnload() {
        this.detachDelegatedListeners();
    }

    onInput(event) {
        const target = event?.target;
        if (target?.id === 'gitCommitMessage') {
            this.updateCommitMessage(null, target.value || '');
        }
    }

    onClick(event) {
        const info = event?.target?.closest?.('.git-menu-info');
        if (!info) return;
        event.preventDefault();
        event.stopPropagation();
    }

    onKeydown(event) {
        const info = event?.target?.closest?.('.git-menu-info');
        if (info) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const key = event.key;
        if (key !== 'Enter' && key !== ' ') return;
        const target = event.target?.closest?.('.git-menu-item[data-local-action^="runGitAction"]');
        if (!target) return;
        event.preventDefault();
        const action = target.getAttribute('data-local-action') || '';
        if (!action.startsWith('runGitAction')) return;
        const mode = action.split(/\s+/)[1] || '';
        this.runGitAction(target, mode);
    }

    attachDelegatedListeners() {
        if (this.delegatedListenersAttached || !this.element) return;
        this.handleDelegatedInput = (event) => this.onInput(event);
        this.handleDelegatedClick = (event) => this.onClick(event);
        this.handleDelegatedKeydown = (event) => this.onKeydown(event);
        this.element.addEventListener('input', this.handleDelegatedInput);
        this.element.addEventListener('click', this.handleDelegatedClick, true);
        this.element.addEventListener('keydown', this.handleDelegatedKeydown, true);
        this.delegatedListenersAttached = true;
    }

    detachDelegatedListeners() {
        if (!this.delegatedListenersAttached || !this.element) return;
        this.element.removeEventListener('input', this.handleDelegatedInput);
        this.element.removeEventListener('click', this.handleDelegatedClick, true);
        this.element.removeEventListener('keydown', this.handleDelegatedKeydown, true);
        this.handleDelegatedInput = null;
        this.handleDelegatedClick = null;
        this.handleDelegatedKeydown = null;
        this.delegatedListenersAttached = false;
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next = {}) {
        if (Object.prototype.hasOwnProperty.call(next, 'commitMessage')) {
            this.state.commitMessage = String(next.commitMessage || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'actionsMenuOpen')) {
            this.state.actionsMenuOpen = Boolean(next.actionsMenuOpen);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'actionsDisabled')) {
            this.state.actionsDisabled = Boolean(next.actionsDisabled);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'hiddenActions')) {
            this.state.hiddenActions = Array.isArray(next.hiddenActions) ? [...next.hiddenActions] : [];
        }
        if (this.commitMessageInput && this.commitMessageInput.value !== this.state.commitMessage) {
            this.commitMessageInput.value = this.state.commitMessage;
        }
        if (this.actionsMenu) {
            this.actionsMenu.style.display = this.state.actionsMenuOpen ? '' : 'none';
        }
        if (this.actionsButton) {
            this.actionsButton.disabled = this.state.actionsDisabled;
        }
        const hiddenActions = new Set(this.state.hiddenActions);
        for (const item of this.actionsMenu?.querySelectorAll?.('.git-menu-item[data-local-action^="runGitAction"]') || []) {
            const mode = (item.getAttribute('data-local-action') || '').split(/\s+/)[1] || '';
            item.hidden = hiddenActions.has(mode);
        }
    }

    updateCommitMessage(_element, value) {
        const nextValue = typeof value === 'string' ? value : this.commitMessageInput?.value || '';
        this.state.commitMessage = nextValue;
        this.getParentPresenter()?.updateCommitMessageDraft?.(nextValue);
    }

    generateCommitMessage() {
        this.getParentPresenter()?.generateCommitMessage?.();
    }

    toggleActionsMenu() {
        this.state.actionsMenuOpen = !this.state.actionsMenuOpen;
        this.applyState(this.state);
        if (this.state.actionsMenuOpen) {
            setTimeout(() => this.actionsMenu?.querySelector?.('.git-menu-item')?.focus?.(), 0);
        }
    }

    closeActionsMenu() {
        if (!this.state.actionsMenuOpen) return;
        this.state.actionsMenuOpen = false;
        this.applyState(this.state);
    }

    runGitAction(element, mode) {
        this.closeActionsMenu();
        this.getParentPresenter()?.runGitAction?.(element, mode);
    }

    focusCommitMessage() {
        this.commitMessageInput?.focus?.();
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
