import { normalizeErrorMessage } from "./git-panel-utils.js";

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const isFileHeaderLine = (line) => {
    if (!line) return false;
    return (
        line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode ') ||
        line.startsWith('deleted file mode ') ||
        line.startsWith('old mode ') ||
        line.startsWith('new mode ') ||
        line.startsWith('similarity index ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('Binary files ') ||
        line.startsWith('GIT binary patch')
    );
};

export const stripUnifiedDiffFileHeaders = (text) => {
    if (!text) return '';
    const lines = String(text).split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        if (isFileHeaderLine(line)) continue;
        out.push(line);
    }
    return out.join('\n');
};

export const stripUnifiedDiffHeaders = (text) => stripUnifiedDiffFileHeaders(text);

export const summarizeUnifiedDiffMeta = (meta) => {
    if (!meta || typeof meta !== 'object') return '';
    const added = Number(meta.added || 0);
    const removed = Number(meta.removed || 0);
    const parts = [];
    if (added) parts.push(`+${added}`);
    if (removed) parts.push(`-${removed}`);
    if (!parts.length && meta.hunks) parts.push(`${meta.hunks} hunks`);
    return parts.join(' ');
};

const makeLineHtml = ({ type, lineNo, sign, text }) => {
    const ln = lineNo === null || lineNo === undefined ? '' : String(lineNo);
    const sg = sign || '';
    const tx = escapeHtml(text);
    return `<span class="diff-line ${type}"><span class="ln">${ln}</span><span class="sg">${sg}</span><span class="tx">${tx}</span></span>`;
};

export const unifiedToSplitHtml = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    const leftLines = [];
    const rightLines = [];
    const meta = { added: 0, removed: 0, hunks: 0, files: 0 };

    let leftNo = 0;
    let rightNo = 0;
    let inHunk = false;

    const pushMetaLine = (line) => {
        leftLines.push(makeLineHtml({ type: 'meta', lineNo: '', sign: '', text: line }));
        rightLines.push(makeLineHtml({ type: 'meta', lineNo: '', sign: '', text: line }));
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            meta.files += 1;
            pushMetaLine(line);
            inHunk = false;
            continue;
        }
        if (isFileHeaderLine(line)) {
            pushMetaLine(line);
            continue;
        }
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                leftNo = Number(match[1] || 0);
                rightNo = Number(match[3] || 0);
                inHunk = true;
                meta.hunks += 1;
            }
            pushMetaLine(line);
            continue;
        }
        if (!inHunk) {
            if (line.trim() === '') continue;
            pushMetaLine(line);
            continue;
        }
        if (line.startsWith('+')) {
            rightLines.push(makeLineHtml({ type: 'add', lineNo: rightNo, sign: '+', text: line.slice(1) }));
            leftLines.push(makeLineHtml({ type: 'empty', lineNo: '', sign: '', text: '' }));
            rightNo += 1;
            meta.added += 1;
            continue;
        }
        if (line.startsWith('-')) {
            leftLines.push(makeLineHtml({ type: 'remove', lineNo: leftNo, sign: '-', text: line.slice(1) }));
            rightLines.push(makeLineHtml({ type: 'empty', lineNo: '', sign: '', text: '' }));
            leftNo += 1;
            meta.removed += 1;
            continue;
        }
        if (line.startsWith('\\')) {
            // The unified diff marker for missing trailing newlines is useful in
            // raw mode, but in split mode it creates noisy duplicated rows on
            // both panes because Git can emit one marker for each side.
            continue;
        }
        if (line.startsWith(' ')) {
            const textLine = line.slice(1);
            leftLines.push(makeLineHtml({ type: 'ctx', lineNo: leftNo, sign: ' ', text: textLine }));
            rightLines.push(makeLineHtml({ type: 'ctx', lineNo: rightNo, sign: ' ', text: textLine }));
            leftNo += 1;
            rightNo += 1;
            continue;
        }

        pushMetaLine(line);
    }

    return {
        leftHtml: leftLines.join(''),
        rightHtml: rightLines.join(''),
        meta
    };
};

