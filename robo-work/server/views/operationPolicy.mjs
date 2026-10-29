// The per-operation allow/refuse policy of the filtered project view (plan section 5.4), as a pure function of
// operation, operand names and binding-chain state. It touches no file system and keeps no state. The file server
// (Rust, not written here) must give the same answers on the exported vectors (tests/views/vectors/operation-policy.json).
//
// Inputs
//   op                  an operation name of OPERATIONS; any other name is refused (default deny).
//   names               operand names by role. Roles per operation: see OPERATIONS[op].names.
//   nodes               binding-chain state by role: 'ok' | 'protected' | 'unproven'.
//                         'protected' means the node, or a component of its binding chain, was found under a protected
//                         name or no longer bound under its recorded name, or the handle was observed protected. It is
//                         sticky in the engine (viewEngine.mjs). 'unproven' means the binding could not be proven now.
//   movesDirectory      renames only: whether a directory is moved (or, for an exchange, either operand is one).
//   hiddenDescendants   rmdir and directory renames: true | false | 'unknown' for protected entries below the
//                         directories involved.
//   attribute           xattr operations: the attribute name.
//
// There is deliberately no input for "does the entry exist": an answer must not depend on it, or it becomes an
// existence oracle.
//
// Outcomes: 'serve' | 'absent' | 'refused'. 'absent' must be indistinguishable from a missing entry (ENOENT).

import { isProtectedName, isValidComponentName } from './protectedNames.mjs';

export const OUTCOMES = Object.freeze({ SERVE: 'serve', ABSENT: 'absent', REFUSED: 'refused' });

// postCheck tells the engine what to do after the backing operation:
//   'discard_data_on_failure'  the post-operation check must still find an ordinary binding or the data is dropped
//   'report_true_outcome'      the effect took place; a failed check taints the handle but the result is reported as it was
export const POST_CHECKS = Object.freeze({
    DISCARD: 'discard_data_on_failure',
    REPORT: 'report_true_outcome'
});

const KINDS = Object.freeze({
    NAME_QUERY: 'name_query',
    NODE_QUERY: 'node_query',
    NAME_CREATE: 'name_create',
    NAME_REMOVE: 'name_remove',
    RENAME: 'rename',
    HANDLE: 'handle',
    LIFECYCLE: 'lifecycle',
    FORBIDDEN: 'forbidden',
    XATTR: 'xattr',
    UNSUPPORTED: 'unsupported'
});

const op = (kind, names, nodes, extra = {}) => Object.freeze({ kind, names: Object.freeze(names), nodes: Object.freeze(nodes), ...extra });

