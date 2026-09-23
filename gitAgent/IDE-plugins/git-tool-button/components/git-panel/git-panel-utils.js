export function normalizeErrorMessage(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || 'Unknown error';
    return String(error);
}

export function humanizeGitError(message, { action = null } = {}) {
    const raw = String(message || '').trim();
    if (!raw) return 'Unknown error';

    const cleaned = raw
        .split(/\r?\n/)
        .filter((line) => !line.trim().toLowerCase().startsWith('hint:'))
        .join('\n')
        .trim();

    const lower = cleaned.toLowerCase();
    if (lower.includes('terminal prompts disabled') || lower.includes('could not read username')) {
        return 'Authentication required. Open Git settings and connect GitHub or enter your token.';
    }
    if (lower.includes('github authentication is required to create the remote repository')) {
        return 'Authentication required. Connect GitHub or enter your token to create the remote repository.';
    }
    if (lower.includes('could not read password')) {
        return 'Authentication required. Open Git settings and connect GitHub or enter your token.';
    }
    if (lower.includes('authentication failed') || lower.includes('http basic: access denied')) {
        return 'Authentication failed. Reconnect GitHub or check your token and try again.';
    }
    if (lower.includes('permission denied')) {
        return 'Authentication failed. You do not have permission for this repository.';
    }
    if (lower.includes('failed to remove') && lower.includes('resource busy')) {
        if (lower.includes('node_modules')) {
            return 'Pull failed because a node_modules folder is in use. Stop the running agent or container that uses this repo and try again.';
        }
        return 'Pull failed because a folder in the repository is currently in use. Stop the process using it and try again.';
    }
    if (lower.includes('unable to auto-detect email address') || lower.includes('author identity unknown') || lower.includes('committer identity unknown')) {
        return 'Missing Git identity. Open Git settings and set name + email.';
    }
    if (action === 'pull' && (
        lower.includes('not possible to fast-forward')
        || lower.includes("can't be fast-forwarded")
        || lower.includes('diverging branches')
        || lower.includes('need to specify how to reconcile divergent branches')
        || lower.includes('specify how to reconcile them')
    )) {
        return 'Pull failed: branches diverged. Use Pull ▾ → Rebase or Merge.';
    }

    return cleaned || raw;
}

export function parseJsonToolResult(toolResultText) {
    if (!toolResultText) return null;

    const extractJson = (payload) => {
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'json')) {
            return payload.json;
        }

        const blocks = Array.isArray(payload.content) ? payload.content : null;
        if (blocks) {
            const jsonBlock = blocks.find((block) => block?.type === 'json' && block.json !== undefined);
            if (jsonBlock) {
                return jsonBlock.json;
            }
            const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
            if (textBlock?.text) {
                try {
                    return JSON.parse(textBlock.text);
                } catch {
                    return null;
                }
            }
        }

        if (typeof payload.text === 'string') {
            const trimmed = payload.text.trim();
            if (trimmed) {
                try {
                    return JSON.parse(trimmed);
                } catch {
                    // ignore
                }
            }
        }

        return payload;
    };

    if (typeof toolResultText !== 'string') {
        return extractJson(toolResultText);
    }

    const trimmed = toolResultText.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed);
        return extractJson(parsed);
    } catch {
        return null;
    }
}

export function normalizeSlashes(value) {
    return String(value || '').replaceAll('\\', '/');
}

export function extractChangePaths(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list
        .map((entry) => {
            if (!entry) return '';
            if (typeof entry === 'string') return entry;
            return entry.path || entry.filePath || entry.name || '';
        })
        .map((value) => String(value || '').trim())
        .filter(Boolean);
}

export function normalizeGitStatusPayload(payload) {
    const status = payload?.status || payload || {};
    const staged = Array.isArray(status.staged) ? status.staged : [];
    const unstaged = Array.isArray(status.unstaged) ? status.unstaged : [];
    const untracked = Array.isArray(status.untracked) ? status.untracked : [];
    const conflicted = Array.isArray(status.conflicted) ? status.conflicted : [];
    const ignored = Array.isArray(status.ignored) ? status.ignored : [];
    const paths = {
        staged: extractChangePaths(staged),
        unstaged: extractChangePaths(unstaged),
        untracked: extractChangePaths(untracked),
        conflicted: extractChangePaths(conflicted),
        ignored: extractChangePaths(ignored)
    };
    const counts = {
        staged: staged.length,
        unstaged: unstaged.length,
        untracked: untracked.length,
        conflicted: conflicted.length,
        ignored: ignored.length
    };
    return { status, raw: { staged, unstaged, untracked, conflicted, ignored }, paths, counts };
}

