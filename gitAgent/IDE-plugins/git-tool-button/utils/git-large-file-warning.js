import { parseJsonToolResult } from '../components/git-panel/git-panel-utils.js';

export async function requestLargeFileConsent({ repoPath, warning }) {
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ repoPath, ...warning }))));
    const result = await assistOS.UI.showModal('git-large-files-modal', { payload }, true);
    return result?.policy === 'continue';
}

export async function runGitWithLargeFileWarning({
    callAgentTool, toolName, args, beforeMutation = null,
    confirm = requestLargeFileConsent, isActive = () => true, onAbort = () => {}
}) {
    const operation = toolName === 'git_commit' ? 'commit' : 'push';
    let payload = { ...args };
    const call = async (name, input) => {
        const raw = await callAgentTool('gitAgent', name, input, { raw: true });
        const result = parseJsonToolResult(raw);
        if (result?.code === 'large_files_warning') return result;
        if (raw?.isError || result?.ok !== true) {
            throw new Error(String(result?.error || result?.message || 'Git operation failed.'));
        }
        return result;
    };
    const approve = async (warning) => {
        if (!isActive() || await confirm({ repoPath: args.path, warning }) !== true || !isActive()) {
            const message = `${operation === 'commit' ? 'Commit' : 'Push'} aborted. Large files were not approved. No files were deleted; staging and any existing commits remain available.`;
            onAbort(message);
            const error = new Error(message);
            error.code = 'large_files_aborted';
            throw error;
        }
        payload = { ...payload, approvedLargeFileOids: [
            ...new Set([...(payload.approvedLargeFileOids || []), ...warning.files.map((file) => file.oid)])
        ] };
    };
    const preflight = await call('git_check_large_files', {
        path: payload.path, operation, remote: payload.remote, branch: payload.branch,
        setUpstream: payload.setUpstream, approvedLargeFileOids: payload.approvedLargeFileOids
    });
    if (preflight.code === 'large_files_warning') await approve(preflight);
    if (!isActive()) throw new Error('Git operation stopped because its view was closed.');
    if (beforeMutation) await beforeMutation();
    // Recheck in the backend: a newly staged blob or a new local commit must
    // obtain its own approval, rather than inheriting a blanket permission.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!isActive()) throw new Error('Git operation stopped because its view was closed.');
        const result = await call(toolName, payload);
        if (result.code !== 'large_files_warning') return JSON.stringify(result);
        await approve(result);
    }
    throw new Error('Repository changed repeatedly during approval. Retry when other Git operations have stopped.');
}