// Every operation that the file server may receive. Anything else is refused as unknown_operation.
export const OPERATIONS = Object.freeze({
    // Lookup, attribute read, open, directory listing, symlink read, access check (table row 1).
    lookup: op(KINDS.NAME_QUERY, ['name'], ['subject']),
    getattr: op(KINDS.NODE_QUERY, [], ['subject']),
    access: op(KINDS.NODE_QUERY, [], ['subject']),
    statfs: op(KINDS.NODE_QUERY, [], ['subject']),
    open: op(KINDS.NODE_QUERY, [], ['subject']),
    opendir: op(KINDS.NODE_QUERY, [], ['subject']),
    readlink: op(KINDS.NODE_QUERY, [], ['subject'], { postCheck: POST_CHECKS.DISCARD }),
    // Create, make directory, make node, temporary file, symlink, hard link, rename onto a name (table row 2).
    create: op(KINDS.NAME_CREATE, ['name'], ['subject']),
    mkdir: op(KINDS.NAME_CREATE, ['name'], ['subject']),
    mknod: op(KINDS.NAME_CREATE, ['name'], ['subject']),
    tmpfile: op(KINDS.NAME_CREATE, [], ['subject']),
    symlink: op(KINDS.NAME_CREATE, ['name'], ['subject']),
    link: op(KINDS.NAME_CREATE, ['name'], ['subject', 'source']),
    rename: op(KINDS.RENAME, ['name', 'newName'], ['subject', 'newParent', 'source']),
    rename_exchange: op(KINDS.RENAME, ['name', 'newName'], ['subject', 'newParent', 'source']),
    rename_whiteout: op(KINDS.RENAME, ['name', 'newName'], ['subject', 'newParent', 'source']),
    // Removal (not a table row; decision records DR-1 and DR-2).
    unlink: op(KINDS.NAME_REMOVE, ['name'], ['subject']),
    rmdir: op(KINDS.NAME_REMOVE, ['name'], ['subject'], { directory: true }),
    // Read or write on an open handle (table row 3). A mapping fault is a read.
    read: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.DISCARD }),
    // A listing is read through an open directory handle, so it follows the handle rule.
    readdir: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.DISCARD, listing: true }),
    readdirplus: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.DISCARD, listing: true }),
    mapping_fault: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.DISCARD }),
    write: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.REPORT }),
    fallocate: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.REPORT }),
    setattr: op(KINDS.HANDLE, [], ['subject'], { postCheck: POST_CHECKS.REPORT }),
    // Not served (decision record DR-7): the source bytes would reach a readable destination without a post-read check.
    // ENOSYS makes the kernel fall back to the checked read and write path.
    copy_file_range: op(KINDS.UNSUPPORTED, [], ['subject', 'source'], { refusalCode: 'copy_file_range_not_supported' }),
    lseek: op(KINDS.HANDLE, [], ['subject']),
    fsync: op(KINDS.HANDLE, [], ['subject']),
    fsyncdir: op(KINDS.HANDLE, [], ['subject']),
    getlk: op(KINDS.HANDLE, [], ['subject']),
    setlk: op(KINDS.HANDLE, [], ['subject']),
    poll: op(KINDS.HANDLE, [], ['subject']),
    // Notifications that carry no data and free resources (decision record DR-3).
    release: op(KINDS.LIFECYCLE, [], []),
    releasedir: op(KINDS.LIFECYCLE, [], []),
    forget: op(KINDS.LIFECYCLE, [], []),
    batch_forget: op(KINDS.LIFECYCLE, [], []),
    flush: op(KINDS.LIFECYCLE, [], []),
    interrupt: op(KINDS.LIFECYCLE, [], []),
    // Backing-resolution row: no ioctl is passed through; extended attributes are limited to a reviewed set.
    ioctl: op(KINDS.FORBIDDEN, [], ['subject']),
    getxattr: op(KINDS.XATTR, [], ['subject']),
    setxattr: op(KINDS.XATTR, [], ['subject']),
    listxattr: op(KINDS.XATTR, [], ['subject']),
    removexattr: op(KINDS.XATTR, [], ['subject'])
});

const NODE_STATES = Object.freeze(['ok', 'protected', 'unproven']);
const ALLOWED_INPUT_KEYS = new Set(['op', 'names', 'nodes', 'movesDirectory', 'hiddenDescendants', 'attribute']);

// errno names are HINTS for the glue, provisional (design question D-S5-5). The vectors assert outcome and code only,
// except that 'absent' is always ENOENT.
const ERRNO_BY_CODE = Object.freeze({
    protected_name: 'ENOENT',
    node_under_protected_component: 'ENOENT',
    protected_operand: 'EACCES',
    handle_observed_protected: 'EACCES',
    hidden_descendants: 'EACCES',
    hidden_descendants_unknown: 'EACCES',
    binding_unproven: 'EIO',
    invalid_name: 'EINVAL',
    unknown_operation: 'ENOSYS',
    ioctl_not_passed_through: 'ENOTTY',
    xattr_not_reviewed: 'ENOTSUP',
    descriptor_cap: 'EMFILE',
    invalid_request: 'EINVAL',
    copy_file_range_not_supported: 'ENOSYS'
});

const serve = (spec, extra = {}) => Object.freeze({
    outcome: OUTCOMES.SERVE, code: 'allowed', errnoHint: null,
    postCheck: spec.postCheck ?? null, ...extra
});
const refuse = (code) => Object.freeze({ outcome: OUTCOMES.REFUSED, code, errnoHint: ERRNO_BY_CODE[code] ?? 'EACCES', postCheck: null });
const absent = (code) => Object.freeze({ outcome: OUTCOMES.ABSENT, code, errnoHint: 'ENOENT', postCheck: null });