export function stripTrailingSlash(value) {
    return normalizeSlashes(value).replace(/\/+$/g, '');
}

export function normalizeRepoPath(value, workspaceRoot = '') {
    const normalized = stripTrailingSlash(value);
    if (!normalized) return '';
    const root = stripTrailingSlash(workspaceRoot);
    if (!root || root === '/') {
        if (normalized.startsWith('/.ploinky/')) {
            return normalized.slice(1);
        }
        return normalized;
    }
    if (normalized.startsWith('/.ploinky/')) {
        return `${root}${normalized}`;
    }
    if (normalized.startsWith('.ploinky/')) {
        return `${root}/${normalized}`;
    }
    return normalized;
}

export function isReposRootPath(candidate, reposRoot) {
    const normalizedCandidate = stripTrailingSlash(candidate);
    const normalizedRoot = stripTrailingSlash(reposRoot);
    if (!normalizedCandidate || !normalizedRoot) return false;
    if (normalizedCandidate === normalizedRoot) return true;
    return normalizedCandidate.endsWith(normalizedRoot);
}

export function isAgentRepoPath(candidate) {
    const normalized = normalizeSlashes(String(candidate || '')).trim();
    if (!normalized) return false;
    return normalized.includes('/.ploinky/') || normalized.startsWith('.ploinky/');
}

export function getVisibleRepoOverviews(repos, showAgentRepos = false) {
    const list = Array.isArray(repos) ? repos : [];
    return list.filter((repo) => {
        if (!repo) return false;
        if (showAgentRepos) return true;
        return !isAgentRepoPath(repo.path || '');
    });
}

export function isGitAuthError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('terminal prompts disabled')) return true;
    if (lower.includes('could not read username')) return true;
    if (lower.includes('could not read password')) return true;
    if (lower.includes('authentication failed')) return true;
    if (lower.includes('fatal: authentication')) return true;
    if (lower.includes('http basic: access denied')) return true;
    if (lower.includes('permission denied')) return true;
    if (lower.includes('github authentication is required to create the remote repository')) return true;
    return false;
}

export function isGitIdentityError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('author identity unknown')) return true;
    if (lower.includes('committer identity unknown')) return true;
    if (lower.includes('unable to auto-detect email address')) return true;
    if (lower.includes('please tell me who you are')) return true;
    return false;
}

export function isLlmUnavailableError(message) {
    const text = String(message || '').trim().toLowerCase();
    if (!text) return false;
    if (text.includes('no llm models are configured')) return true;
    if (text.includes('no default llm agent available')) return true;
    if (text.includes('llmconfig.json')) return true;
    return false;
}

function basename(value) {
    const normalized = normalizeSlashes(String(value || '')).replace(/\/+$/g, '');
    if (!normalized) return '';
    const parts = normalized.split('/');
    return parts[parts.length - 1] || '';
}

export function buildFallbackCommitMessage(selections = []) {
    const entries = Array.isArray(selections) ? selections : [];
    const repoCount = entries.filter((entry) => entry?.repoPath).length;
    const files = [];
    for (const entry of entries) {
        const list = Array.isArray(entry?.files) ? entry.files : [];
        for (const file of list) {
            const name = basename(file);
            if (name) files.push(name);
        }
    }
    const uniqueFiles = [...new Set(files)];
    if (!repoCount || !uniqueFiles.length) {
        return 'Sync selected changes';
    }
    if (repoCount === 1 && uniqueFiles.length === 1) {
        return `Update ${uniqueFiles[0]}`;
    }
    if (repoCount === 1) {
        return uniqueFiles.length === 2
            ? `Update ${uniqueFiles[0]} and ${uniqueFiles[1]}`
            : `Update ${uniqueFiles[0]} and ${uniqueFiles.length - 1} more files`;
    }
    return repoCount === 2
        ? 'Sync changes across 2 repositories'
        : `Sync changes across ${repoCount} repositories`;
}

