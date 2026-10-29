// Reference model of the file server's per-request logic (plan section 5.4): node and handle tracking, the
// binding-chain and current-name checks, the handle state machine, post-read check sequencing and descriptor-cap
// accounting. It is pure logic over an injected backing; the Rust server must behave the same way on the same
// scenarios. It implements decision D2, option (a) (d2Decision.mjs): post-read validation, sticky refusal after an
// observed protected name, truthful write outcomes, and best-effort invalidation intents (takeInvalidations). Root
// revocation (D-S5-6) is driven from outside through revokeRoot(): in the Rust server, the keeper's SIGTERM.
//
// Backing interface (synchronous; descriptors are opaque numbers; all lookups are no-follow and relative to a held
// directory descriptor, never by path):
//   rootDescriptor                      the inherited grant-root descriptor (not counted by the ledger)
//   identityAt(dir, name)               { identity, kind: 'file'|'dir'|'symlink'|'other' } or null for ENOENT
//   identityOf(desc)                    the identity of the held descriptor, or null when it cannot be obtained
//   openAt(dir, name, { directory })    a new descriptor for the entry (no-follow); name '.' reopens dir itself
//   close(desc)
//   read(desc, offset, length)          Buffer
//   write(desc, offset, data)           number of bytes written
//   listDir(desc)                       entry names, without '.' and '..'
//   listChildren(dir, relNames)         [{ name, isDirectory }] of the directory reached by relNames from dir
//   createAt(dir, name, { directory })  creates an entry
//   removeAt(dir, name, { directory })
//   renameAt(dir, name, newDir, newName, { exchange })
//   linkAt(sourceDesc, newDir, newName)
// A thrown error carries `code` (an errno name). identityAt, identityOf and listChildren must not open descriptors; an
// implementation that does must use the ledger's withTransient.
//
// Identity is an opaque string (device and inode on both platforms; plan section 5.4, "Current-name check"). A null or
// missing identity is never equal to anything: an identity that cannot be obtained refuses.

import { D2_DECISION } from './d2Decision.mjs';
import { createDescriptorLedger } from './descriptorLedger.mjs';
import { decideOperation, filterDirectoryEntries, scanForProtectedDescendants } from './operationPolicy.mjs';
import { isProtectedName } from './protectedNames.mjs';
import { resolveViewLimits } from './viewLimits.mjs';

export const ROOT_NODE_ID = 1;

const KNOWN_KINDS = Object.freeze(['file', 'dir', 'symlink']);

// Worst of two hidden-descendant answers: true, then 'unknown', then false.
function combineHidden(left, right) {
    if (left === true || right === true) return true;
    return left === false && right === false ? false : 'unknown';
}

const refused = (code, errnoHint) => Object.freeze({ outcome: 'refused', code, errnoHint });
const absentResult = (code) => Object.freeze({ outcome: 'absent', code, errnoHint: 'ENOENT' });

