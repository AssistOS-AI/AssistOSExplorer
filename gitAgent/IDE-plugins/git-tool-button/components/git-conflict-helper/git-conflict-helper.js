export class GitConflictHelper {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: false,
            files: [],
            selected: null,
            ours: '',
            theirs: '',
            oursConflictRanges: [],
            theirsConflictRanges: [],
            choice: '',
            status: '',
            loading: false,
            source: ''
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('#gitConflictHelper') || this.element;
        this.list = this.element.querySelector('#gitConflictHelperList');
        this.oursNode = this.element.querySelector('#gitConflictHelperOurs');
        this.theirsNode = this.element.querySelector('#gitConflictHelperTheirs');
        this.oursTitle = this.element.querySelector('#gitConflictHelperOursTitle');
        this.theirsTitle = this.element.querySelector('#gitConflictHelperTheirsTitle');
        this.hintNode = this.element.querySelector('.git-conflict-helper-hint');
        this.statusNode = this.element.querySelector('#gitConflictHelperStatus');
        this.choiceButtons = Array.from(this.element.querySelectorAll('.git-conflict-choice'));
        this.saveButton = this.element.querySelector('.git-conflict-save');
        this.applyState(this.state);
    }

    selectConflictFile(element) {
        const repoPath = element?.dataset?.repoPath || '';
        const filePath = element?.dataset?.filePath || '';
        if (!filePath) return;
        this.getParentPresenter()?.selectConflictFile?.({ repoPath, filePath });
    }

    applyConflictChoice(_element, source) {
        const selected = this.state.selected || {};
        if (!selected.filePath || !selected.repoPath) return;
        const side = String(source || '').trim();
        if (side !== 'ours' && side !== 'theirs') return;
        this.getParentPresenter()?.applyConflictChoice?.({
            repoPath: selected.repoPath,
            filePath: selected.filePath,
            source: side
        });
    }

    saveConflictResolution() {
        const selected = this.state.selected || {};
        if (!selected.filePath || !selected.repoPath) return;
        this.getParentPresenter()?.saveConflictResolution?.({
            repoPath: selected.repoPath,
            filePath: selected.filePath,
            choice: this.state.choice || ''
        });
    }

    cancelConflictResolution() {
        this.getParentPresenter()?.cancelConflictResolution?.();
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next) {
        if (!next || typeof next !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(next, 'visible')) {
            this.state.visible = Boolean(next.visible);
        }
        if (Array.isArray(next.files)) {
            this.state.files = next.files;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'selected')) {
            this.state.selected = next.selected || null;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'ours')) {
            this.state.ours = String(next.ours || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'theirs')) {
            this.state.theirs = String(next.theirs || '');
        }
        if (Array.isArray(next.oursConflictRanges)) {
            this.state.oursConflictRanges = next.oursConflictRanges;
        }
        if (Array.isArray(next.theirsConflictRanges)) {
            this.state.theirsConflictRanges = next.theirsConflictRanges;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'choice')) {
            this.state.choice = String(next.choice || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'status')) {
            this.state.status = String(next.status || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'loading')) {
            this.state.loading = Boolean(next.loading);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'source')) {
            this.state.source = String(next.source || '');
        }

        this.element.classList.toggle('is-visible', this.state.visible);
        if (this.list) {
            this.list.textContent = '';
            for (const file of this.state.files || []) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'git-conflict-helper-file';
                if (this.state.selected && this.state.selected.filePath === file.filePath && this.state.selected.repoPath === file.repoPath) {
                    button.classList.add('active');
                }
                button.dataset.repoPath = file.repoPath || '';
                button.dataset.filePath = file.filePath || '';
                button.setAttribute('data-local-action', 'selectConflictFile');
                button.textContent = file.label || file.filePath || '';
                this.list.appendChild(button);
            }
        }
        const source = (this.state.source || '').toLowerCase();
        if (this.oursNode) {
            this.renderContent(
                this.oursNode,
                this.state.loading ? 'Loading local version...' : (this.state.ours || ''),
                this.state.loading ? [] : this.state.oursConflictRanges
            );
        }
        if (this.theirsNode) {
            this.renderContent(
                this.theirsNode,
                this.state.loading ? 'Loading remote version...' : (this.state.theirs || ''),
                this.state.loading ? [] : this.state.theirsConflictRanges
            );
        }
        if (this.oursTitle || this.theirsTitle) {
            if (this.oursTitle) this.oursTitle.textContent = 'Local (ours)';
            if (this.theirsTitle) this.theirsTitle.textContent = source === 'stash' ? 'Stash (theirs)' : 'Remote (theirs)';
        }
        if (this.hintNode) {
            this.hintNode.textContent = source === 'stash'
                ? 'Compare local (ours) and stashed changes (theirs). Pick one, then save to resolve.'
                : 'Compare local (ours) and remote (theirs). Pick one, then save to resolve.';
        }
        if (this.statusNode) {
            this.statusNode.textContent = this.state.status || '';
        }
        if (this.choiceButtons?.length) {
            const disableChoices = Boolean(this.state.loading);
            for (const button of this.choiceButtons) {
                const action = button.getAttribute('data-local-action') || '';
                const selected = action.includes('ours') ? 'ours' : action.includes('theirs') ? 'theirs' : '';
                button.classList.toggle('is-selected', Boolean(selected && selected === this.state.choice));
                button.disabled = disableChoices;
                button.classList.toggle('is-disabled', disableChoices);
            }
        }
        if (this.saveButton) {
            const canSave = Boolean(this.state.choice) && !this.state.loading;
            this.saveButton.disabled = !canSave;
            this.saveButton.classList.toggle('is-ready', canSave);
        }
    }

    renderContent(node, text, ranges = []) {
        node.textContent = '';
        const lines = String(text || '').split('\n');
        const highlighted = new Set();
        for (const range of ranges || []) {
            const start = Number(range?.start);
            const end = Number(range?.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            for (let index = Math.max(0, start); index <= Math.min(lines.length - 1, end); index += 1) {
                highlighted.add(index);
            }
        }
        for (let index = 0; index < lines.length; index += 1) {
            const line = document.createElement('span');
            line.className = 'git-conflict-helper-line';
            if (highlighted.has(index)) {
                line.classList.add('is-conflict');
            }
            line.textContent = lines[index] || ' ';
            node.appendChild(line);
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