function validateShape(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('The input must be an object');
    for (const key of Object.keys(input)) {
        if (!ALLOWED_INPUT_KEYS.has(key)) throw new TypeError(`Unknown policy input: ${key}`);
    }
}

// decideOperation(input, { reviewedXattrs = [], hardening = true, maxComponentBytes = 255 })
export function decideOperation(input, options = {}) {
    validateShape(input);
    const { reviewedXattrs = [], hardening = true, maxComponentBytes = 255 } = options;
    const spec = typeof input.op === 'string' && Object.hasOwn(OPERATIONS, input.op) ? OPERATIONS[input.op] : null;
    if (!spec) return refuse('unknown_operation');

    if (spec.kind === KINDS.LIFECYCLE) return serve(spec, { noDataIo: true });
    // An unsupported operation is refused whatever the node states say: the answer must not depend on them.
    if (spec.kind === KINDS.UNSUPPORTED) return refuse(spec.refusalCode);
    const names = input.names ?? {};
    const nodes = input.nodes ?? {};
    if (typeof names !== 'object' || names === null || typeof nodes !== 'object' || nodes === null) return refuse('invalid_request');
    if (Object.keys(names).some((role) => !spec.names.includes(role))
        || Object.keys(nodes).some((role) => !spec.nodes.includes(role))) return refuse('invalid_request');

    // Node states first: a node under a protected component answers nothing about its operands.
    let sawProtected = false;
    let sawUnproven = false;
    for (const role of spec.nodes) {
        const state = nodes[role];
        if (!NODE_STATES.includes(state)) return refuse('invalid_request');
        if (state === 'protected') sawProtected = true;
        if (state === 'unproven') sawUnproven = true;
    }
    if (sawProtected) {
        if (spec.kind === KINDS.HANDLE) return refuse('handle_observed_protected');
        const hidesExistence = spec.kind === KINDS.NAME_QUERY || spec.kind === KINDS.NODE_QUERY || spec.kind === KINDS.NAME_REMOVE;
        return hidesExistence ? absent('node_under_protected_component') : refuse('node_under_protected_component');
    }
    if (sawUnproven) return refuse('binding_unproven');

    if (spec.kind === KINDS.FORBIDDEN) return refuse('ioctl_not_passed_through');
    if (spec.kind === KINDS.XATTR) {
        return typeof input.attribute === 'string' && reviewedXattrs.includes(input.attribute)
            ? serve(spec) : refuse('xattr_not_reviewed');
    }

    for (const role of spec.names) {
        if (!Object.hasOwn(names, role) || !isValidComponentName(names[role], maxComponentBytes)) return refuse('invalid_name');
    }
    const protectedRoles = spec.names.filter((role) => isProtectedName(names[role], { hardening }));

    switch (spec.kind) {
        case KINDS.NAME_QUERY:
            return protectedRoles.length > 0 ? absent('protected_name') : serve(spec);
        case KINDS.NODE_QUERY:
        case KINDS.HANDLE:
            return serve(spec);
        case KINDS.NAME_CREATE:
            return protectedRoles.length > 0 ? refuse('protected_operand') : serve(spec);
        case KINDS.NAME_REMOVE: {
            if (protectedRoles.length > 0) return absent('protected_name');
            return spec.directory ? hiddenDescendantsVerdict(input.hiddenDescendants, spec) : serve(spec);
        }
        case KINDS.RENAME: {
            if (protectedRoles.length > 0) return refuse('protected_operand');
            if (typeof input.movesDirectory !== 'boolean') return refuse('invalid_request');
            return input.movesDirectory ? hiddenDescendantsVerdict(input.hiddenDescendants, spec) : serve(spec);
        }
        default:
            return refuse('unknown_operation');
    }
}

// Decision record DR-1: a directory with a hidden (protected) descendant is not removed or moved by a robot, and an
// answer that is not a definite false refuses.
function hiddenDescendantsVerdict(value, spec) {
    if (value === false) return serve(spec);
    if (value === true) return refuse('hidden_descendants');
    return refuse('hidden_descendants_unknown');
}

