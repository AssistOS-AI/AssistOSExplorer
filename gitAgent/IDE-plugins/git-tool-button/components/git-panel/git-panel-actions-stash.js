import { normalizeErrorMessage, parseJsonToolResult, isReposRootPath } from "./git-panel-utils.js";

export function createStashActions(ctx) {
    const {
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        loadRepoOverviews,
        refreshAll,
        selectStashRef,
        restoreStash,
        getSelectedReposForBatch,
        withPanelLoader
    } = ctx;

    const stashRepos = async (repoPaths) => {
        const list = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        if (!list.length) return { ok: true, created: 0, skipped: 0, total: 0 };
        let created = 0;
        let skipped = 0;
        for (const repoPath of list) {
            try {
                const text = await service.gitStash({
                    path: repoPath,
                    includeUntracked: true,
                    message: 'webskel:manual-stash'
                });
                const payload = parseJsonToolResult(text) || {};
                if (payload?.created) {
                    created += 1;
                } else {
                    skipped += 1;
                }
            } catch {
                skipped += 1;
            }
        }
        return { ok: true, created, skipped, total: list.length };
    };

    const stashSelectedRepos = async () => {
        const state = getState();
        const selected = getSelectedReposForBatch();
        const targets = selected.length
            ? selected
            : (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot)) ? [state.repoPath] : [];
        if (!targets.length) {
            setStatusLine('Select a repository or file to stash.', true);
            return;
        }
        applyState({ autoStash: null }, { silent: true });
        setStatusLine(`Stashing ${targets.length} repo(s)...`);
        return withPanelLoader(async () => {
            try {
                const result = await stashRepos(targets);
                if (!result.ok) return;
                await loadRepoOverviews({ force: true });
                await refreshAll({ force: true });
                updateCommitButtons();
                if (result.created === 0) {
                    setStatusLine('Nothing to stash.');
                    return;
                }
                if (result.created === result.total) {
                    setStatusLine(`Stashed ${result.created} repo(s).`);
                    return;
                }
                setStatusLine(`Stashed ${result.created} repo(s). ${result.skipped} repo(s) had no changes.`);
            } catch (error) {
                setStatusLine(normalizeErrorMessage(error), true);
            }
        });
    };

    const unstashSelectedRepos = async () => {
        const state = getState();
        const selected = getSelectedReposForBatch();
        const targets = selected.length
            ? selected
            : (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot)) ? [state.repoPath] : [];
        if (!targets.length) {
            setStatusLine('Select a repository or file to unstash.', true);
            return;
        }
        applyState({ autoStash: null }, { silent: true });
        setStatusLine(`Unstashing ${targets.length} repo(s)...`);
        return withPanelLoader(async () => {
            try {
                for (const repoPath of targets) {
                    const selection = await selectStashRef(repoPath);
                    if (!selection.ok) {
                        if (selection.canceled) {
                            setStatusLine('Unstash canceled.');
                        }
                        return;
                    }
                    const restored = await restoreStash(repoPath, selection.ref);
                    if (!restored.ok) return;
                    if (restored.conflicts) return;
                }
                await loadRepoOverviews({ force: true });
                await refreshAll({ force: true });
                updateCommitButtons();
                setStatusLine('Unstash complete.');
            } catch (error) {
                setStatusLine(normalizeErrorMessage(error), true);
            }
        });
    };

    return {
        stashRepos,
        stashSelectedRepos,
        unstashSelectedRepos
    };
}
