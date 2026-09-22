export class GitPullBlockedPanel {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: false,
            repoLabel: '',
            files: []
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.git-pull-blocked-panel') || this.element;
        this.list = this.element.querySelector('.git-pull-blocked-list');
        this.applyState(this.state);
    }

    openDiff(element) {
        const repoPath = element?.dataset?.repoPath || '';
        const filePath = element?.dataset?.filePath || '';
        if (!filePath) return;
        this.getParentPresenter()?.openDiff?.({ repoPath, filePath });
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next = {}) {
        if (!next || typeof next !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(next, 'visible')) {
            this.state.visible = Boolean(next.visible);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'repoLabel')) {
            this.state.repoLabel = String(next.repoLabel || '');
        }
        if (Array.isArray(next.files)) {
            this.state.files = next.files;
        }

        const show = Boolean(this.state.visible && this.state.files.length);
        if (this.root) {
            this.root.style.display = show ? 'flex' : 'none';
        }
        if (!show) {
            if (this.list) this.list.textContent = '';
            return;
        }

        if (this.list) {
            this.list.textContent = '';
            for (const file of this.state.files) {
                if (!file?.filePath) continue;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'git-pull-blocked-item';
                button.dataset.repoPath = file.repoPath || '';
                button.dataset.filePath = file.filePath;
                button.setAttribute('data-local-action', 'openDiff');
                button.textContent = file.label || file.filePath;
                this.list.appendChild(button);
            }
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