// The protected-name filter of a directory listing. '.' and '..' are synthetic and pass.
export function filterDirectoryEntries(entries, options = {}) {
    const { hardening = true } = options;
    const visible = [];
    let omitted = 0;
    for (const name of entries) {
        if (name === '.' || name === '..' || !isProtectedName(name, { hardening })) visible.push(name);
        else omitted += 1;
    }
    return Object.freeze({ visible: Object.freeze(visible), omitted });
}

// A bounded walk for protected entries below a directory, never following links. `list(ref)` returns the children as
// { name, isDirectory, ref } (ref is opaque, used only for directories). The answer is true, false or 'unknown' when
// the entry budget is exhausted or a listing fails: callers refuse on anything but false.
export function scanForProtectedDescendants({ root, list, maxEntries, hardening = true }) {
    const pending = [root];
    let visited = 0;
    while (pending.length > 0) {
        const ref = pending.pop();
        let children;
        try {
            children = list(ref);
        } catch {
            return 'unknown';
        }
        for (const child of children) {
            visited += 1;
            if (visited > maxEntries) return 'unknown';
            if (isProtectedName(child.name, { hardening })) return true;
            if (child.isDirectory) pending.push(child.ref);
        }
    }
    return false;
}

// Decision records. status: 'table' (stated by the plan), 'decided' (decided by the plan owner and recorded in plan
// section 16; `decision` names the decision), 'proposed' (this slice's proposal, for the reviewers) or 'question' (needs
// the plan owner; not resolved here).
export const DECISION_RECORDS = Object.freeze([
    Object.freeze({
        id: 'DR-1', status: 'decided', decision: 'D-S5-10',
        text: 'D-S5-10, review R4-5, decided 2026-10-28 (plan section 16). rmdir, and a rename that moves a directory, are refused when '
            + 'the directory has a protected descendant, and also when that cannot be established (unknown refuses). Both sides of an '
            + 'exchange are scanned: the source directory and the target directory. Explorer refuses the same cases '
            + '(assertNoProtectedEntriesBelow). The refusal still reveals that a hidden entry exists, as ENOTEMPTY would; it removes '
            + 'the integrity effect, not the existence signal. The existence signal and refusals of large directories (scan budget '
            + 'exhausted) are accepted residuals, measured in G6. The scan is not atomic against independent writers: an entry created '
            + 'below the directory after the scan read it is not seen. A protected NAME as unlink or rmdir operand is absent (ENOENT), '
            + 'which cannot depend on existence.'
    }),
    Object.freeze({
        id: 'DR-2', status: 'proposed',
        text: 'unlink and rmdir are not rows of the plan table. A protected operand name is reported absent, like a lookup.'
    }),
    Object.freeze({
        id: 'DR-3', status: 'proposed',
        text: 'release, releasedir, forget, batch_forget, flush and interrupt are always honoured and do no data I/O, also on a '
            + 'tainted node or handle. Refusing them would leak descriptors toward the cap.'
    }),
    Object.freeze({
        id: 'DR-4', status: 'table',
        text: 'No ioctl is passed through. Extended attributes are refused unless the attribute is in a reviewed set; '
            + 'the set is a parameter and is empty by default, because the plan does not name the reviewed set.'
    }),
    Object.freeze({
        id: 'DR-5', status: 'table',
        text: 'A node whose binding chain is broken is treated as found under a protected component: name queries through it '
            + 'are absent, every other operation is refused. A link or rename whose source node is in that state is refused, '
            + 'so a tainted node cannot be re-exposed under an ordinary name.'
    }),
    Object.freeze({
        id: 'DR-7', status: 'proposed',
        text: 'copy_file_range is refused (ENOSYS hint) so the kernel falls back to a read and a write, which carry the post-read check. '
            + 'Judged for the other operations: lseek (SEEK_DATA and SEEK_HOLE) discloses only the hole layout of a handle that is refused '
            + 'once tainted, fallocate and setattr move no source bytes, and no splice-like request exists at the FUSE operation level '
            + '(splice delivery is forbidden in fuseSettings.mjs). Only write, fallocate and setattr keep the report-true-outcome rule.'
    }),
    Object.freeze({
        id: 'DR-6', status: 'question',
        text: 'D-S5-2. The target string of a symlink is not an operand name and is not checked: links are returned as links and resolve '
            + 'in the robot namespace through the view, where the protected name is absent. Checking the string would be stricter.'
    })
]);
