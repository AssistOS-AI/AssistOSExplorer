import {
    normalizeErrorMessage,
    parseJsonToolResult,
    setGitConflictFlag
} from "./git-panel-utils.js";
import { AUTOCOMMIT_RESET_EVENT } from "/explorer/utils/appEvents.js";

export function createConflictActions(ctx) {
    const {
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        syncStaticUI,
        refreshAll,
        loadRepoOverviews,
        collectConflictedItems,
        hasConflictsForRepos,
        handlePullConflicts,
        maybeRestoreAutoStash,
        updateRepoOverviewFromStatus
    } = ctx;

    const splitLines = (text) => String(text || '').split('\n');

    const trimSharedConflictLines = (ours, theirs) => {
        const left = Array.isArray(ours) ? ours : [];
        const right = Array.isArray(theirs) ? theirs : [];
        let start = 0;
        while (start < left.length && start < right.length && left[start] === right[start]) {
            start += 1;
        }
        let leftEnd = left.length - 1;
        let rightEnd = right.length - 1;
        while (leftEnd >= start && rightEnd >= start && left[leftEnd] === right[rightEnd]) {
            leftEnd -= 1;
            rightEnd -= 1;
        }
        return {
            ours: left.slice(start, leftEnd + 1),
            theirs: right.slice(start, rightEnd + 1)
        };
    };

    const extractConflictBlocks = (text) => {
        const lines = splitLines(text);
        const pairs = [];
        let side = null;
        let ours = [];
        let theirs = [];
        for (const line of lines) {
            if (line.startsWith('<<<<<<<')) {
                side = 'ours';
                ours = [];
                theirs = [];
                continue;
            }
            if (line.startsWith('=======')) {
                side = 'theirs';
                continue;
            }
            if (line.startsWith('>>>>>>>')) {
                pairs.push(trimSharedConflictLines(ours, theirs));
                side = null;
                ours = [];
                theirs = [];
                continue;
            }
            if (side === 'ours') {
                ours.push(line);
            } else if (side === 'theirs') {
                theirs.push(line);
            }
        }
        return {
            ours: pairs.map((pair) => pair.ours).filter((block) => block.length),
            theirs: pairs.map((pair) => pair.theirs).filter((block) => block.length)
        };
    };

    const findLineRanges = (content, blocks) => {
        const lines = splitLines(content);
        const ranges = [];
        let searchFrom = 0;
        for (const block of blocks || []) {
            const candidate = Array.isArray(block) ? block : [];
            if (!candidate.length) continue;
            let found = -1;
            const findFrom = (start) => {
                for (let index = start; index <= lines.length - candidate.length; index += 1) {
                    let matches = true;
                    for (let offset = 0; offset < candidate.length; offset += 1) {
                        if (lines[index + offset] !== candidate[offset]) {
                            matches = false;
                            break;
                        }
                    }
                    if (matches) return index;
                }
                return -1;
            };
            found = findFrom(searchFrom);
            if (found < 0) found = findFrom(0);
            if (found >= 0) {
                ranges.push({ start: found, end: found + candidate.length - 1 });
                searchFrom = found + candidate.length;
            }
        }
        return ranges;
    };

    const selectConflictFile = async ({ repoPath, filePath } = {}) => {
        if (!repoPath || !filePath) return;
        const state = getState();
        const selection = { repoPath, filePath };
        const requestKey = `${repoPath}::${filePath}`;
        applyState({
            conflictHelper: {
                ...(state.conflictHelper || {}),
                selected: selection,
                ours: '',
                theirs: '',
                oursConflictRanges: [],
                theirsConflictRanges: [],
                choice: '',
                status: 'Loading conflict versions...',
                loading: true,
                requestKey
            }
        });

        try {
            const text = await service.gitConflictVersions({ path: repoPath, file: filePath });
            const payload = parseJsonToolResult(text) || {};
            const ours = payload.ours ?? '';
            const theirs = payload.theirs ?? '';
            const conflictBlocks = extractConflictBlocks(payload.conflict || '');
            const oursError = payload.oursError || '';
            const theirsError = payload.theirsError || '';
            const source = String(getState().conflictSource || '').toLowerCase();
            const localSide = (source === 'merge' || source === 'rebase' || source === 'stash') ? 'theirs' : 'ours';
            const displayOurs = localSide === 'ours' ? ours : theirs;
            const displayTheirs = localSide === 'ours' ? theirs : ours;
            const displayOursError = localSide === 'ours' ? oursError : theirsError;
            const displayTheirsError = localSide === 'ours' ? theirsError : oursError;
            const displayOursBlocks = localSide === 'ours' ? conflictBlocks.ours : conflictBlocks.theirs;
            const displayTheirsBlocks = localSide === 'ours' ? conflictBlocks.theirs : conflictBlocks.ours;
            let status = '';
            if (displayOursError || displayTheirsError) {
                const oursLabel = 'Local';
                const theirsLabel = source === 'stash' ? 'Stash' : 'Remote';
                const parts = [];
                if (displayOursError) parts.push(`${oursLabel} unavailable: ${displayOursError}`);
                if (displayTheirsError) parts.push(`${theirsLabel} unavailable: ${displayTheirsError}`);
                status = parts.join(' · ');
            } else {
                status = 'Compare highlighted conflict blocks or resolve in your editor, then stage the resolved file.';
            }

            const current = getState().conflictHelper || {};
            if (current.requestKey !== requestKey) return;
            applyState({
                conflictHelper: {
                    ...current,
                    selected: selection,
                    ours: String(displayOurs || ''),
                    theirs: String(displayTheirs || ''),
                    oursConflictRanges: findLineRanges(displayOurs, displayOursBlocks),
                    theirsConflictRanges: findLineRanges(displayTheirs, displayTheirsBlocks),
                    choice: '',
                    status,
                    loading: false,
                    requestKey: null
                }
            });
        } catch (error) {
            const current = getState().conflictHelper || {};
            if (current.requestKey !== requestKey) return;
            applyState({
                conflictHelper: {
                    ...current,
                    selected: selection,
                    loading: false,
                    status: normalizeErrorMessage(error)
                }
            });
        }
    };

    const normalizeConflictSource = (value) => {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return '';
        if (raw === 'ours' || raw === 'theirs') return raw;
        if (raw.endsWith('/ours')) return 'ours';
        if (raw.endsWith('/theirs')) return 'theirs';
        const match = raw.match(/(ours|theirs)$/);
        return match ? match[1] : '';
    };

    const applyConflictChoice = async ({ repoPath, filePath, source } = {}) => {
        if (!repoPath || !filePath) return;
        const side = normalizeConflictSource(source);
        if (side !== 'ours' && side !== 'theirs') {
            setStatusLine('Pick left or right to continue.', true);
            return;
        }
        const state = getState();
        applyState({
            conflictHelper: {
                ...(state.conflictHelper || {}),
                selected: { repoPath, filePath },
                choice: side,
                status: `Selected ${side === 'ours' ? 'left' : 'right'} version. Click Save to apply.`,
                loading: false
            }
        });
    };

    const saveConflictResolution = async ({ repoPath, filePath, choice } = {}) => {
        if (!repoPath || !filePath) return;
        const side = normalizeConflictSource(choice || getState().conflictHelper?.choice);
        if (side !== 'ours' && side !== 'theirs') {
            setStatusLine('Pick left or right to continue.', true);
            return;
        }
        const state = getState();
        const source = String(state.conflictSource || '').toLowerCase();
        const localSide = (source === 'merge' || source === 'rebase' || source === 'stash') ? 'theirs' : 'ours';
        const applySide = side === 'ours' ? localSide : (localSide === 'ours' ? 'theirs' : 'ours');
        applyState({
            conflictHelper: {
                ...(state.conflictHelper || {}),
                selected: { repoPath, filePath },
                status: 'Saving resolution...',
                loading: true
            }
        });

        try {
            await service.gitCheckoutConflict({ path: repoPath, file: filePath, source: applySide });
            await service.gitStage(repoPath, [filePath]);
            const statusPayload = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
            updateRepoOverviewFromStatus(repoPath, statusPayload);
            applyState({
                conflictHelper: {
                    ...(state.conflictHelper || {}),
                    choice: '',
                    oursConflictRanges: [],
                    theirsConflictRanges: [],
                    loading: false,
                    status: 'Resolved and staged.'
                },
                manualConflicts: []
            });
            const stillConflicted = collectConflictedItems([repoPath]).some((item) => item.filePath === filePath);
            if (stillConflicted) {
                await selectConflictFile({ repoPath, filePath });
            }
            updateCommitButtons();
            if (!hasConflictsForRepos([repoPath])) {
                setGitConflictFlag(false);
                window.dispatchEvent(new CustomEvent(AUTOCOMMIT_RESET_EVENT));
                setStatusLine(statusPayload.mergeInProgress
                    ? 'Conflicts resolved. Sync or Commit will complete the pending merge.'
                    : 'Ready.');
            }
        } catch (error) {
            applyState({
                conflictHelper: {
                    ...(state.conflictHelper || {}),
                    loading: false,
                    status: normalizeErrorMessage(error)
                }
            });
        }
    };

    const refreshConflicts = async () => {
        await refreshAll({ force: true });
        await maybeRestoreAutoStash();
        applyState({ manualConflicts: [] }, { silent: true });
        const selection = getState().conflictHelper?.selected;
        if (selection?.repoPath && selection?.filePath) {
            const stillConflicted = collectConflictedItems([selection.repoPath])
                .some((item) => item.filePath === selection.filePath);
            if (stillConflicted) {
                await selectConflictFile(selection);
            }
        }
    };

    return {
        selectConflictFile,
        applyConflictChoice,
        saveConflictResolution,
        refreshConflicts,
        normalizeConflictSource
    };
}
