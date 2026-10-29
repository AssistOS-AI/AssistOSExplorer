// Deterministic locators for per-execution resources (plan section 5.5, "Resource creation uses a publication
// barrier": Reserve). A locator names an object so that recovery can find it again from the durable record alone,
// without any identity tuple. All names derive from one unguessable value, so anything found under such a name is
// treated as owned.
//
// DERIVATION INPUT (gap G-A, reported to the coordinator). Section 5.5 derives the names from the "reservation ID".
// The S1 library generates the reservation ID inside reserveResource, after the caller's locator has been fixed, and a
// caller cannot supply one, so a locator cannot embed the reservation ID itself. The ledger therefore derives every
// name from a `locatorId`: 128 random bits chosen by the supervisor and recorded in the locator. A process-bearing
// reservation additionally carries the S1 reservation ID as its `marker` (the library adds it), which is the value the
// plan puts in argv. deriveLocator takes the id as a parameter, so switching the derivation input is a one-argument
// change if S1 later accepts a caller-chosen or returned ID.
//
// Exact forms (section 5.5, Reserve row):
//   runtime directory   <runtime>/x/<id>
//   child cgroup        <subtree>/x-<id>
//   nftables table      rw_ + the first 16 hex digits of SHA-256(id)
//   veth names          rw + the first 10 hex digits of SHA-256(id) + h (host side) or n (namespace side)
//   retained GUI        view mountpoints under <runtime>/gui/<id>/, plus a container name and label derived from <id>
// The plan does not say what the 10 veth digits are digits of (review (3) nit N3); SHA-256(id), as for the nftables
// table, is the reading used here.

import crypto from 'node:crypto';

export const RESOURCE_KINDS = Object.freeze([
    'keeper', 'endpoint', 'process-tree', 'netns', 'veth', 'nft-table', 'mount', 'pty', 'runtime-dir', 'cgroup',
    'gui-container', 'gui-view'
]);
export const PROCESS_BEARING_KINDS = Object.freeze(['keeper', 'endpoint', 'process-tree']);

const ID = /^[0-9a-f]{32}$/u;

export const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
export const newLocatorId = () => crypto.randomBytes(16).toString('hex');

function absolute(path, name) {
    if (typeof path !== 'string' || !path.startsWith('/') || (path.endsWith('/') && path !== '/') || path.split('/').some((part) => part === '..' || part === '.')) {
        throw new TypeError(`${name} must be a normalized absolute path`);
    }
    return path;
}

// layout: { runtimeDir, cgroupSubtree }. extra: kind-specific names (for example a view's grant name).
export function deriveLocator(kind, id, layout, extra = {}) {
    if (!RESOURCE_KINDS.includes(kind)) throw new TypeError(`Unknown resource kind: ${kind}`);
    if (!ID.test(id)) throw new TypeError('The locator id must be 32 lowercase hex digits');
    const digest = sha256Hex(id);
    switch (kind) {
        case 'runtime-dir': return { path: `${absolute(layout.runtimeDir, 'runtimeDir')}/x/${id}` };
        case 'cgroup': return { path: `${absolute(layout.cgroupSubtree, 'cgroupSubtree')}/x-${id}` };
        case 'nft-table': return { table: `rw_${digest.slice(0, 16)}` };
        case 'veth': return { host: `rw${digest.slice(0, 10)}h`, peer: `rw${digest.slice(0, 10)}n` };
        case 'gui-container': return { name: `rw-gui-${id}`, label: `robo-work.reservation=${id}` };
        case 'gui-view': return { mountpoint: `${absolute(layout.runtimeDir, 'runtimeDir')}/gui/${id}/${extra.grant ?? 'view'}` };
        case 'netns': return { netns: id };
        case 'mount': return { mount: id };
        case 'pty': return { pty: id };
        default: return { role: kind, id };
    }
}
