// The recovery walk (plan section 5.5, "Recovery walks each unsettled blocker"), and the proof of absence that the end
// path shares with it. Both work through the supervisor's own view of the container, never through a signal that was
// merely sent.
//
//   - A reserved but uncommitted process-bearing resource is walked by its marker alone: the reservation ID that the
//     sandbox supervisor and each gated pre-exec stage carry in argv (the value of bwrap's `--unsetenv <id>` element), visible in /proc/<pid>/cmdline until the final exec. Proven
//     absence needs no /proc entry carrying the marker AND the sandbox supervisor's identity absent, so a crash before commit
//     leaves no permanent quarantine when nothing survives (R3-1). The same holds for an uncommitted namespace or
//     mount, which has no recorded inode and is held only by the sandbox supervisor and its tree: it is absent only when the sandbox supervisor
//     is. The sandbox supervisor is judged from ITS OWN record (its committed identity or its marker, checked against /proc),
//     whatever its release state: a sandbox supervisor that was quarantined is still running, and is present. Every dependent
//     records the sandbox supervisor's reservation ID in its locator (`keeper`), so the record can be found at any later time, also
//     after a crash during recovery.
//   - Any other uncommitted resource is walked by its locator. Anything found under a locator derived from an
//     unguessable id is treated as owned.
//   - A committed resource is walked by locator plus identity tuple: a process by pid, start time and PID-namespace
//     inode (and every member of that namespace, so double-forked and setsid descendants are found), a mount by mount
//     ID, mountpoint and mount-namespace inode, a namespace by its inode (no /proc/*/ns link, no /proc/*/fd link and no
//     nsfs mount may carry it).
//   - The outcome is `released` on proven absence within the release deadline and `quarantined` otherwise.
//
// Nothing is ever assumed absent: an answer from the sandbox supervisor ("I aborted it") is a request, not a proof.
//
// The view is an injected interface (the model checks back it with a fake /proc and fake mountinfo):
//   view.listProcesses() -> [{ pid, ppid, startTime, cmdline: string[], pidNs, netNs, mntNs, fdNs: number[] }]
//   view.listMounts()    -> [{ mountId, mountpoint, mntNs, fstype, nsInode }]
//   view.exists(kind, locator) -> boolean          for locator-named objects
//   view.kill({ pid, startTime }) -> boolean       acts only if pid and start time still match
//   view.remove(kind, locator) -> boolean
//   view.unmount({ mountId, mountpoint }) -> boolean
// clock: { now(), sleep(ms) }. releaseDeadlineMs and pollMs are PROVISIONAL (G5 fixes the release deadline).

export const RELEASED = 'released';
export const QUARANTINED = 'quarantined';

// Dependency order of a walk: a resource is walked after everything that can hold it.
const WALK_ORDER = ['keeper', 'endpoint', 'process-tree', 'pty', 'veth', 'nft-table', 'netns', 'mount', 'runtime-dir', 'cgroup', 'gui-view', 'gui-container'];
const PROCESS_KINDS = new Set(['keeper', 'endpoint', 'process-tree']);
const NAMESPACE_KINDS = { netns: 'netNs', mount: 'mntNs' };
const LOCATOR_KINDS = new Set(['veth', 'nft-table', 'runtime-dir', 'cgroup', 'pty', 'gui-container']);

