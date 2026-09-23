import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The Explorer repository is installed by Ploinky under this alias.
export const EXPLORER_REPO_ALIAS = 'AchillesIDE';
export const EXPLORER_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// Sibling repositories the current graph crosses into. A qualified ref whose
// repository part is neither one of these nor the Explorer alias is a defect
// (a typo such as `proxy/soul-gateway`), never an environment gap. A new
// sibling repository in the graph is added here and to the README table.
export const KNOWN_SIBLINGS = Object.freeze(['AchillesCLI', 'proxies', 'UmamiAgent']);

// Minimum sibling revisions, keyed by the enabled agent ref. A present sibling
// that lacks the manifest of one of these agents is an environment gap only
// when its checkout provably does not contain the recorded revision; every
// other missing manifest in a present sibling is a defect. `advice` appears in
// the message only and never widens what can be skipped.
export const MINIMUM_REVISIONS = Object.freeze({
    'proxies/opencode-free': Object.freeze({
        revision: '22dc0cc90458e1b2e7a861c79b67782b64c0a755',
        why: 'first revision with the published opencode-free/manifest.json',
        advice: '2a95a2e (current opencode-free agent tip)',
    }),
});

// Every environment gap carries this code, so a caller can turn it into an
// explicit skip. A defect is a plain Error without a code.
export const SIBLING_MISSING_CODE = 'EXPLORER_GRAPH_SIBLING_MISSING';

const DOC_POINTER = 'See AssistOSExplorer/tests/smoke/README.md, "Sibling checkouts for the Explorer graph helper", '
    + 'for the sibling repositories this graph walks and their minimum revisions.';

const enableTokens = (entry) => (typeof entry === 'string' ? entry : entry?.agent || '').trim().split(/\s+/);
const shortRevision = (revision) => revision.slice(0, 7);

function revisionHint(ref) {
    const minimum = MINIMUM_REVISIONS[ref];
    if (!minimum) return '';
    return ` The checkout must contain at least ${shortRevision(minimum.revision)} (${minimum.why}); `
        + `${minimum.advice} or later is recommended.`;
}

