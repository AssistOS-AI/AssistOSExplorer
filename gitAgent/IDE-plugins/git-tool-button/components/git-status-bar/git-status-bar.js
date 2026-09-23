export class GitStatusBar {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            text: '',
            isError: false
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.git-status') || this.element;
        this.textNode = this.element.querySelector('.git-status-text');
        this.applyState(this.state);
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next = {}) {
        if (!next || typeof next !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(next, 'text')) {
            this.state.text = String(next.text || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'isError')) {
            this.state.isError = Boolean(next.isError);
        }
        if (this.textNode) {
            this.textNode.textContent = this.state.text;
        } else if (this.root) {
            this.root.textContent = this.state.text;
        }
        if (this.root) {
            this.root.classList.toggle('error', this.state.isError);
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
