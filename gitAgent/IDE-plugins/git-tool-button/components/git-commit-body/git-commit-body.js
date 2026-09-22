const GIT_TREE_WIDTH_STORAGE_KEY = 'fileExplorer.gitModal.treeWidthPx';
const GIT_TREE_WIDTH_PERCENT_STORAGE_KEY = 'fileExplorer.gitModal.treeWidthPercent';
const MIN_TREE_WIDTH_PX = 280;
const MIN_DIFF_WIDTH_PX = 320;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function loadStoredGitTreeWidthPx() {
    try {
        const stored = window.localStorage?.getItem(GIT_TREE_WIDTH_STORAGE_KEY);
        const value = Number.parseFloat(String(stored || ''));
        return Number.isFinite(value) ? Math.max(MIN_TREE_WIDTH_PX, Math.round(value)) : null;
    } catch {
        return null;
    }
}

function loadStoredGitTreeWidthPercent() {
    try {
        const stored = window.localStorage?.getItem(GIT_TREE_WIDTH_PERCENT_STORAGE_KEY);
        const value = Number.parseFloat(String(stored || ''));
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function saveGitTreeWidthPx(value) {
    try {
        window.localStorage?.setItem(GIT_TREE_WIDTH_STORAGE_KEY, String(Math.max(MIN_TREE_WIDTH_PX, Math.round(value))));
    } catch {}
}

export class GitCommitBody {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: true,
            repoPath: '',
            advancedMode: false,
            treeWidthPx: loadStoredGitTreeWidthPx(),
            mobileTreeVisible: true
        };
        this.boundActions = false;
        this.mainResizer = null;
        this.stopResizeMove = null;
        this.stopResizeUp = null;
        this.handleMainResizerMouseDown = this.handleMainResizerMouseDown.bind(this);
        this.handleMobileTreeToggleClick = this.handleMobileTreeToggleClick.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.advancedModeInput = this.element.querySelector('#gitAdvancedMode');
        this.bindEvents();
        this.bindMainResizer();
        this.applyState(this.state);
        window.requestAnimationFrame(() => {
            this.applyState({ treeWidthPx: this.state.treeWidthPx });
        });
        const parent = this.getParentPresenter();
        parent?.updateCommitButtons?.();
        parent?.syncStaticUI?.();
    }

    bindEvents() {
        if (this.boundActions) return;
        if (this.advancedModeInput) {
            this.advancedModeInput.addEventListener('change', () => {
                this.toggleAdvancedMode();
            });
        }
        this.element.addEventListener('click', this.handleClick);
        this.boundActions = true;
    }

    handleClick(event) {
        if (event.target?.closest?.('#gitMobileTreeToggle')) {
            this.handleMobileTreeToggleClick();
        }
    }

    bindMainResizer() {
        const nextResizer = this.element.querySelector('#gitMainResizer');
        if (this.mainResizer === nextResizer) return;
        if (this.mainResizer) {
            this.mainResizer.removeEventListener('mousedown', this.handleMainResizerMouseDown);
        }
        this.mainResizer = nextResizer;
        if (this.mainResizer) {
            this.mainResizer.addEventListener('mousedown', this.handleMainResizerMouseDown);
        }
    }

    stopResizeTracking() {
        if (typeof this.stopResizeMove === 'function') {
            this.stopResizeMove();
        }
        if (typeof this.stopResizeUp === 'function') {
            this.stopResizeUp();
        }
        this.stopResizeMove = null;
        this.stopResizeUp = null;
        this.element.querySelector('.git-main')?.classList.remove('resizing');
    }

    handleMobileTreeToggleClick() {
        this.state.mobileTreeVisible = !this.state.mobileTreeVisible;
        this.syncMobileTreeToggle();
    }

    addDocumentListener(type, listener) {
        document.addEventListener(type, listener);
        return () => document.removeEventListener(type, listener);
    }

    resolveTreeWidthBounds() {
        const gitMain = this.element.querySelector('.git-main');
        const mainWidth = gitMain?.getBoundingClientRect().width || 0;
        const maxWidth = Number.isFinite(mainWidth) && mainWidth > 0
            ? Math.max(MIN_TREE_WIDTH_PX, Math.round(mainWidth - MIN_DIFF_WIDTH_PX))
            : 900;
        return {
            min: MIN_TREE_WIDTH_PX,
            max: maxWidth
        };
    }

    applyTreeWidth(widthPx) {
        const gitMain = this.element.querySelector('.git-main');
        const { min, max } = this.resolveTreeWidthBounds();
        const fallbackWidth = gitMain?.querySelector('git-repo-tree')?.getBoundingClientRect().width || 420;
        const next = clamp(Math.round(Number(widthPx) || fallbackWidth), min, max);
        this.state.treeWidthPx = next;
        gitMain?.style.setProperty('--git-tree-width', `${next}px`);
        return next;
    }

    handleMainResizerMouseDown(event) {
        const gitMain = this.element.querySelector('.git-main');
        const repoTree = this.element.querySelector('git-repo-tree');
        if (!gitMain || !repoTree) return;

        event.preventDefault();
        const startX = event.clientX;
        const startWidth = repoTree.getBoundingClientRect().width || this.state.treeWidthPx || MIN_TREE_WIDTH_PX;
        const mainWidth = gitMain.getBoundingClientRect().width;
        if (!Number.isFinite(mainWidth) || mainWidth <= 0) return;

        const safeMin = MIN_TREE_WIDTH_PX;
        const safeMax = Math.max(safeMin, Math.round(mainWidth - MIN_DIFF_WIDTH_PX));

        gitMain.classList.add('resizing');

        const onMouseMove = (moveEvent) => {
            const delta = moveEvent.clientX - startX;
            const nextWidth = startWidth + delta;
            this.applyTreeWidth(clamp(nextWidth, safeMin, safeMax));
        };

        const onMouseUp = () => {
            const current = this.applyTreeWidth(this.state.treeWidthPx);
            saveGitTreeWidthPx(current);
            this.stopResizeTracking();
        };

        this.stopResizeTracking();
        this.stopResizeMove = this.addDocumentListener('mousemove', onMouseMove);
        this.stopResizeUp = this.addDocumentListener('mouseup', onMouseUp);
    }

    setState(next = {}) {
        this.applyState(next);
    }

    applyState(next = {}) {
        if (Object.prototype.hasOwnProperty.call(next, 'visible')) {
            this.state.visible = Boolean(next.visible);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'repoPath')) {
            this.state.repoPath = String(next.repoPath || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'advancedMode')) {
            this.state.advancedMode = Boolean(next.advancedMode);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'treeWidthPx')) {
            this.state.treeWidthPx = Math.max(MIN_TREE_WIDTH_PX, Math.round(Number(next.treeWidthPx) || 420));
        }
        this.element.classList.toggle('is-hidden', !this.state.visible);
        const commitSection = this.element.querySelector('.git-commit');
        if (commitSection) {
            commitSection.classList.toggle('advanced-mode', this.state.advancedMode);
        }
        this.syncMobileTreeToggle();
        const fallbackPercent = loadStoredGitTreeWidthPercent();
        const mainWidth = this.element.querySelector('.git-main')?.getBoundingClientRect().width || 0;
        const effectiveWidth = this.state.treeWidthPx
            || (Number.isFinite(fallbackPercent) && mainWidth > 0 ? Math.round((fallbackPercent / 100) * mainWidth) : null)
            || 420;
        this.applyTreeWidth(effectiveWidth);
        if (this.advancedModeInput) {
            this.advancedModeInput.checked = this.state.advancedMode;
        }
    }

    syncMobileTreeToggle() {
        const gitMain = this.element.querySelector('.git-main');
        const repoTree = this.element.querySelector('#gitRepoTreePanel');
        const gitChanges = repoTree?.querySelector?.('.git-changes');
        const toggle = this.element.querySelector('#gitMobileTreeToggle');
        const visible = this.state.mobileTreeVisible !== false;
        gitMain?.classList.toggle('mobile-tree-hidden', !visible);
        repoTree?.classList.toggle('mobile-tree-collapsed', !visible);
        gitChanges?.classList.toggle('mobile-tree-collapsed', !visible);
        if (toggle) {
            toggle.classList.toggle('is-collapsed', !visible);
            toggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
            const label = visible ? 'Collapse repositories' : 'Expand repositories';
            toggle.setAttribute('aria-label', label);
            toggle.setAttribute('title', label);
        }
    }

    refreshAction() {
        this.getParentPresenter()?.refreshAction?.();
    }

    toggleAdvancedMode() {
        const next = Boolean(this.advancedModeInput?.checked);
        this.state.advancedMode = next;
        const commitSection = this.element.querySelector('.git-commit');
        if (commitSection) {
            commitSection.classList.toggle('advanced-mode', next);
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }
}
