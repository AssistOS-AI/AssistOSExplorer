const GITHUB_API_BASE = 'https://api.github.com';

const cleanSegment = (value, label) => {
    const segment = String(value || '').trim();
    if (!segment || segment.includes('/') || segment.includes('\\') || /\s/.test(segment)) {
        throw new Error(`Invalid GitHub ${label}.`);
    }
    return segment;
};

export function parseGithubRepositoryRemote(remoteUrl) {
    const raw = String(remoteUrl || '').trim();
    if (!raw) return null;
    const normalized = raw.replace(/\/+$/g, '').replace(/\.git$/i, '');
    const httpsMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (httpsMatch) {
        const owner = cleanSegment(httpsMatch[1], 'owner');
        const repo = cleanSegment(httpsMatch[2], 'repository');
        return {
            owner,
            repo,
            canonicalUrl: `https://github.com/${owner}/${repo}.git`,
            transport: 'https',
        };
    }
    const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
    if (sshMatch) {
        const owner = cleanSegment(sshMatch[1], 'owner');
        const repo = cleanSegment(sshMatch[2], 'repository');
        return {
            owner,
            repo,
            canonicalUrl: `git@github.com:${owner}/${repo}.git`,
            transport: 'ssh',
        };
    }
    return null;
}

export function getGithubRepositoryApiUrl(owner, repo) {
    return `${GITHUB_API_BASE}/repos/${encodeURIComponent(cleanSegment(owner, 'owner'))}/${encodeURIComponent(cleanSegment(repo, 'repository'))}`;
}

export function getGithubRepositoryCreateUrl(owner, authenticatedLogin) {
    const cleanOwner = cleanSegment(owner, 'owner');
    const cleanLogin = cleanSegment(authenticatedLogin, 'authenticated login');
    if (cleanOwner.toLowerCase() === cleanLogin.toLowerCase()) {
        return `${GITHUB_API_BASE}/user/repos`;
    }
    return `${GITHUB_API_BASE}/orgs/${encodeURIComponent(cleanOwner)}/repos`;
}