export function buildEditableFallbackCommitMessage(selections = []) {
    const entries = Array.isArray(selections) ? selections : [];
    const files = [];
    for (const entry of entries) {
        const repoPath = stripTrailingSlash(entry?.repoPath || '');
        const list = Array.isArray(entry?.files) ? entry.files : [];
        for (const file of list) {
            const normalizedFile = normalizeSlashes(String(file || '').trim());
            if (!normalizedFile) continue;
            const normalizedRepo = repoPath ? normalizeSlashes(repoPath) : '';
            const displayPath = normalizedRepo && normalizedFile.startsWith(`${normalizedRepo}/`)
                ? normalizedFile.slice(normalizedRepo.length + 1)
                : normalizedFile.replace(/^\/+/, '');
            if (displayPath) files.push(displayPath);
        }
    }
    const uniqueFiles = [...new Set(files)];
    if (!uniqueFiles.length) return 'Update selected files';
    return [
        'Update selected files',
        '',
        'Affected files:',
        ...uniqueFiles.map((file) => `- ${file}`)
    ].join('\n');
}

export function isGitConflictError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('conflict')) return true;
    if (lower.includes('unmerged')) return true;
    if (lower.includes('automatic merge failed')) return true;
    if (lower.includes('fix conflicts')) return true;
    return false;
}

export function isGitPullBlockedError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('would be overwritten by merge')) return true;
    if (lower.includes('would be overwritten by checkout')) return true;
    if (lower.includes('please commit your changes or stash them')) return true;
    if (lower.includes('cannot pull with rebase')) return true;
    if (lower.includes('you have unstaged changes')) return true;
    return false;
}

export function extractGitPullBlockedFiles(message) {
    const text = String(message || '');
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => line.toLowerCase().includes('would be overwritten by'));
    if (startIndex < 0) return [];
    const files = [];
    for (let i = startIndex + 1; i < lines.length; i += 1) {
        const raw = lines[i] || '';
        const line = raw.trim();
        if (!line) continue;
        const lower = line.toLowerCase();
        if (lower.startsWith('please commit')) break;
        if (lower.startsWith('aborting')) break;
        if (lower.startsWith('error:')) break;
        if (lower.startsWith('fatal:')) break;
        files.push(line);
    }
    return files;
}

const GIT_IDENTITY_NAME_KEY = 'webskel.git.identity.name';
const GIT_IDENTITY_EMAIL_KEY = 'webskel.git.identity.email';
const GIT_AUTH_METHOD_STORAGE_KEY = 'webskel.git.auth.method';
const GITHUB_CONNECTION_STORAGE_KEY = 'webskel.git.github.connection';

export function normalizeGitAuthMethod(value) {
    return String(value || '').trim().toLowerCase() === 'github' ? 'github' : 'token';
}

function sanitizeRememberedGithubConnection(connection = null) {
    if (!connection || typeof connection !== 'object') return null;
    const user = connection.user && typeof connection.user === 'object'
        ? {
            id: connection.user.id || null,
            login: String(connection.user.login || '').trim(),
            name: String(connection.user.name || '').trim(),
            email: String(connection.user.email || '').trim(),
            avatarUrl: String(connection.user.avatarUrl || '').trim(),
            profileUrl: String(connection.user.profileUrl || '').trim()
        }
        : null;
    const sanitized = {
        provider: 'github',
        connectedAt: connection.connectedAt || null,
        updatedAt: connection.updatedAt || null,
        tokenType: String(connection.tokenType || 'bearer').trim() || 'bearer',
        scope: String(connection.scope || '').trim(),
        user
    };
    const hasUser = Boolean(user?.login || user?.name || user?.email);
    if (!hasUser && !sanitized.scope) {
        return null;
    }
    return sanitized;
}