export function createGitCommitDiff(ctx) {
    const { element, state, service, diffCache } = ctx;

    const getDiffViewer = () => element.querySelector('git-diff-viewer')?.webSkelPresenter || null;
    const getRepoPath = () => state.selectedRepoPath || state.repoPath;

    const isUntrackedChange = (row) => {
        if (!row) return false;
        const flags = row.flags || {};
        if (flags.untracked) return true;
        if (row.kind === 'untracked') return true;
        return row.x === '?' && row.y === '?';
    };

    const canIgnoreFile = (repoPath, filePath) => {
        if (!repoPath || !filePath) return false;
        const repo = (state.repoOverviews || []).find((item) => item?.path === repoPath) || null;
        const rows = Array.isArray(repo?.changesAll) ? repo.changesAll : [];
        const untracked = Array.isArray(repo?.changes?.untracked)
            ? new Set(repo.changes.untracked.map((row) => String(row || '').trim()).filter(Boolean))
            : null;
        if (untracked?.has(filePath)) return true;
        const match = rows.find((row) => row?.path === filePath) || null;
        return isUntrackedChange(match);
    };

    const renderDiff = (text, { filePath, section, repoPath = null, loading = false, isError = false } = {}) => {
        const viewer = getDiffViewer();
        if (!viewer) return;
        const effectiveRepo = repoPath || getRepoPath();
        const canIgnore = canIgnoreFile(effectiveRepo, filePath);
        if (typeof viewer.setState === 'function') {
            viewer.setState({
                diffText: text || '',
                filePath: filePath || '',
                repoPath: effectiveRepo || '',
                loading: Boolean(loading),
                isError: Boolean(isError),
                canIgnore: Boolean(canIgnore)
            });
            return;
        }
        if (typeof viewer.setDiff === 'function') {
            viewer.setDiff(text, { filePath, section, repoPath: effectiveRepo, loading, isError, canIgnore });
        }
    };

    const refreshActiveRowStyles = () => {};

    const buildDiffCacheKey = (repoPath, section, filePath) => `${repoPath || 'repo'}::${section || 'unknown'}::${filePath}`;

    const loadDiffForSelection = async () => {
        const filePath = state.selectedPath;
        if (!filePath) return;
        const section = state.selectedSection;
        const repoPath = getRepoPath();
        const cachedKey = buildDiffCacheKey(repoPath, section, filePath);
        const cached = diffCache.get(cachedKey);
        if (cached) {
            renderDiff(cached, { filePath, section, repoPath });
            return;
        }

        renderDiff('Loading diff...', { filePath, section, repoPath, loading: true });
        try {
            const text = await service.gitDiff({ path: repoPath, file: filePath, cached: false, ref: 'HEAD' });
            const diffText = text || '(no diff)';
            diffCache.set(cachedKey, diffText);
            renderDiff(diffText, { filePath, section, repoPath });
        } catch (error) {
            const message = normalizeErrorMessage(error);
            renderDiff(message, { filePath, section, repoPath, isError: true });
        }
    };

    const selectFile = async (filePath, section, repoPath = null) => {
        if (!filePath) return;
        if (repoPath) state.selectedRepoPath = repoPath;
        state.selectedPath = filePath;
        state.selectedSection = section || null;
        refreshActiveRowStyles();
        await loadDiffForSelection();
    };

    const clearSelectedDiff = () => {
        state.selectedPath = null;
        state.selectedSection = null;
        renderDiff('', { filePath: null, section: null });
        refreshActiveRowStyles();
    };

    const refreshSelectedDiff = async () => {
        if (!state.selectedPath) {
            clearSelectedDiff();
            return false;
        }
        await loadDiffForSelection();
        return true;
    };

    return {
        selectFile,
        clearSelectedDiff,
        refreshSelectedDiff
    };
}
