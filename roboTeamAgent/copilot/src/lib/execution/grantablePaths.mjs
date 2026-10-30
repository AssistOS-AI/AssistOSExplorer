import path from 'node:path';

// Which workspace folders RoboTeam offers the worker as extra read-only grants. The worker refuses a grant whose
// path holds a protected component, and it does so at open, after admission, which fails the whole turn; so the
// same names are never sent. The only protected component allowed is the managed skill source
// `.ploinky/repos/<repo>/…`, which the worker resolves with the `skill-source` role. This mirrors the worker's
// predicate (robo-work/server/views/protectedNames.mjs) conservatively; the worker stays the authority.
const PROTECTED = new Set(['.ploinky', '.data', '.ploinky-box', '.roboteam', '.env', 'master-key']);
const fold = (name) => String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/u, '');
const protectedName = (name) => PROTECTED.has(fold(name)) || fold(name).endsWith('.secrets');

// `candidate` is an absolute path; true only when it is strictly below `root` and none of its components is protected
// (a leading `.ploinky/repos/<repo>` managed skill source excepted).
export function isGrantableFolder(root, candidate) {
    if (typeof candidate !== 'string' || !candidate.startsWith(`${root}${path.sep}`)) return false;
    const segments = candidate.slice(root.length + 1).split(path.sep);
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
    let from = 0;
    if (fold(segments[0]) === '.ploinky') {
        if (segments[1] !== 'repos' || segments.length < 3) return false;
        from = 2;
    }
    return !segments.slice(from).some(protectedName);
}
