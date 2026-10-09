// Privilege-dependent projection of the skills-manifest tool responses.
//
// The four skills-manifest tools work on internal repository records: physical
// checkout paths, configured repository URLs (which may embed credentials) and
// raw clone/filesystem error text. Only a verified, non-guest administrator
// invocation receives those values. Every other caller (including a missing or
// malformed invocation context) receives an explicit allowlisted shape:
// repository names, branches, credential-free display URLs, cache/status flags,
// selected and available skills, skillsets, safe diagnostics and
// workspace-relative manifest/folder references.
//
// This covers the structured tool responses only. It is not a filesystem
// secrecy boundary: authorized file tools can still read the manifest itself.

async function loadInvocationAuth() {
    const candidates = [
        process.env.PLOINKY_INVOCATION_AUTH_MODULE,
        '/Agent/lib/invocation-auth.mjs',
        '../../../shared/invocation-auth.mjs'
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const module = await import(candidate);
            if (typeof module.authInfoFromInvocation === 'function') return module.authInfoFromInvocation;
        } catch (_) {}
    }
    // Without the shared helper no caller can be proven to be an administrator.
    return null;
}

const authInfoFromInvocation = await loadInvocationAuth();

// Strict administrator predicate for an already-verified router invocation
// grant (`context.invocation`). Delegated user claims take precedence over the
// actor (shared authInfoFromInvocation); roles must include admin and must not
// include guest. Usernames, ids, tool arguments, plain headers and agent
// (machine) callers never qualify.
export function invocationIsAdministrator(context) {
    try {
        const grant = context && typeof context === 'object' ? context.invocation : null;
        if (!grant || typeof grant !== 'object' || Array.isArray(grant) || !authInfoFromInvocation) return false;
        const roles = authInfoFromInvocation(grant)?.user?.roles;
        if (!Array.isArray(roles)) return false;
        const normalized = roles.map((role) => String(role || '').trim().toLowerCase());
        return normalized.includes('admin') && !normalized.includes('guest');
    } catch (_) {
        return false;
    }
}

// Credential-free display value for a repository URL. Mirrors Ploinky's
// Marketplace remoteUrlOrEmpty (cli/server/authHandlers/marketplaceProjection.js);
// tests/unit/skillsManifestProjection.test.js runs both on the same vectors.
// Userinfo, query and fragment are always dropped; local locations and every
// malformed or ambiguous form yield ''.
const REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);
const SAFE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const DOTTED_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SAFE_PATH = /^[A-Za-z0-9._~/+-]*$/;
const SCP_LIKE = /^[^@\s/:\\]+@([^@\s/:\\]+):(.+)$/;

function safeUrlPath(value) {
    return SAFE_PATH.test(value) && !value.split('/').some((segment) => segment === '..');
}

