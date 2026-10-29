// The grant-name predicate of the filtered project view (plan sections 4.1 and 5.4, focused review (4) R4-4).
//
// A name is a single path component inside a project grant. Protected names are the folded matches of:
//   `.ploinky` (controller state), `.data` (agent private data), `.ploinky-box` (Box host state),
//   `.roboteam` (private session storage, the whole directory), and key material: `.env`, `master-key`, `*.secrets`.
//
// Differences from Ploinky's workspace matcher (`isProtectedWorkspaceSegments`), all on purpose:
//   - The predicate works per component and has NO `.ploinky/repos` exemption. Ploinky and Explorer evaluate
//     workspace-relative paths, where index 0 is the workspace root. Inside a grant, index 0 is the grant root, so
//     the exemption would hide nothing and expose a nested `.ploinky/repos` (R4-4 item 3).
//   - `.roboteam` is protected. Neither Ploinky nor Explorer knows it (R4-4 item 2).
//   - A second, separate layer strips Unicode default-ignorable code points before folding (risk table of the
//     review: HFS+ and older ext4 casefold ignore some of them). It only ever adds refusals. Whether to keep it is
//     design question D-S5-1 (designQuestions.mjs); `hardening: false` yields Ploinky's behaviour plus
//     `.roboteam` for the conformance vectors and for the negative controls.
//
// The fold itself is Ploinky's `foldPathName` (`ploinky-box/hostState/paths.mjs`), copied unchanged. A test reads Ploinky's
// source file as text and compares the function text with this one, so a divergence fails; the shared vectors check behaviour.

export const NAME_CLASSES = Object.freeze({
    CONTROLLER_STATE: 'controller_state',
    AGENT_DATA: 'agent_data',
    HOST_STATE: 'host_state',
    PRIVATE_SESSION: 'private_session',
    KEY_MATERIAL: 'key_material'
});

export const NAME_LAYERS = Object.freeze({
    PLOINKY_FOLD: 'ploinky-fold',
    DEFAULT_IGNORABLE: 'default-ignorable'
});

export const SECRETS_SUFFIX = '.secrets';

// Keys are folded spellings.
const EXACT_FOLDED_NAMES = new Map([
    ['.ploinky', NAME_CLASSES.CONTROLLER_STATE],
    ['.data', NAME_CLASSES.AGENT_DATA],
    ['.ploinky-box', NAME_CLASSES.HOST_STATE],
    ['.roboteam', NAME_CLASSES.PRIVATE_SESSION],
    ['.env', NAME_CLASSES.KEY_MATERIAL],
    ['master-key', NAME_CLASSES.KEY_MATERIAL]
]);

// Ploinky's `foldPathName`: NFKC, toLowerCase, trailing dots and spaces stripped.
export function foldPathName(name) {
    return String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
}

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// The fold of the hardening layer. NFKC can itself produce a default-ignorable code point (U+FFA0 becomes U+3164),
// so stripping and folding run twice.
export function foldIgnorableStripped(name) {
    let value = String(name);
    for (let pass = 0; pass < 2; pass += 1) value = foldPathName(value.replace(DEFAULT_IGNORABLE, ''));
    return value;
}

function classifyFolded(key) {
    const exact = EXACT_FOLDED_NAMES.get(key);
    if (exact) return exact;
    return key.endsWith(SECRETS_SUFFIX) ? NAME_CLASSES.KEY_MATERIAL : null;
}

function requireString(name) {
    if (typeof name !== 'string') throw new TypeError('A name must be a string');
}

// { class, layer } for a protected name, otherwise null.
export function classifyGrantName(name, { hardening = true } = {}) {
    requireString(name);
    const plain = classifyFolded(foldPathName(name));
    if (plain) return Object.freeze({ class: plain, layer: NAME_LAYERS.PLOINKY_FOLD });
    if (!hardening) return null;
    const stripped = classifyFolded(foldIgnorableStripped(name));
    return stripped ? Object.freeze({ class: stripped, layer: NAME_LAYERS.DEFAULT_IGNORABLE }) : null;
}

export function isProtectedName(name, options) {
    return classifyGrantName(name, options) !== null;
}

// The first protected component of a grant-relative path, or null. Every component is checked; the position grants no
// exemption.
export function firstProtectedComponent(segments, options) {
    for (let index = 0; index < segments.length; index += 1) {
        const verdict = classifyGrantName(segments[index], options);
        if (verdict) return Object.freeze({ index, ...verdict });
    }
    return null;
}

export function isProtectedPath(segments, options) {
    return firstProtectedComponent(segments, options) !== null;
}

// A name that a FUSE lookup or create can legitimately carry: one component, not `.` or `..`, no slash or NUL, within
// the byte bound. An invalid name is refused as invalid, so the predicate never sees a path.
export function isValidComponentName(name, maxComponentBytes = 255) {
    return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
        && !name.includes('/') && !name.includes('\0')
        && Buffer.byteLength(name, 'utf8') <= maxComponentBytes;
}

// The Unicode and ICU versions that the vectors were generated against. The Rust fold must pin the same Unicode
// version (R4-4 item 4); the vector file records these values.
export function foldEnvironment() {
    return Object.freeze({ unicode: process.versions.unicode, icu: process.versions.icu, node: process.version });
}
