export class GitConflictBanner {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: false,
            count: 0
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('#gitConflictBanner') || this.element;
        this.subtitle = this.element.querySelector('#gitConflictBannerSubtitle');
        this.applyState(this.state);
    }

    openConflictHelper() {
        this.getParentPresenter()?.openConflictHelper?.();
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next = {}) {
        if (!next || typeof next !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(next, 'visible')) {
            this.state.visible = Boolean(next.visible);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'count')) {
            this.state.count = Number(next.count || 0);
        }

        this.element.classList.toggle('is-visible', this.state.visible);
        if (this.subtitle) {
            if (this.state.count > 0) {
                const label = this.state.count === 1 ? 'file' : 'files';
                this.subtitle.textContent = `${this.state.count} ${label} need attention before continuing.`;
            } else {
                this.subtitle.textContent = 'Resolve conflicted files before continuing.';
            }
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