// Variables that point git at a repository other than `dir`, as inside a git
// hook; left in place they would make an unrelated checkout answer for `dir`.
const GIT_LOCATION_VARIABLES = [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

function git(dir, args) {
    const env = { ...process.env };
    for (const name of GIT_LOCATION_VARIABLES) delete env[name];
    return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function realpathOrNull(dir) {
    try {
        return fs.realpathSync(dir);
    } catch {
        return null;
    }
}

// A shallow checkout cannot prove that a revision is absent: its history is
// truncated, so a missing object or a failed ancestry check may only mean that
// the revision lies beyond the shallow boundary. Only an explicit `false` from
// `rev-parse --is-shallow-repository` counts as a complete history.
function hasCompleteHistory(dir) {
    const shallow = git(dir, ['rev-parse', '--is-shallow-repository']);
    return !shallow.error && shallow.status === 0 && shallow.stdout.trim() === 'false';
}

// Whether the git checkout at `dir` contains `revision` in its HEAD history:
// `true` it does; `false` it provably does not, including a revision object
// the checkout does not have; `null` undetermined (`dir` is not the top level
// of a git checkout, git is unavailable, or any other error). A shallow
// checkout cannot prove that a revision is absent, so every answer that would
// be `false` is `null` when the checkout is shallow or its shallowness cannot
// be read.
export function gitContainsRevision(dir, revision) {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.error || top.status !== 0) return null;
    const expected = realpathOrNull(dir);
    if (!expected || realpathOrNull(top.stdout.trim()) !== expected) return null;
    const absent = () => (hasCompleteHistory(dir) ? false : null);
    const object = git(dir, ['cat-file', '-e', `${revision}^{commit}`]);
    if (object.error) return null;
    if (object.status !== 0) return absent();
    const ancestor = git(dir, ['merge-base', '--is-ancestor', revision, 'HEAD']);
    if (ancestor.error) return null;
    if (ancestor.status === 0) return true;
    if (ancestor.status === 1) return absent();
    return null;
}

// The production resolver adds the enable list of the active profile (or of
// the default profile) to `enable`. Any profile can be the active one, so
// every profile's list is walked. No manifest in the current graph declares a
// profile-level enable list, so the runtime totals still equal the resolver's.
export function enableEntries(manifest) {
    const entries = [...(manifest.enable || [])];
    for (const profile of Object.values(manifest.profiles || {})) {
        if (Array.isArray(profile?.enable)) entries.push(...profile.enable);
    }
    return entries;
}

// Walks every manifest reachable from explorer/manifest.json. Qualified refs
// (`repo/agent`) resolve to a sibling checkout of the Explorer repository,
// except the Explorer alias, which resolves to the Explorer repository itself.
// Bare refs resolve inside the repository of the manifest that enables them.
// An edge for which `isRetired(ref)` is true is reported and not followed.
//
// The whole graph is always walked, and every finding is either
// - an environment gap: a known sibling repository absent from the siblings
//   root, or a present sibling that lacks the manifest of an agent whose
//   recorded minimum revision its checkout provably does not contain
//   (`containsRevision(dir, revision) === false`). A gap stops only the branch
//   below it; or
// - a defect: everything else. That includes a qualified ref to a repository
//   that is not a known sibling, a manifest missing inside the Explorer
//   repository, a manifest missing in a present sibling when no minimum is
//   recorded for that ref or the checkout contains the minimum or containment
//   cannot be determined (a shallow checkout cannot prove that a revision is
//   absent), an unsupported ref, an empty enable entry and an unreadable
//   manifest.
// A retired edge (a violation) is found before the branch below it would be
// resolved, so violations are known even when gaps hide part of the graph. A
// defect or a retired-runtime violation is never skipped. At the end:
// - any defect, or any violation together with any gap, throws a plain Error
//   (no `code`) listing every defect, every violation and, for context, every
//   gap, with `defects`, `violations` and `gaps` attached;
// - otherwise any gap throws an Error with `code === SIBLING_MISSING_CODE`
//   listing every gap on one line;
// - otherwise `{ runtimes, violations }` is returned, and the caller asserts
//   on `violations`.
export function resolveExplorerGraph({
    explorerRepo = EXPLORER_REPO_ROOT,
    siblingsRoot = path.resolve(explorerRepo, '..'),
    isRetired = () => false,
    containsRevision = gitContainsRevision,
} = {}) {
    const runtimes = new Map();
    const violations = [];
    const defects = [];
    const gaps = [];
    const addGap = (message) => {
        if (!gaps.includes(message)) gaps.push(message);
    };
    const repoDir = (repo, ref, enabledBy) => {
        if (repo === EXPLORER_REPO_ALIAS) return explorerRepo;
        if (!KNOWN_SIBLINGS.includes(repo)) {
            defects.push(`${enabledBy} enables "${ref}", but "${repo}" is not a known sibling repository of the `
                + `Explorer graph (known: ${KNOWN_SIBLINGS.join(', ')}; "${EXPLORER_REPO_ALIAS}" names the Explorer `
                + 'repository itself). Fix the ref, or add the repository to KNOWN_SIBLINGS in '
                + 'tests/smoke/lib/explorer-graph.mjs and to the README table.');
            return null;
        }
        const dir = path.join(siblingsRoot, repo);
        if (!fs.existsSync(dir)) {
            addGap(`Sibling repository "${repo}" enabled by ${enabledBy} is missing at ${dir}; `
                + `check out "${repo}" next to the Explorer repository (siblings root ${siblingsRoot}) `
                + 'before running this graph test.');
            return null;
        }
        return dir;
    };
    const missingManifest = ({ ref, key, repo, dir, manifestFile, enabledBy }) => {
        const missing = `Agent "${ref}" enabled by ${enabledBy} has no manifest at ${manifestFile}`;
        // Inside the Explorer repository this is a broken graph the developer
        // owns, whatever the siblings look like.
        if (dir === explorerRepo) {
            defects.push(missing);
            return;
        }
        const minimum = MINIMUM_REVISIONS[key];
        if (!minimum) {
            defects.push(`${missing}; the sibling repository "${repo}" is checked out at ${dir} but has no "${key}" `
                + 'agent and no minimum revision is recorded for it, so the enable edge is wrong or the agent was '
                + 'renamed or removed.');
            return;
        }
        const short = shortRevision(minimum.revision);
        const contains = containsRevision(dir, minimum.revision);
        if (contains === false) {
            addGap(`${missing}; the sibling repository "${repo}" is checked out at ${dir} but does not contain `
                + `${short}, so it predates this enable edge.${revisionHint(key)}`);
            return;
        }
        const reason = contains === true
            ? `already contains the minimum revision ${short}, so the agent was renamed or removed there`
            : `cannot be checked for the minimum revision ${short} (not a git checkout, a shallow checkout that `
                + 'cannot prove the revision is absent, or git failed), so it is not treated as an outdated checkout';
        defects.push(`${missing}; the sibling repository "${repo}" at ${dir} ${reason}.`);
    };
    function visit(ref, fromRepo, fromRepoDir, flags, enabledBy) {
        const parts = ref.split('/');
        if (parts.length !== 1 && parts.length !== 2) {
            defects.push(`${enabledBy} enables unsupported ref "${ref}"`);
            return;
        }
        const [repo, agent] = parts.length === 2 ? parts : [fromRepo, parts[0]];
        const dir = parts.length === 2 ? repoDir(repo, ref, enabledBy) : fromRepoDir;
        if (!dir) return;
        const key = `${repo}/${agent}`;
        const known = runtimes.get(key);
        if (known) {
            flags.forEach((flag) => known.flags.add(flag));
            return;
        }
        const manifestFile = path.join(dir, agent, 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            missingManifest({ ref, key, repo, dir, manifestFile, enabledBy });
            return;
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        } catch (error) {
            defects.push(`Cannot read manifest for ${key} at ${manifestFile}: ${error.message}`);
            return;
        }
        runtimes.set(key, { flags: new Set(flags), manifestFile });
        for (const entry of enableEntries(manifest)) {
            const [childRef, ...childFlags] = enableTokens(entry);
            if (!childRef) {
                defects.push(`${key} has an empty enable entry`);
                continue;
            }
            if (isRetired(childRef)) {
                violations.push(`${key} (${manifestFile}) enables ${childRef}`);
                continue;
            }
            visit(childRef, repo, dir, childFlags, key);
        }
    }
    visit('explorer', EXPLORER_REPO_ALIAS, explorerRepo, [], 'the Explorer root');
    if (defects.length || (violations.length && gaps.length)) {
        const lines = [];
        if (defects.length) {
            lines.push(`The Explorer graph has ${defects.length} defect(s):`, ...defects.map((defect) => `- ${defect}`));
        }
        if (violations.length) {
            lines.push(`The Explorer graph enables ${violations.length} retired runtime(s):`,
                ...violations.map((violation) => `- ${violation}`));
        }
        if (gaps.length) lines.push('Environment gaps also found:', ...gaps.map((gap) => `- ${gap}`));
        const error = new Error(lines.join('\n'));
        error.defects = defects;
        error.violations = violations;
        error.gaps = gaps;
        throw error;
    }
    if (gaps.length) {
        const error = new Error(`${gaps.join(' ')} ${DOC_POINTER}`);
        error.code = SIBLING_MISSING_CODE;
        error.gaps = gaps;
        throw error;
    }
    return { runtimes, violations };
}

// Resolves the graph for a test, turning environment gaps (and only gaps) into
// an explicit skip that carries the same actionable message, so a developer
// without the siblings reads what to check out instead of a stack trace.
// Returns `null` when the test was skipped. A defect or a retired-runtime
// violation is never skipped: either still throws, even when gaps were found
// too. `t` is any object exposing `skip(message)`.
export function resolveExplorerGraphOrSkip(t, options = {}) {
    try {
        return resolveExplorerGraph(options);
    } catch (error) {
        if (error?.code !== SIBLING_MISSING_CODE) throw error;
        t.skip(`Skipped: the Explorer graph cannot be resolved in this checkout. ${error.message}`);
        return null;
    }
}

export function noWaitRuntimes(runtimes) {
    return [...runtimes].filter(([, value]) => value.flags.has('no-wait')).map(([key]) => key);
}