export function getRememberedGithubConnection() {
    try {
        const raw = localStorage.getItem(GITHUB_CONNECTION_STORAGE_KEY);
        if (!raw) return null;
        return sanitizeRememberedGithubConnection(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function setRememberedGithubConnection(connection) {
    try {
        const value = sanitizeRememberedGithubConnection(connection);
        if (!value) {
            localStorage.removeItem(GITHUB_CONNECTION_STORAGE_KEY);
            return;
        }
        localStorage.setItem(GITHUB_CONNECTION_STORAGE_KEY, JSON.stringify(value));
    } catch {
        // ignore
    }
}

export function clearRememberedGithubConnection() {
    try {
        localStorage.removeItem(GITHUB_CONNECTION_STORAGE_KEY);
    } catch {
        // ignore
    }
}

export function getRememberedGitIdentity() {
    try {
        return {
            name: String(localStorage.getItem(GIT_IDENTITY_NAME_KEY) || ''),
            email: String(localStorage.getItem(GIT_IDENTITY_EMAIL_KEY) || '')
        };
    } catch {
        return { name: '', email: '' };
    }
}

export function getGithubIdentityFallback(user = {}) {
    return {
        name: String(user?.login || user?.name || '').trim(),
        email: String(user?.email || '').trim()
    };
}

export function getEffectiveGitIdentity({
    identityPrompt = {},
    rememberedIdentity = null,
    githubAuth = {}
} = {}) {
    const remembered = rememberedIdentity || getRememberedGitIdentity();
    const githubConnection = githubAuth?.connection || {};
    const githubConnected = Boolean(
        githubAuth?.connected
        && String(githubConnection?.source || '').trim().toLowerCase() === 'github'
    );
    const githubIdentity = githubConnected
        ? getGithubIdentityFallback(githubConnection?.user || {})
        : { name: '', email: '' };
    return {
        name: String(identityPrompt?.name || remembered.name || githubIdentity.name || '').trim(),
        email: String(identityPrompt?.email || remembered.email || githubIdentity.email || '').trim()
    };
}

export function buildPrefilledGitIdentityState({
    identityPrompt = {},
    repoPath = '',
    rememberedIdentity = {},
    githubUser = {},
    authMethod = 'token'
} = {}) {
    const { name, email } = getEffectiveGitIdentity({
        identityPrompt,
        rememberedIdentity,
        githubAuth: {
            connected: true,
            connection: {
                source: 'github',
                user: githubUser
            }
        }
    });
    const nextRepoPath = String(identityPrompt?.repoPath || repoPath || '').trim() || null;
    return {
        identityPrompt: {
            ...identityPrompt,
            repoPath: nextRepoPath,
            name,
            email
        },
        credentialsBaseline: {
            name,
            email,
            authMethod: normalizeGitAuthMethod(authMethod)
        }
    };
}

export function setRememberedGitIdentity({ name = '', email = '' } = {}) {
    try {
        const trimmedName = String(name || '').trim();
        const trimmedEmail = String(email || '').trim();
        if (trimmedName) {
            localStorage.setItem(GIT_IDENTITY_NAME_KEY, trimmedName);
        } else {
            localStorage.removeItem(GIT_IDENTITY_NAME_KEY);
        }
        if (trimmedEmail) {
            localStorage.setItem(GIT_IDENTITY_EMAIL_KEY, trimmedEmail);
        } else {
            localStorage.removeItem(GIT_IDENTITY_EMAIL_KEY);
        }
    } catch {
        // ignore
    }
}

export function getRememberedGitAuthMethod() {
    try {
        return normalizeGitAuthMethod(localStorage.getItem(GIT_AUTH_METHOD_STORAGE_KEY) || '');
    } catch {
        return 'token';
    }
}

export function setRememberedGitAuthMethod(value) {
    try {
        localStorage.setItem(GIT_AUTH_METHOD_STORAGE_KEY, normalizeGitAuthMethod(value));
    } catch {
        // ignore
    }
}

const AUTOCOMMIT_ENABLED_STORAGE_KEY = 'webskel.git.autocommit.enabled';
const AUTOCOMMIT_INTERVAL_STORAGE_KEY = 'webskel.git.autocommit.intervalMinutes';
const AUTOCOMMIT_REPOS_STORAGE_KEY = 'webskel.git.autocommit.repos';
const AUTOCOMMIT_SHOW_AGENT_REPOS_STORAGE_KEY = 'webskel.git.autocommit.showAgentRepos';
const GIT_SHOW_AGENT_REPOS_STORAGE_KEY = 'webskel.git.showAgentRepos';
const AUTORESOLVE_CONFLICTS_STORAGE_KEY = 'webskel.git.autoresolve.conflicts';
const GIT_CONFLICT_FLAG_STORAGE_KEY = 'webskel.git.conflicts';
const GIT_ERROR_FLAG_STORAGE_KEY = 'webskel.git.errors';

export function getAutocommitSettings() {
    let enabled = true;
    let intervalMinutes = 15;
    let repos = null;
    try {
        const rawEnabled = localStorage.getItem(AUTOCOMMIT_ENABLED_STORAGE_KEY);
        if (rawEnabled === 'true' || rawEnabled === 'false') {
            enabled = rawEnabled === 'true';
        }
        const rawInterval = localStorage.getItem(AUTOCOMMIT_INTERVAL_STORAGE_KEY);
        if (rawInterval !== null && rawInterval !== undefined) {
            const parsed = Number(rawInterval);
            if (Number.isFinite(parsed)) {
                intervalMinutes = Math.max(1, Math.floor(parsed));
            }
        }
        const rawRepos = localStorage.getItem(AUTOCOMMIT_REPOS_STORAGE_KEY);
        if (rawRepos) {
            const parsed = JSON.parse(rawRepos);
            if (Array.isArray(parsed)) {
                repos = parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
            }
        }
    } catch {
        // ignore
    }
    return { enabled, intervalMinutes, repos };
}

export function setAutocommitSettings({ enabled = null, intervalMinutes = null, repos = null } = {}) {
    try {
        if (typeof enabled === 'boolean') {
            localStorage.setItem(AUTOCOMMIT_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
        }
        if (intervalMinutes !== null && intervalMinutes !== undefined) {
            const parsed = Number(intervalMinutes);
            if (Number.isFinite(parsed)) {
                localStorage.setItem(AUTOCOMMIT_INTERVAL_STORAGE_KEY, String(Math.max(1, Math.floor(parsed))));
            }
        }
        if (Array.isArray(repos)) {
            const cleaned = repos.map((entry) => String(entry || '').trim()).filter(Boolean);
            localStorage.setItem(AUTOCOMMIT_REPOS_STORAGE_KEY, JSON.stringify(cleaned));
        }
    } catch {
        // ignore
    }
}

export function getShowAgentReposSetting() {
    try {
        const rawCurrent = localStorage.getItem(GIT_SHOW_AGENT_REPOS_STORAGE_KEY);
        if (rawCurrent === 'true' || rawCurrent === 'false') {
            return rawCurrent === 'true';
        }
        const rawLegacy = localStorage.getItem(AUTOCOMMIT_SHOW_AGENT_REPOS_STORAGE_KEY);
        if (rawLegacy === 'true' || rawLegacy === 'false') {
            const migrated = rawLegacy === 'true';
            localStorage.setItem(GIT_SHOW_AGENT_REPOS_STORAGE_KEY, migrated ? 'true' : 'false');
            localStorage.removeItem(AUTOCOMMIT_SHOW_AGENT_REPOS_STORAGE_KEY);
            return migrated;
        }
    } catch {
        // ignore
    }
    return false;
}

export function setShowAgentReposSetting(value) {
    try {
        localStorage.setItem(GIT_SHOW_AGENT_REPOS_STORAGE_KEY, value ? 'true' : 'false');
        localStorage.removeItem(AUTOCOMMIT_SHOW_AGENT_REPOS_STORAGE_KEY);
    } catch {
        // ignore
    }
}

export function getConflictAutoresolveSetting() {
    try {
        return localStorage.getItem(AUTORESOLVE_CONFLICTS_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setConflictAutoresolveSetting(value) {
    try {
        localStorage.setItem(AUTORESOLVE_CONFLICTS_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        // ignore
    }
}

export function getGitConflictFlag() {
    try {
        return localStorage.getItem(GIT_CONFLICT_FLAG_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setGitConflictFlag(value) {
    try {
        localStorage.setItem(GIT_CONFLICT_FLAG_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        // ignore
    }
}

export function getGitErrorFlag() {
    try {
        return localStorage.getItem(GIT_ERROR_FLAG_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setGitErrorFlag(value) {
    try {
        localStorage.setItem(GIT_ERROR_FLAG_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        // ignore
    }
}
