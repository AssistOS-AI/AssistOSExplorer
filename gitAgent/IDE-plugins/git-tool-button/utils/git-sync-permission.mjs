const SYNC_TOOLS = ['git_pull', 'git_commit', 'git_push'];

export async function listAvailableGitTools(sdk) {
    try {
        const tools = await sdk.getClient('gitAgent').listTools();
        if (!Array.isArray(tools)) return [];
        return tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
    } catch {
        return [];
    }
}

export async function hasGitTools(sdk, required) {
    const names = new Set(await listAvailableGitTools(sdk));
    return required.every((name) => names.has(name));
}

export function includesSyncTools(names) {
    return SYNC_TOOLS.every((name) => names.includes(name));
}

export async function canSyncGit(sdk) {
    return includesSyncTools(await listAvailableGitTools(sdk));
}