export function displayRemoteUrl(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    // eslint-disable-next-line no-control-regex
    if (!text || /[\s\u0000-\u001f\u007f\\]/.test(text)) return '';
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
        let parsed;
        try {
            parsed = new URL(text);
        } catch (_) {
            return '';
        }
        if (!REMOTE_URL_PROTOCOLS.has(parsed.protocol) || !SAFE_HOSTNAME.test(parsed.hostname)) return '';
        const pathname = parsed.pathname || '/';
        if (!safeUrlPath(pathname)) return '';
        return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${pathname}`;
    }
    const scp = text.match(SCP_LIKE);
    if (!scp) return '';
    const host = scp[1].toLowerCase();
    const repoPath = scp[2];
    if (!DOTTED_HOSTNAME.test(host) || repoPath.startsWith('//') || !/[^/]/.test(repoPath) || !safeUrlPath(repoPath)) return '';
    return `${host}:${repoPath}`;
}

// Errors whose message interpolates only validated names carry a public
// message; restricted callers get that message or a generic one.
export const GENERIC_SKILLS_MANIFEST_ERROR = 'Skills manifest operation failed.';
const PUBLIC_MESSAGE = Symbol('skillsManifestPublicMessage');

export function skillsManifestError(message, publicMessage = message) {
    const error = new Error(message);
    error[PUBLIC_MESSAGE] = publicMessage;
    return error;
}

export function restrictedSkillsManifestError(error) {
    const message = error && typeof error === 'object' && typeof error[PUBLIC_MESSAGE] === 'string'
        ? error[PUBLIC_MESSAGE]
        : GENERIC_SKILLS_MANIFEST_ERROR;
    return new Error(message);
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const TOKEN = /^[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const CACHE_UNAVAILABLE = 'Repository could not be prepared.';

const isName = (value) => typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..';
const names = (value) => (Array.isArray(value) ? value.filter(isName) : []);
const safeBranch = (value) => (typeof value === 'string' && BRANCH.test(value) && !value.split('/').includes('..') ? value : null);
const optionalToken = (value) => (typeof value === 'string' && TOKEN.test(value) ? value : undefined);

function projectDiagnostic(item) {
    if (!item || typeof item !== 'object') return null;
    const out = {};
    if (isName(item.name)) out.name = item.name;
    out.reason = optionalToken(item.reason) || 'diagnostic';
    const status = optionalToken(item.status);
    if (status) out.status = status;
    return out;
}

const diagnostics = (value) => (Array.isArray(value) ? value.map(projectDiagnostic).filter(Boolean) : []);

function projectProvenance(source) {
    if (!source || typeof source !== 'object' || !isName(source.name)) return null;
    return { name: source.name, url: displayRemoteUrl(source.url), branch: safeBranch(source.branch) };
}

function projectRepository(repo) {
    return {
        name: isName(repo?.name) ? repo.name : '',
        url: displayRemoteUrl(repo?.url),
        branch: safeBranch(repo?.branch),
        skills: names(repo?.skills),
        cached: Boolean(repo?.cached),
        availableSkills: names(repo?.availableSkills),
        skillsets: Array.isArray(repo?.skillsets) ? repo.skillsets.map((set) => ({
            name: typeof set?.name === 'string' ? set.name : '',
            description: typeof set?.description === 'string' ? set.description : '',
            skills: names(set?.skills),
            enabled: Boolean(set?.enabled),
            partial: Boolean(set?.partial)
        })) : [],
        cacheError: repo?.cacheError ? CACHE_UNAVAILABLE : ''
    };
}

function projectSkillOutput(output) {
    const out = {
        name: isName(output?.name) ? output.name : '',
        state: optionalToken(output?.state) || 'unknown',
        selected: Boolean(output?.selected),
        installed: Boolean(output?.installed)
    };
    if (output && Object.hasOwn(output, 'source')) out.source = projectProvenance(output.source);
    return out;
}

function projectKnownRepository(repo) {
    // `url` here may be an alias that fell back to the physical source; the
    // display rule blanks any local location, so no path is restored.
    const out = {
        name: isName(repo?.name) ? repo.name : '',
        label: isName(repo?.name) ? repo.name : '',
        url: displayRemoteUrl(repo?.url),
        branch: safeBranch(repo?.branch) || '',
        kind: optionalToken(repo?.kind) || '',
        origin: optionalToken(repo?.origin) || '',
        installed: Boolean(repo?.installed),
        warnings: Array.isArray(repo?.warnings) ? repo.warnings.filter((warning) => typeof warning === 'string' && !warning.includes('://')) : []
    };
    return out;
}

// `toWorkspaceRef(physicalPath)` returns a canonical contained workspace-relative
// reference (`/folder/...`) or '' when the path is outside the workspace.
export function projectSkillsManifestResult(result, { toWorkspaceRef }) {
    const source = result && typeof result === 'object' ? result : {};
    const out = {};
    for (const key of ['ok', 'added', 'cached']) {
        if (typeof source[key] === 'boolean') out[key] = source[key];
    }
    // Tool messages interpolate only validated repository names.
    if (typeof source.message === 'string') out.message = source.message;
    for (const key of ['manifestPath', 'folderPath']) {
        if (typeof source[key] !== 'string') continue;
        const ref = toWorkspaceRef(source[key]);
        if (ref) out[key] = ref;
    }
    if (Array.isArray(source.repositories)) out.repositories = source.repositories.map(projectRepository);
    if (Array.isArray(source.installedSkills)) out.installedSkills = names(source.installedSkills);
    if (Array.isArray(source.skillOutputs)) out.skillOutputs = source.skillOutputs.map(projectSkillOutput);
    if (Array.isArray(source.diagnostics)) out.diagnostics = diagnostics(source.diagnostics);
    if (Array.isArray(source.skillRepositories)) out.skillRepositories = source.skillRepositories.map(projectKnownRepository);
    if (source.exportResult && typeof source.exportResult === 'object') {
        out.exportResult = {
            installed: names(source.exportResult.installed),
            removed: names(source.exportResult.removed),
            diagnostics: diagnostics(source.exportResult.diagnostics)
        };
    }
    return out;
}