export function createViewEngine({ backing, limits: limitOverrides = {}, hardening = true }) {
    const limits = resolveViewLimits(limitOverrides);
    const ledger = createDescriptorLedger({ cap: limits.descriptorCap });
    const policyOptions = { hardening, maxComponentBytes: limits.maxComponentBytes };
    const nodes = new Map();
    const handles = new Map();
    const childIndex = new Map();
    let nextNodeId = ROOT_NODE_ID + 1;
    let nextHandle = 1;
    // Decision D2 (a), best-effort page invalidation: node ids queued for the glue's inode invalidation. An intent queue
    // only: no outcome depends on whether it is drained (takeInvalidations).
    const invalidations = new Set();

    const root = {
        id: ROOT_NODE_ID, parent: null, name: null, desc: backing.rootDescriptor, token: null,
        identity: backing.identityOf(backing.rootDescriptor), kind: 'dir', nlookup: 1, childRefs: 0, handleRefs: 0, broken: false
    };
    if (root.identity === null || root.identity === undefined) throw new Error('The grant root identity cannot be obtained');
    nodes.set(ROOT_NODE_ID, root);

    const indexKey = (parent, name) => `${parent.id}\0${name}`;
    const decide = (input) => decideOperation(input, policyOptions);

    // Every first transition to protected goes through these two, so each queues its node exactly once.
    function markBroken(node) {
        if (node.broken) return;
        node.broken = true;
        invalidations.add(node.id);
    }
    function markObserved(handle) {
        if (handle.observed) return;
        handle.observed = true;
        invalidations.add(handle.node.id);
    }

    // Binding chain and current name (plan section 5.4). Walks from the node to the grant root and, top-down, checks
    // that each component is still bound to the same object under its recorded name: the entry re-resolved from the
    // parent's held descriptor, never following a link, has the identity of the held descriptor. A component that no
    // longer resolves to it was renamed, replaced, moved or removed; the server cannot tell to what, so the node is
    // treated as found under a protected component and stays so (sticky), because a rename back could not be told
    // from a replacement (design question D-S5-3: a rename to an ordinary name cuts the old node off too). A failure to obtain an answer is 'unproven': refused now, not sticky.
    // The grant root itself has no parent in the view; its own binding is checked by the supervisor (D-S5-6,
    // grant.verifyBinding), and a revoked root makes every node protected before any backing call (revokeRoot).
    function chainState(node) {
        if (root.broken) {
            markBroken(node);
            return 'protected';
        }
        if (node.broken) return 'protected';
        const chain = [];
        for (let current = node; current.parent !== null; current = current.parent) {
            chain.push(current);
            if (chain.length > limits.maxBindingChainDepth) return 'unproven';
        }
        for (let index = chain.length - 1; index >= 0; index -= 1) {
            const component = chain[index];
            if (component.broken || isProtectedName(component.name, { hardening })) {
                markBroken(node);
                return 'protected';
            }
            let entry;
            let held;
            try {
                entry = backing.identityAt(component.parent.desc, component.name);
                held = backing.identityOf(component.desc);
            } catch {
                return 'unproven';
            }
            if (entry === null) {
                markBroken(component);
                markBroken(node);
                return 'protected';
            }
            if (!entry.identity || !held) return 'unproven';
            if (entry.identity !== held || held !== component.identity) {
                markBroken(component);
                markBroken(node);
                return 'protected';
            }
        }
        return 'ok';
    }

    function releaseNode(node) {
        let current = node;
        while (current !== null && current.parent !== null && current.nlookup === 0
            && current.childRefs === 0 && current.handleRefs === 0) {
            backing.close(current.desc);
            ledger.release(current.token);
            nodes.delete(current.id);
            if (childIndex.get(indexKey(current.parent, current.name)) === current.id) {
                childIndex.delete(indexKey(current.parent, current.name));
            }
            const parent = current.parent;
            parent.childRefs -= 1;
            current = parent;
        }
    }

    function requireNode(id) {
        const node = nodes.get(id);
        if (!node) throw new TypeError(`Unknown node ${id}`);
        return node;
    }

    function requireHandle(fh) {
        const handle = handles.get(fh);
        if (!handle) throw new TypeError(`Unknown handle ${fh}`);
        return handle;
    }

    // Registers the entry as a node with an already reserved ledger token. Returns the node or a refusal (token released).
    function registerNode(parent, name, entry, token) {
        let desc;
        try {
            desc = backing.openAt(parent.desc, name, { directory: entry.kind === 'dir' });
        } catch {
            ledger.release(token);
            return refused('binding_unproven', 'EIO');
        }
        const held = backing.identityOf(desc);
        if (!held || held !== entry.identity) {
            backing.close(desc);
            ledger.release(token);
            return refused('binding_unproven', 'EIO');
        }
        const node = {
            id: nextNodeId, parent, name, desc, token, identity: held, kind: entry.kind,
            nlookup: 1, childRefs: 0, handleRefs: 0, broken: false
        };
        nextNodeId += 1;
        nodes.set(node.id, node);
        parent.childRefs += 1;
        childIndex.set(indexKey(parent, name), node.id);
        return node;
    }

    function lookup(parentId, name) {
        const parent = requireNode(parentId);
        const verdict = decide({ op: 'lookup', names: { name }, nodes: { subject: chainState(parent) } });
        if (verdict.outcome !== 'serve') return verdict;
        let entry;
        try {
            entry = backing.identityAt(parent.desc, name);
        } catch {
            return refused('binding_unproven', 'EIO');
        }
        if (entry === null) return absentResult('not_found');
        if (!entry.identity) return refused('binding_unproven', 'EIO');
        const existingId = childIndex.get(indexKey(parent, name));
        const existing = existingId === undefined ? null : nodes.get(existingId);
        if (existing && !existing.broken && existing.identity === entry.identity) {
            existing.nlookup += 1;
            return Object.freeze({ outcome: 'serve', code: 'allowed', nodeId: existing.id, kind: existing.kind });
        }
        const grant = ledger.acquire('node');
        if (!grant.ok) return refused(grant.code, grant.errnoHint);
        const node = registerNode(parent, name, entry, grant.token);
        if (node.outcome === 'refused') return node;
        return Object.freeze({ outcome: 'serve', code: 'allowed', nodeId: node.id, kind: node.kind });
    }

    function forget(nodeId, count = 1) {
        const node = requireNode(nodeId);
        if (!Number.isSafeInteger(count) || count < 1 || count > node.nlookup) throw new RangeError('forget exceeds the lookup count');
        node.nlookup -= count;
        releaseNode(node);
        return Object.freeze({ outcome: 'serve', code: 'allowed', noDataIo: true });
    }

    function getattr(nodeId) {
        const node = requireNode(nodeId);
        const verdict = decide({ op: 'getattr', nodes: { subject: chainState(node) } });
        if (verdict.outcome !== 'serve') return verdict;
        return Object.freeze({ outcome: 'serve', code: 'allowed', identity: node.identity, kind: node.kind });
    }

    function openHandle(nodeId, op, kind) {
        const node = requireNode(nodeId);
        const verdict = decide({ op, nodes: { subject: chainState(node) } });
        if (verdict.outcome !== 'serve') return verdict;
        if ((kind === 'dir') !== (node.kind === 'dir')) return refused('invalid_request', kind === 'dir' ? 'ENOTDIR' : 'EISDIR');
        const grant = ledger.acquire(kind === 'dir' ? 'dir-handle' : 'file-handle');
        if (!grant.ok) return refused(grant.code, grant.errnoHint);
        let desc;
        try {
            // The grant root has no parent in the view: it is reopened relative to itself.
            desc = node.parent === null
                ? backing.openAt(node.desc, '.', { directory: true })
                : backing.openAt(node.parent.desc, node.name, { directory: kind === 'dir' });
        } catch {
            ledger.release(grant.token);
            return refused('binding_unproven', 'EIO');
        }
        const held = backing.identityOf(desc);
        // The new descriptor must be the node, and the binding must still hold after the open.
        if (!held || held !== node.identity || chainState(node) !== 'ok') {
            backing.close(desc);
            ledger.release(grant.token);
            const state = node.broken ? 'protected' : 'unproven';
            return decide({ op, nodes: { subject: state } });
        }
        const fh = nextHandle;
        nextHandle += 1;
        node.handleRefs += 1;
        handles.set(fh, { fh, node, desc, token: grant.token, kind, observed: false });
        return Object.freeze({ outcome: 'serve', code: 'allowed', fh });
    }

    function closeHandle(fh) {
        const handle = requireHandle(fh);
        handles.delete(fh);
        backing.close(handle.desc);
        ledger.release(handle.token);
        handle.node.handleRefs -= 1;
        releaseNode(handle.node);
        return Object.freeze({ outcome: 'serve', code: 'allowed', noDataIo: true });
    }

    // The state of a handle: once observed protected, always; otherwise the binding chain of its node.
    function handleState(handle) {
        if (handle.observed) return 'protected';
        const state = chainState(handle.node);
        if (state === 'protected') markObserved(handle);
        return state;
    }

    // Read-class operations. Sequence: handle state and pre-check, backing read, post-check, then data. Data never
    // leaves this function unless the post-check still finds an ordinary binding.
    function readClass(op, fh, run) {
        const handle = requireHandle(fh);
        const before = decide({ op, nodes: { subject: handleState(handle) } });
        if (before.outcome !== 'serve') return before;
        let data;
        try {
            data = run(handle);
        } catch (error) {
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        const after = decide({ op, nodes: { subject: handleState(handle) } });
        if (after.outcome !== 'serve') return after;
        return Object.freeze({ outcome: 'serve', code: 'allowed', data });
    }

    const open = (nodeId) => openHandle(nodeId, 'open', 'file');
    const opendir = (nodeId) => openHandle(nodeId, 'opendir', 'dir');
    const read = (fh, offset, length) => readClass('read', fh, (handle) => backing.read(handle.desc, offset, length));
    // A mapping fault is a read for the policy: refused after an observed protected name. Decision D2 (a) admits no
    // direct-I/O mapping opt-in (fuseSettings.mjs); bytes in mappings established before detection are a stated residual.
    const mappingFault = (fh, offset, length) => readClass('mapping_fault', fh, (handle) => backing.read(handle.desc, offset, length));

    function readdir(fh) {
        const handle = requireHandle(fh);
        if (handle.kind !== 'dir') return refused('invalid_request', 'ENOTDIR');
        const result = readClass('readdir', fh, (h) => backing.listDir(h.desc));
        if (result.outcome !== 'serve') return result;
        const { visible, omitted } = filterDirectoryEntries(result.data, { hardening });
        return Object.freeze({ outcome: 'serve', code: 'allowed', entries: visible, omitted });
    }

    // Write-class operation. The effect is reported as it was: when the post-check finds a protected name the handle is
    // tainted for every later operation, but the result keeps the bytes written and is never reported as refused.
    function write(fh, offset, data) {
        const handle = requireHandle(fh);
        const before = decide({ op: 'write', nodes: { subject: handleState(handle) } });
        if (before.outcome !== 'serve') return before;
        let written;
        try {
            written = backing.write(handle.desc, offset, data);
        } catch (error) {
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        const after = decide({ op: 'write', nodes: { subject: handleState(handle) } });
        return Object.freeze({
            outcome: 'serve', code: 'allowed', written,
            tainted: after.outcome !== 'serve', postCheck: after.outcome === 'serve' ? 'ordinary' : after.code
        });
    }

    function create(parentId, name, { directory = false } = {}) {
        const parent = requireNode(parentId);
        const op = directory ? 'mkdir' : 'create';
        const verdict = decide({ op, names: { name }, nodes: { subject: chainState(parent) } });
        if (verdict.outcome !== 'serve') return verdict;
        // Reserve the descriptor first: at the cap the create is refused before it has an effect.
        const grant = ledger.acquire('node');
        if (!grant.ok) return refused(grant.code, grant.errnoHint);
        try {
            backing.createAt(parent.desc, name, { directory });
        } catch (error) {
            ledger.release(grant.token);
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        let entry;
        try {
            entry = backing.identityAt(parent.desc, name);
        } catch {
            entry = null;
        }
        const node = entry && entry.identity ? registerNode(parent, name, entry, grant.token) : null;
        if (!node || node.outcome === 'refused') {
            if (!node) ledger.release(grant.token);
            return Object.freeze({ outcome: 'serve', code: 'allowed', created: true, nodeId: null, tainted: false, note: 'entry not tracked' });
        }
        if (chainState(node) !== 'ok') {
            node.nlookup = 0;
            releaseNode(node);
            return Object.freeze({ outcome: 'serve', code: 'allowed', created: true, nodeId: null, tainted: true });
        }
        return Object.freeze({ outcome: 'serve', code: 'allowed', created: true, nodeId: node.id, kind: node.kind });
    }

    function link(sourceNodeId, newParentId, newName) {
        const source = requireNode(sourceNodeId);
        const newParent = requireNode(newParentId);
        const verdict = decide({
            op: 'link', names: { name: newName },
            nodes: { subject: chainState(newParent), source: chainState(source) }
        });
        if (verdict.outcome !== 'serve') return verdict;
        try {
            backing.linkAt(source.desc, newParent.desc, newName);
        } catch (error) {
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        // The kernel counts the LINK entry reply as a lookup of the linked inode (glue obligation: reply with this node id).
        source.nlookup += 1;
        return Object.freeze({ outcome: 'serve', code: 'allowed', linked: true, nodeId: source.id, kind: source.kind });
    }

    function hiddenDescendantsOf(parent, name) {
        return scanForProtectedDescendants({
            root: [name],
            list: (relNames) => backing.listChildren(parent.desc, relNames).map((child) => ({
                name: child.name, isDirectory: child.isDirectory, ref: [...relNames, child.name]
            })),
            maxEntries: limits.maxDescendantScanEntries,
            hardening
        });
    }

    function remove(parentId, name, { directory = false } = {}) {
        const parent = requireNode(parentId);
        const op = directory ? 'rmdir' : 'unlink';
        const state = chainState(parent);
        // The scan only runs when it can matter; a protected name or a bad parent is answered before it.
        const preliminary = decide({ op, names: { name }, nodes: { subject: state }, hiddenDescendants: false });
        if (preliminary.outcome !== 'serve') return preliminary;
        const verdict = directory
            ? decide({ op, names: { name }, nodes: { subject: state }, hiddenDescendants: hiddenDescendantsOf(parent, name) })
            : preliminary;
        if (verdict.outcome !== 'serve') return verdict;
        try {
            backing.removeAt(parent.desc, name, { directory });
        } catch (error) {
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        return Object.freeze({ outcome: 'serve', code: 'allowed', removed: true });
    }

    // A rename through the view keeps the recorded bindings in step; a rename in the backing by anybody else is detected
    // by the binding chain instead.
    function rename(parentId, name, newParentId, newName, { exchange = false } = {}) {
        const parent = requireNode(parentId);
        const newParent = requireNode(newParentId);
        const sourceId = childIndex.get(indexKey(parent, name));
        const source = sourceId === undefined ? null : nodes.get(sourceId);
        if (!source) return refused('invalid_request', 'ENOENT');
        const op = exchange ? 'rename_exchange' : 'rename';
        let target = null;
        const targetId = childIndex.get(indexKey(newParent, newName));
        if (targetId !== undefined) target = nodes.get(targetId) ?? null;
        const base = {
            op, names: { name, newName },
            nodes: { subject: chainState(parent), newParent: chainState(newParent), source: chainState(source) }
        };
        const preliminary = decide({ ...base, movesDirectory: false });
        if (preliminary.outcome !== 'serve') return preliminary;
        // The target of an exchange is resolved afresh, never taken from the tracked node: a cached kind can be stale. A
        // target that cannot be resolved, has an unknown kind, or is not the tracked object counts as possibly a directory
        // with hidden entries, and only a scan that proves 'false' lets the exchange through (decision record DR-1).
        let freshTarget = null;
        if (exchange) {
            try {
                freshTarget = backing.identityAt(newParent.desc, newName);
            } catch {
                freshTarget = null;
            }
        }
        const targetUnsure = exchange && (freshTarget === null || !freshTarget.identity || !KNOWN_KINDS.includes(freshTarget.kind)
            || (target !== null && target.identity !== freshTarget.identity));
        const targetIsDirectory = exchange && freshTarget !== null && freshTarget.kind === 'dir';
        const movesDirectory = source.kind === 'dir' || targetIsDirectory || targetUnsure;
        let hidden = false;
        if (source.kind === 'dir') hidden = hiddenDescendantsOf(parent, name);
        if (targetIsDirectory || targetUnsure) hidden = combineHidden(hidden, hiddenDescendantsOf(newParent, newName));
        const verdict = decide({ ...base, movesDirectory, hiddenDescendants: hidden });
        if (verdict.outcome !== 'serve') return verdict;
        try {
            backing.renameAt(parent.desc, name, newParent.desc, newName, { exchange });
        } catch (error) {
            return Object.freeze({ outcome: 'backing_error', code: error?.code ?? 'EIO', errnoHint: error?.code ?? 'EIO' });
        }
        childIndex.delete(indexKey(parent, name));
        childIndex.delete(indexKey(newParent, newName));
        if (target && !exchange) {
            // The replaced entry no longer exists under that name; its binding fails on next use.
            markBroken(target);
        }
        const move = (node, toParent, toName) => {
            node.parent.childRefs -= 1;
            node.parent = toParent;
            node.name = toName;
            toParent.childRefs += 1;
            childIndex.set(indexKey(toParent, toName), node.id);
        };
        move(source, newParent, newName);
        if (exchange && target) {
            // A tracked target that is not the object now at that name is stale: it keeps no binding.
            if (target.identity === freshTarget?.identity) move(target, parent, name);
            else markBroken(target);
        }
        return Object.freeze({ outcome: 'serve', code: 'allowed', renamed: true });
    }

    // Root revocation (decision D-S5-6): what the file server does on the keeper's SIGTERM. Sticky. Every live node becomes
    // protected and every open handle observed, so new requests are refused or absent with no backing call, data from an
    // in-flight read is discarded by its post-check, and an in-flight write reports its true outcome (D2). Each live node is
    // queued for invalidation once. Lifecycle requests (release, forget) stay served (DR-3).
    function revokeRoot() {
        const alreadyRevoked = root.broken;
        for (const live of nodes.values()) markBroken(live);
        for (const handle of handles.values()) markObserved(handle);
        return Object.freeze({ outcome: 'serve', code: 'allowed', alreadyRevoked });
    }

    function takeInvalidations() {
        const taken = Object.freeze([...invalidations]);
        invalidations.clear();
        return taken;
    }

    return Object.freeze({
        lookup, forget, getattr, open, opendir, read, mappingFault, readdir, write, create, link, remove, rename,
        revokeRoot,
        rootState: () => (root.broken ? 'protected' : 'ok'),
        takeInvalidations,
        release: closeHandle,
        releasedir: closeHandle,
        chainState: (nodeId) => chainState(requireNode(nodeId)),
        nodeCount: () => nodes.size - 1,
        handleCount: () => handles.size,
        ledger,
        d2: D2_DECISION
    });
}