export function walkOrder(blockers) {
    const rank = (kind) => { const index = WALK_ORDER.indexOf(kind); return index < 0 ? WALK_ORDER.length : index; };
    return [...blockers].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function withDescendants(seed, processes) {
    const members = new Map(seed.map((entry) => [entry.pid, entry]));
    for (let grew = true; grew;) {
        grew = false;
        for (const entry of processes) {
            if (!members.has(entry.pid) && members.has(entry.ppid)) { members.set(entry.pid, entry); grew = true; }
        }
    }
    return [...members.values()];
}

const identityMatches = (entry, identity) => entry.pid === identity.pid && entry.startTime === identity.startTime;

// sandboxRecord(blocker) -> the sandbox supervisor's own public record (any release state) for a blocker whose locator names a
// sandbox. It is REQUIRED: a walker without it could not tell a missing sandbox from an absent one. It is called only for
// a blocker that names a sandbox supervisor, and a record that cannot be read (it throws, or returns nothing) makes that blocker's
// absence unprovable, never absent. Pass `() => null` only where no blocker names a sandbox supervisor.
export function createWalker({ view, clock, releaseDeadlineMs, pollMs, sandboxRecord }) {
    if (typeof sandboxRecord !== 'function') throw new TypeError('sandboxRecord is required');
    for (const [name, value] of Object.entries({ releaseDeadlineMs, pollMs })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
    }

    // The sandbox supervisor's processes as /proc shows them now, from the sandbox supervisor's own record whatever its release state: its
    // committed identity, or its marker if it never committed. A blocker that names no sandbox has none to wait for
    // ([]). A blocker that names one whose record is missing or unreadable returns null: that is unprovable.
    function sandboxProcesses(blocker, processes) {
        if (!blocker.locator?.keeper) return [];
        let sandbox;
        try { sandbox = sandboxRecord(blocker); } catch { return null; }
        if (!sandbox || typeof sandbox !== 'object' || !sandbox.locator) return null;
        if (sandbox.identity === null) return processes.filter((entry) => entry.cmdline.includes(sandbox.locator.marker));
        return processes.filter((entry) => identityMatches(entry, sandbox.identity));
    }

    // `descend` also takes the descendants (needed to force, since a double-forked child must die too). The sandbox supervisor's own
    // absence does not wait for them: each of them has its own blocker.
    // A namespace INODE is reused by the kernel once the namespace is gone (observed: successive bwrap sandboxes get the same
    // pid, ipc and user inode numbers). An inode therefore identifies a namespace only while something proves it is still the
    // recorded one: the supervisor pins it with an open descriptor (view.isPinned) or the recorded init (pid + start time) is
    // alive and in that namespace. A process that merely shows the same number is not a member and is never killed.
    function pidNamespaceProven(identity, processes) {
        if (view.isPinned?.('pid', identity.pidNs) === true) return true;
        const anchor = identity.init ?? identity;
        return processes.some((entry) => entry.pid === anchor.pid && entry.startTime === anchor.startTime && entry.pidNs === identity.pidNs);
    }

    function processMembers(blocker, processes, { descend = true } = {}) {
        let seed;
        if (blocker.identity === null) {
            // Uncommitted: found by the marker in argv alone.
            seed = processes.filter((entry) => entry.cmdline.includes(blocker.locator.marker));
        } else {
            const { identity } = blocker;
            seed = processes.filter((entry) => identityMatches(entry, identity) || (identity.init !== undefined && identityMatches(entry, identity.init)));
            if (identity.pidNs !== undefined && pidNamespaceProven(identity, processes)) {
                seed.push(...processes.filter((entry) => entry.pidNs === identity.pidNs && !seed.includes(entry)));
            }
        }
        return descend ? withDescendants(seed, processes) : seed;
    }

    function namespaceHolders(inode, field, processes, mounts) {
        const holders = [];
        for (const entry of processes) {
            if (entry[field] === inode) holders.push({ via: 'ns-link', pid: entry.pid });
            if (entry.fdNs.includes(inode)) holders.push({ via: 'fd-link', pid: entry.pid });
        }
        for (const mount of mounts) if (mount.fstype === 'nsfs' && mount.nsInode === inode) holders.push({ via: 'nsfs-mount', mountId: mount.mountId });
        return holders;
    }

    // Absence as the supervisor can see it right now.
    function prove(blocker) {
        const processes = view.listProcesses();
        const mounts = view.listMounts();
        const { kind } = blocker;
        if (PROCESS_KINDS.has(kind)) {
            const members = processMembers(blocker, processes, { descend: kind !== 'keeper' });
            const needsSandbox = blocker.identity === null && kind !== 'keeper';
            const sandbox = needsSandbox ? sandboxProcesses(blocker, processes) : [];
            if (sandbox === null) return { absent: false, holders: [{ via: 'sandbox-record-unavailable' }] };
            return { absent: members.length === 0 && sandbox.length === 0, holders: members.map((entry) => ({ pid: entry.pid })) };
        }
        if (kind === 'netns' || kind === 'mount') {
            const field = NAMESPACE_KINDS[kind];
            // An execution network is more than its namespace: the netns file, both veth ends and the nft table, all named from
            // the locator, must be gone too. The view answers for them (a view that knows nothing of them answers false).
            const objectsLeft = kind === 'netns' && view.exists?.('netns', blocker.locator) === true ? [{ via: 'locator' }] : [];
            if (blocker.identity === null) {
                // A namespace that was created and not yet committed has no recorded inode. It is held only by the sandbox supervisor
                // and its descendants, so it is absent when the sandbox supervisor's tree is, and not otherwise.
                const sandbox = sandboxProcesses(blocker, processes);
                if (sandbox === null) return { absent: false, holders: [{ via: 'sandbox-record-unavailable' }] };
                const sandboxTree = withDescendants(sandbox, processes);
                return { absent: sandboxTree.length === 0 && objectsLeft.length === 0, holders: [...sandboxTree.map((entry) => ({ pid: entry.pid })), ...objectsLeft] };
            }
            const inode = blocker.identity[field];
            const holders = namespaceHolders(inode, field, processes, mounts);
            if (kind === 'mount') {
                const mountsLeft = mounts.filter((mount) => mount.mountId === blocker.identity.mountId && mount.mountpoint === blocker.identity.mountpoint);
                for (const mount of mountsLeft) holders.push({ via: 'mountinfo', mountId: mount.mountId });
            }
            holders.push(...objectsLeft);
            return { absent: holders.length === 0, holders };
        }
        if (kind === 'gui-view') {
            const left = mounts.filter((mount) => mount.mountpoint === blocker.locator.mountpoint);
            return { absent: left.length === 0, holders: left.map((mount) => ({ via: 'mountinfo', mountId: mount.mountId })) };
        }
        if (LOCATOR_KINDS.has(kind)) {
            const present = view.exists(kind, blocker.locator);
            return { absent: !present, holders: present ? [{ via: 'locator' }] : [] };
        }
        // A kind this walker does not know cannot be proven absent.
        return { absent: false, holders: [{ via: 'unknown-kind' }] };
    }

    // Kills and removes what is found after re-checking identity (the view acts only on a matching pid and start time).
    async function force(blocker) {
        const { kind } = blocker;
        if (PROCESS_KINDS.has(kind)) {
            for (const entry of processMembers(blocker, view.listProcesses())) view.kill({ pid: entry.pid, startTime: entry.startTime });
            return;
        }
        if (kind === 'mount' && blocker.identity !== null) {
            for (const mount of view.listMounts()) {
                if (mount.mountId === blocker.identity.mountId && mount.mountpoint === blocker.identity.mountpoint) view.unmount({ mountId: mount.mountId, mountpoint: mount.mountpoint });
            }
            return;
        }
        if (kind === 'gui-view') {
            for (const mount of view.listMounts()) if (mount.mountpoint === blocker.locator.mountpoint) view.unmount({ mountId: mount.mountId, mountpoint: mount.mountpoint });
            return;
        }
        // An execution network (netns, veth, nft table) is named from the netns locator alone, so a leftover is removed by
        // that locator whether or not the identity was committed (the namespace inode is held by the /run/netns mount). A
        // removal that leaves something behind is not ignored: prove() asks the view again, finds it, and the walk ends quarantined.
        if (kind === 'netns') { if (view.exists?.('netns', blocker.locator) === true) view.remove?.('netns', blocker.locator); return; }
        if (LOCATOR_KINDS.has(kind) && view.exists(kind, blocker.locator)) view.remove(kind, blocker.locator);
    }

    // Force, then wait for proof of absence until the release deadline. `released` on proof, `quarantined` otherwise.
    // The deadline runs from `since` (default: now). The end path passes the start of the step, so one step waits at most
    // one deadline however many of its resources cannot be proven.
    async function walk(blocker, options = {}) {
        const deadline = (options.since ?? clock.now()) + releaseDeadlineMs;
        for (;;) {
            await force(blocker);
            if (prove(blocker).absent) return RELEASED;
            if (clock.now() >= deadline) return QUARANTINED;
            await clock.sleep(pollMs);
        }
    }

    // One pass, no waiting: `released` if absence can be proven now after forcing, otherwise null (undecided, not
    // quarantined). Used where the caller can leave the blocker unsettled for the end path.
    async function attempt(blocker) {
        await force(blocker);
        return prove(blocker).absent ? RELEASED : null;
    }

    return { prove, force, walk, attempt };
}

// Generation recovery: roll the generation, walk every unsettled blocker of the prior generation in dependency order,
// record each outcome through the S1 library (which publishes an attempt's result when its last blocker settles), and
// complete the recovery. `state` is an S1 WorkerState handle bound to the generation being replaced.
export async function recoverGeneration({ state, walker }) {
    const started = state.beginGenerationRecovery(state.generationId);
    const outcomes = [];
    const pending = walkOrder(started.unsettledBlockers);
    for (const blocker of pending) {
        const outcome = await walker.walk(blocker);
        state.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome });
        outcomes.push({ resourceId: blocker.resourceId, kind: blocker.kind, outcome });
    }
    const completed = state.completeGenerationRecovery(started.generationId);
    return { generationId: started.generationId, priorGenerationId: started.priorGenerationId, outcomes, completed };
}
