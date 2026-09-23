import { parseJsonToolResult, normalizeGitStatusPayload } from "./git-panel-utils.js";
import { mergeRepoOverviewWithStatus } from './git-panel-status.js';

export function createRepoActions(ctx) {
    const {
        getState,
        applyState,
        service
    } = ctx;

    const updateRepoOverviewFromStatus = (repoPath, statusPayload) => {
        const state = getState();
        const repoList = Array.isArray(state.repoOverviews) ? state.repoOverviews : [];
        const nextRepoOverviews = repoList.map((repo) => {
            if (!repo || repo.path !== repoPath) return repo;
            return mergeRepoOverviewWithStatus(repo, statusPayload);
        });
        applyState({ repoOverviews: nextRepoOverviews }, { silent: true });
    };

    const loadManualConflicts = async (repoPaths) => {
        const paths = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        if (!paths.length) {
            applyState({ manualConflicts: [] });
            return;
        }
        const collected = [];
        for (const repoPath of paths) {
            try {
                const text = await service.gitStatus(repoPath);
                const payload = parseJsonToolResult(text) || {};
                const normalized = normalizeGitStatusPayload(payload);
                for (const filePath of normalized.paths.conflicted) {
                    if (!filePath) continue;
                    collected.push({ repoPath, filePath });
                }
            } catch {
                continue;
            }
        }
        applyState({ manualConflicts: collected }, { silent: true });
    };

    return {
        updateRepoOverviewFromStatus,
        loadManualConflicts
    };
}
