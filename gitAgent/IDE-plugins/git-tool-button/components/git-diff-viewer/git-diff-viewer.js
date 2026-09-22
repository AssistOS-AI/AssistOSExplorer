import { unifiedToSplitHtml, stripUnifiedDiffHeaders, stripUnifiedDiffFileHeaders, summarizeUnifiedDiffMeta } from "../git-panel/git-panel-diff.js";

export class GitDiffViewer {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        this.state = {
            diffText: '',
            filePath: '',
            repoPath: '',
            loading: false,
            isError: false,
            mode: 'split',
            canIgnore: false
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.bindEvents();
        this.render();
    }

    bindEvents() {
        const left = this.element.querySelector('#gitDiffLeft');
        const right = this.element.querySelector('#gitDiffRight');
        if (left && right && !this.element.dataset.boundDiffScroll) {
            let syncing = false;
            const sync = (source, target) => {
                if (syncing) return;
                syncing = true;
                target.scrollTop = source.scrollTop;
                target.scrollLeft = source.scrollLeft;
                syncing = false;
            };
            left.addEventListener('scroll', () => sync(left, right), { passive: true });
            right.addEventListener('scroll', () => sync(right, left), { passive: true });
            this.element.dataset.boundDiffScroll = 'true';
        }
    }

    setDiffMode(element, mode) {
        const next = (mode || element?.dataset?.mode || '').trim();
        if (next !== 'split' && next !== 'unified') return;
        this.state.mode = next;
        this.render();
    }

    setDiff(text, { filePath = null, repoPath = null, loading = false, isError = false, canIgnore = false } = {}) {
        this.state.diffText = text || '';
        this.state.filePath = filePath || '';
        this.state.repoPath = repoPath || '';
        this.state.loading = Boolean(loading);
        this.state.isError = Boolean(isError);
        this.state.canIgnore = Boolean(canIgnore);
        this.render();
    }

    ignoreFile() {
        const filePath = this.state.filePath;
        const repoPath = this.state.repoPath;
        if (!filePath || !repoPath || !this.state.canIgnore) return;
        this.getParentPresenter()?.openIgnoreForDiff?.({ filePath, repoPath });
    }

    setState(next = {}) {
        if (!next || typeof next !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(next, 'diffText')) {
            this.state.diffText = String(next.diffText || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'filePath')) {
            this.state.filePath = String(next.filePath || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'repoPath')) {
            this.state.repoPath = String(next.repoPath || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'loading')) {
            this.state.loading = Boolean(next.loading);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'isError')) {
            this.state.isError = Boolean(next.isError);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'canIgnore')) {
            this.state.canIgnore = Boolean(next.canIgnore);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'mode')) {
            this.state.mode = String(next.mode || 'split') || 'split';
        }
        this.render();
    }

    render() {
        const title = this.element.querySelector('#gitDiffTitle');
        const meta = this.element.querySelector('#gitDiffMeta');
        const body = this.element.querySelector('#gitDiffBody');
        const split = this.element.querySelector('#gitDiffSplit');
        const left = this.element.querySelector('#gitDiffLeft');
        const right = this.element.querySelector('#gitDiffRight');
        const ignoreButton = this.element.querySelector('#gitDiffIgnore');
        if (title) title.textContent = 'Diff';

        const mode = this.state.mode || 'split';
        if (split) split.style.display = mode === 'split' ? '' : 'none';
        if (body) body.style.display = mode === 'unified' ? '' : 'none';
        if (ignoreButton) {
            const showIgnore = Boolean(this.state.canIgnore && this.state.filePath && this.state.repoPath);
            ignoreButton.style.display = showIgnore ? '' : 'none';
        }

        if (mode === 'split') {
            const stripped = stripUnifiedDiffFileHeaders(this.state.diffText);
            const { leftHtml, rightHtml, meta: diffMeta } = unifiedToSplitHtml(stripped);
            if (meta) {
                const parts = [];
                if (this.state.filePath) parts.push(this.state.filePath);
                const summary = summarizeUnifiedDiffMeta(diffMeta);
                if (summary) parts.push(summary);
                if (this.state.loading) parts.push('loading…');
                meta.textContent = parts.join(' · ');
            }
            if (left) left.innerHTML = leftHtml;
            if (right) right.innerHTML = rightHtml;
            left?.classList.toggle('error', this.state.isError);
            right?.classList.toggle('error', this.state.isError);
        } else if (body) {
            body.textContent = stripUnifiedDiffHeaders(this.state.diffText);
            if (meta) {
                const parts = [];
                if (this.state.filePath) parts.push(this.state.filePath);
                if (this.state.loading) parts.push('loading…');
                meta.textContent = parts.join(' · ');
            }
            body.classList.toggle('error', this.state.isError);
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
