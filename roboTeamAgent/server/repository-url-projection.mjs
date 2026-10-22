// Display value for a repository URL shown to a caller without verified
// administrator access. Mirrors remoteUrlOrEmpty in Ploinky's
// cli/server/authHandlers/marketplaceProjection.js; tests/robot-projection.test.mjs
// pins the shared vectors and compares against that module when it is present.
// The result is rebuilt from validated parts and is never the raw input: only a
// remote Git origin (scheme, host, optional port and a plain path) is emitted.
// Userinfo of any kind, query strings and fragments are always dropped. Local
// locations (absolute or relative paths, file: URLs, home-relative paths) and
// every malformed or ambiguous form yield ''.
const REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);
const SAFE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const DOTTED_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// A plain repository path: no percent-encoding, userinfo-like or query characters.
const SAFE_PATH = /^[A-Za-z0-9._~/+-]*$/;
const SCP_LIKE = /^[^@\s/:\\]+@([^@\s/:\\]+):(.+)$/;

function safePath(value) {
    return SAFE_PATH.test(value) && !value.split('/').some(segment => segment === '..');
}

export function remoteUrlOrEmpty(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    // eslint-disable-next-line no-control-regex
    if (!text || /[\s\u0000-\u001f\u007f\\]/.test(text)) return '';
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
        let parsed;
        try {
            parsed = new URL(text);
        } catch {
            return '';
        }
        if (!REMOTE_URL_PROTOCOLS.has(parsed.protocol) || !SAFE_HOSTNAME.test(parsed.hostname)) return '';
        const pathname = parsed.pathname || '/';
        if (!safePath(pathname)) return '';
        return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${pathname}`;
    }
    const scp = text.match(SCP_LIKE);
    if (!scp) return '';
    const host = scp[1].toLowerCase();
    const repoPath = scp[2];
    if (!DOTTED_HOSTNAME.test(host) || repoPath.startsWith('//') || !/[^/]/.test(repoPath) || !safePath(repoPath)) return '';
    return `${host}:${repoPath}`;
}
