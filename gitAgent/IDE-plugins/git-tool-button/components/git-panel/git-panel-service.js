import { parseJsonToolResult } from "./git-panel-utils.js";

export function createGitCommitService({ callTool, callAgentTool }) {
    const extractToolText = (result) => {
        if (!result) return '';
        if (typeof result === 'string') return result;
        const blocks = Array.isArray(result.content) ? result.content : [];
        const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
        if (textBlock?.text) return String(textBlock.text || '').trim();
        if (typeof result.text === 'string') return String(result.text || '').trim();
        return '';
    };

    const compact = (payload) => {
        const next = {};
        for (const [key, value] of Object.entries(payload || {})) {
            if (value === null || value === undefined) continue;
            next[key] = value;
        }
        return next;
    };

    const callGitAuthJson = async (toolName, args = {}) => {
        const rawResult = await callAgentTool('gitAgent', toolName, args, { raw: true });
        if (rawResult?.isError) {
            throw new Error(extractToolText(rawResult) || 'git_auth_request_failed');
        }
        const payload = parseJsonToolResult(rawResult);
        if (!payload || typeof payload !== 'object') {
            const message = extractToolText(rawResult);
            if (message) {
                throw new Error(message);
            }
            throw new Error('git_auth_request_failed');
        }
        if (payload?.ok === false) {
            throw new Error(String(payload?.message || payload?.error || 'git_auth_request_failed'));
        }
        return {
            ok: true,
            github: payload,
            token: payload?.token || ''
        };
    };
    return {
        gitDiff: (args) => callAgentTool('gitAgent', 'git_diff', args),
        gitInfo: (path) => callAgentTool('gitAgent', 'git_info', { path }),
        gitBranchList: (path) => callAgentTool('gitAgent', 'git_branch_list', { path }),
        gitBranchCheckout: (payload) => callAgentTool('gitAgent', 'git_branch_checkout', payload),
        gitBranchCreate: (payload) => callAgentTool('gitAgent', 'git_branch_create', payload),
        gitBranchMerge: (payload) => callAgentTool('gitAgent', 'git_branch_merge', payload),
        gitReposOverview: (path) => callAgentTool('gitAgent', 'git_repos_overview', { path }),
        listDirectoryDetailed: (path) => callTool('list_directory_detailed', { path }),
        gitStatus: (path, options = {}) => callAgentTool('gitAgent', 'git_status', { path, ...options }),
        gitPush: (payload) => callAgentTool('gitAgent', 'git_push', payload),
        gitPull: (payload) => callAgentTool('gitAgent', 'git_pull', payload),
        gitRemoteSet: (payload) => callAgentTool('gitAgent', 'git_remote_set', payload),
        gitSetIdentity: (payload) => callAgentTool('gitAgent', 'git_set_identity', payload),
        gitStage: (path, files) => callAgentTool('gitAgent', 'git_stage', { path, files }),
        gitStageExact: (path, files) => callAgentTool('gitAgent', 'git_stage_exact', { path, files }),
        gitUntrack: (path, files) => callAgentTool('gitAgent', 'git_untrack', { path, files }),
        gitCheckIgnore: (path, files) => callAgentTool('gitAgent', 'git_check_ignore', { path, files }),
        gitAddIgnore: (path) => callAgentTool('gitAgent', 'git_add_ignore', { path }),
        gitRemoveIgnore: (path) => callAgentTool('gitAgent', 'git_remove_ignore', { path }),
        gitRestore: (path, files) => callAgentTool('gitAgent', 'git_restore', { path, files }),
        gitConflictVersions: (payload) => callAgentTool('gitAgent', 'git_conflict_versions', payload),
        gitCheckoutConflict: (payload) => callAgentTool('gitAgent', 'git_checkout_conflict', payload),
        gitStash: (payload) => callAgentTool('gitAgent', 'git_stash', payload),
        gitStashList: (payload) => callAgentTool('gitAgent', 'git_stash_list', payload),
        gitStashPop: (payload) => callAgentTool('gitAgent', 'git_stash_pop', compact(payload), { raw: true }),
        gitCommit: (payload) => callAgentTool('gitAgent', 'git_commit', payload),
        llmResolveConflict: (payload) => callAgentTool('gitAgent', 'git_resolve_conflict', payload),
        deleteFile: (path) => callTool('delete_file', { path }),
        readTextFile: (path) => callTool('read_text_file', { path }),
        writeFile: (path, content) => callTool('write_file', { path, content }),
        generateCommitMessage: (diffs) => callAgentTool('gitAgent', 'git_commit_message', { diffs }),
        githubAuthStatus: () => callGitAuthJson('git_auth_status'),
        startGithubDeviceFlow: () => callGitAuthJson('git_auth_begin'),
        pollGithubDeviceFlow: () => callGitAuthJson('git_auth_poll'),
        disconnectGithubAuth: () => callGitAuthJson('git_auth_disconnect'),
        storeManualGitToken: (token) => callGitAuthJson('git_auth_store_token', { token }),
        getStoredGitToken: async () => {
            const result = await callGitAuthJson('git_auth_status');
            return result?.token || '';
        }
    };
}
