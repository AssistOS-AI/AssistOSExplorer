// S1 source preparation only. Native held-reference capture is not implemented. Pure evidence checks below are
// model checks, not Linux qualification; registered collectors always fail closed until that integration is reviewed.
import { canonicalJson, sha256 } from '../lib/record.mjs';

export const TARGETING_VERSION = 'g1-targeting/2';
export const COVERAGE_VERSION = 'g1-s1-coverage/1';
export const OBSERVER_CONTRACT = 'g1-held-observer-model/1';

function freeze(value) {
    if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
}

export const TARGET_TABLE = freeze({
    keeperMeasurements: ['keeper'],
    identityCapabilities: ['exec-child'],
    noNewPrivs: ['exec-child'],
    seccompStatus: ['exec-child'],
    filesystemView: ['exec-child'],
    inheritedDescriptors: ['exec-child'],
    descriptorCustody: ['keeper', 'namespace-member'],
    publicIdentity: ['anchor'],
    terminationAbsence: ['anchor', 'namespace-member'],
});

const domains = ['endpoint', 'orchestration', 'workload'];
const perDomain = (checks, roles = domains) => roles.flatMap((role) => checks.map((check) => `${role}.${check}`));
const later = (id, stage) => ({ id, stage });
const variants = [later('grant-variants', 'S4'), later('egress-variants', 'S3'), later('terminal-variants', 'S2')];
const row = (required, deferred = []) => ({ required, deferred });

// The A1 inventory is frozen independently of reported observations. A missing deferred item is an error, not an
// opportunity to silently narrow a row. Compound case names retain the original G4 observable bundle and controls.
export const S1_MATRIX = freeze({
    'G1-01': row(['keeper.identity-capabilities-limits', ...perDomain(['identity-capabilities'])], [later('file-server.identity-capabilities-limits', 'S4')]),
    'G1-02': row(['keeper.status-recorded', ...perDomain(['no-new-privs'])], [later('file-server.no-new-privs', 'S4')]),
    'G1-03': row(['endpoint.nsopen-userns', ...perDomain(['unshare-user', 'clone-newuser', 'clone3-newuser'], ['orchestration', 'workload']), 'denial-layer-and-mechanism'],
        [later('file-server.userns-denial', 'S4')]),
    'G1-04': row(perDomain(['process-inventory', 'foreign-signal', 'foreign-ptrace', 'foreign-proc-root'], ['orchestration', 'workload']), variants),
    'G1-05': row([...perDomain(['mount-and-root-view', 'forbidden-paths']), 'workload.home-resolution'], variants),
    'G1-06': row(['abstract-socket-isolation', 'sysv-shared-memory-isolation', 'posix-shared-memory-isolation'], variants),
    'G1-07': row([...perDomain(['loopback-only', 'supervisor-sentinel-denied', 'box-8080-denied', 'box-8081-denied']), 'workload.own-loopback-service'], variants),
    'G1-08': row([...perDomain(['seccomp-status', 'keyctl', 'add-key', 'request-key']),
        ...perDomain(['ptrace', 'process-vm-readv', 'process-vm-writev', 'pidfd-getfd'], ['endpoint', 'orchestration'])], variants),
    'G1-09': row([...perDomain(['inherited-descriptors']), 'keeper-and-all-namespace-members.custody', 'monitor-root-authority-denied', 'linux-scm-rights-plain-read'], variants),
    'G1-10': row(['provider-hello', 'stdio-bidirectional-bytes', 'pre-transfer-payload-half-close', 'loopback-service-bidirectional-bytes', 'ala-sent-handle-isolated-failure'], variants),
    'G1-11': row(['image-node-symmetric-tap', 'image-node-raw-wire-conformance', 'confined-channel-counterpart',
        'read-one-byte-negative', 'non-socket-fd3-negative', 'handle-with-message-negative']),
    'G1-12': row([], [later('entire-pty-probe', 'S2')]),
    'G1-13': row(['unterminated-64mib', 'queue-flood', 'message-with-handle', 'sendmsg-flood', 'peer-never-reads', 'supervisor-memory-and-fd-bounds', 'neighbor-continuity']),
    'G1-14': row(['oversize-stdout', 'stdout-rate-stall', 'stderr-ring-bound', 'stdin-stall', 'supervisor-memory-and-fd-bounds', 'neighbor-continuity']),
    'G1-15': row(['supervisor', 'keeper', 'endpoint'].flatMap((target) => ['after-reserve', 'after-create', 'after-commit', 'after-release'].map((point) => `${target}.${point}`))
        .concat(['non-commit-first-byte', 'duplicate-commit-rpc']), [later('grant-crash-extensions', 'S4'), later('file-server-crash-extensions', 'S4')]),
    'G1-16': row(['supervisor-loss', 'keeper-loss', 'endpoint-loss'], [later('grant-death-extensions', 'S4'), later('file-server-death-extensions', 'S4')]),
    'G1-17': row(['main-thread-parent-death', 'worker-thread-parent-death-observation'], [later('grant-thread-extensions', 'S4'), later('file-server-thread-extensions', 'S4')]),
    'G1-18': row([], [later('entire-cleanup-end-paths', 'S2')]),
    'G1-19': row([], [later('entire-two-robot-concurrency', 'S2')]),
    'G1-20': row([], [later('entire-probe', 'S3')]),
    'G1-21': row([], [later('entire-probe', 'S3')]),
    'G1-22': row([], [later('entire-probe', 'S3')]),
    'G1-23': row([], [later('entire-probe', 'S4')]),
    'G1-24': row([], [later('entire-probe', 'S4')]),
    'G1-25': row([], [later('entire-probe', 'S4')]),
    'G1-26': row([], [later('entire-probe', 'S4')]),
    'G1-27': row(['workload.tool-immutability', 'orchestration.ala-source-immutability'], [later('terminal.tool-immutability', 'S2')]),
    'G1-28': row([], [later('entire-orchestration-separation-extras', 'S2')]),
    'G1-29': row([], [later('entire-probe', 'S2')]),
});

export const S1_REQUIRED = Object.freeze(Object.keys(S1_MATRIX).filter((id) => S1_MATRIX[id].required.length > 0));

export function pendingCoverage(probeId) {
    const definition = S1_MATRIX[probeId];
    if (!definition) throw new TypeError('Unknown first-checkpoint probe');
    return [
        ...definition.required.map((id) => ({ id, scope: 'S1-required', deferredTo: null, status: 'NOT-RUN', reason: 'Native capture and probe not implemented' })),
        ...definition.deferred.map(({ id, stage }) => ({ id, scope: 'deferred', deferredTo: stage, status: 'NOT-RUN', reason: `Deferred to ${stage} by A1` })),
    ];
}

// Structural coverage is separate from behavior verification. This skeleton accepts no claimed PASS, even with a
// complete set of fields. Later integration must compute each implemented subcheck from its evidence and control.
export function checkCoverage(probeId, coverage) {
    const expected = pendingCoverage(probeId);
    const problems = [];
    if (!Array.isArray(coverage)) return { ok: false, qualifying: false, problems: ['subcheckCoverage missing'] };
    const byId = new Map();
    for (const entry of coverage) {
        if (!entry || typeof entry.id !== 'string' || byId.has(entry.id)) { problems.push('invalid or duplicate subcheck'); continue; }
        byId.set(entry.id, entry);
    }
    for (const entry of expected) {
        const reported = byId.get(entry.id);
        if (!reported) { problems.push(`missing ${entry.scope} subcheck ${entry.id}`); continue; }
        if (reported.scope !== entry.scope || reported.deferredTo !== entry.deferredTo) problems.push(`scope changed for ${entry.id}`);
        if (entry.scope === 'deferred' && reported.status !== 'NOT-RUN') problems.push(`deferred ${entry.id} must remain NOT-RUN`);
        if (entry.scope === 'S1-required' && !['NOT-RUN', 'BLOCKED', 'FAIL'].includes(reported.status)) problems.push(`unimplemented ${entry.id} cannot claim ${reported.status}`);
    }
    for (const id of byId.keys()) if (!expected.some((entry) => entry.id === id)) problems.push(`unexpected subcheck ${id}`);
    return { ok: problems.length === 0, qualifying: false, problems };
}

export function capturePrerequisites(inputs) {
    const missing = [];
    for (const name of ['observerArtifactSha256', 'runtimePolicySha256', 'imageSha256', 'nodeSha256', 'nativeSha256']) {
        if (!/^[0-9a-f]{64}$/u.test(inputs?.[name] ?? '')) missing.push(name);
    }
    if (inputs?.targetingVersion !== TARGETING_VERSION) missing.push('targetingVersion');
    return { ready: false, missing, reason: missing.length ? `Missing pinned capture inputs: ${missing.join(', ')}` : 'Native held-reference observer capture is not implemented' };
}

export function createFirstCheckpointProbe(probeId) {
    if (!S1_REQUIRED.includes(probeId)) throw new TypeError('Probe is deferred outside S1');
    return Object.freeze({
        id: probeId,
        planRefs: ['first-g1-runtime-amendment-a1 A1 S1 coverage', 'first-g1-runtime-amendment-a2 A2 targeting'],
        rows: [],
        expected: `S1-required subset only for ${probeId}: ${S1_MATRIX[probeId].required.join(', ')}. Deferred subchecks remain NOT-RUN; this is not full G1 completion.`,
        async collect(ctx = {}) {
            const prerequisites = capturePrerequisites(ctx.captureInputs);
            return {
                blocked: prerequisites.reason,
                observed: null,
                negativeControl: null,
                measurements: { targetingVersion: TARGETING_VERSION, coverageVersion: COVERAGE_VERSION, subcheckCoverage: pendingCoverage(probeId) },
            };
        },
        grade() {
            return { expectedMet: false, controlOppositeMet: false, notes: ['Runtime capture and full probe grading are not implemented; pure model checks cannot qualify S1'] };
        },
    });
}

const digest = (value) => sha256(canonicalJson(value));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const decimal = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value);
const pid = (value) => Number.isSafeInteger(value) && value > 0;
const fileIdentity = (value) => value && decimal(value.dev) && decimal(value.ino);
const processIdentity = (value) => value && pid(value.pid) && decimal(value.startTime) && decimal(value.pidNs);
const sameProcess = (a, b) => processIdentity(a) && processIdentity(b)
    && a.pid === b.pid && a.startTime === b.startTime && a.pidNs === b.pidNs;
const sameFile = (a, b) => fileIdentity(a) && fileIdentity(b) && a.dev === b.dev && a.ino === b.ino;
const sameChild = (a, b) => sameProcess(a, b) && a.ppid === b.ppid && sameFile(a.exe, b.exe);
const capFields = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'];
const verdict = (status, notes = []) => ({ verdict: status, qualifying: false, notes });
const failure = (reason) => Object.assign(new Error(reason), { verdict: 'FAIL' });
const blocked = (reason) => Object.assign(new Error(reason), { verdict: 'BLOCKED' });
const requireEvidence = (condition, reason) => { if (!condition) throw failure(reason); };

// PROPOSED MODEL CONTRACT, not an implemented native command or production API. Expected pins, anchor and role
// policy are supplied independently by the caller. Native integration must authenticate the actual binary, command,
// image and policy before accepting any transcript. These pure checks cannot authenticate caller-fabricated JSON.
//
// measurements retains the A2 fields and adds runId, bindingId, observerRecords and bindingEvidence (sequence refs).
// Every record has sequence/op/runId/bindingId/observerArtifactSha256/inputPins. Binding evidence references: anchorCheck,
// members, expectedExe, pidfd, procDirectory, revalidation, persisted. Snapshot evidence references before/read/after.
// Acquisition records name held refs; snapshot checks retain those same refs and the original child identity.
// Snapshot-read records bind the subject and digest of actual facts. No PID payload, argv or private native record
// selects a target. Records deliberately omit any replacement/rebind operation.
function validateBinding(measurements, expected) {
    if (!hash(expected?.observerArtifactSha256) || !hash(expected?.bwrapSha256) || !hash(expected?.runtimePolicySha256)
        || !hash(expected?.imageSha256) || !hash(expected?.nodeSha256) || !expected.policy) throw blocked('Caller-owned observer, image, Node and policy pins are required');
    requireEvidence(digest(expected.policy) === expected.runtimePolicySha256, 'Caller policy content does not match its pin');
    const inputPins = Object.fromEntries(['bwrapSha256', 'runtimePolicySha256', 'imageSha256', 'nodeSha256'].map((name) => [name, expected[name]]));
    requireEvidence(measurements?.targetingVersion === TARGETING_VERSION && measurements?.observerContract === OBSERVER_CONTRACT, 'Unknown targeting or observer model version');
    requireEvidence(measurements.observerArtifactSha256 === expected.observerArtifactSha256, 'Observer artifact pin mismatch');
    requireEvidence(/^[0-9a-f]{12}$/u.test(expected.runId ?? '') && measurements.runId === expected.runId, 'Observer run mismatch');
    requireEvidence(typeof measurements.bindingId === 'string' && measurements.bindingId.length > 0, 'Missing immutable binding id');
    const topology = measurements.topology;
    const binding = measurements.execBinding;
    requireEvidence(topology?.bwrapSha256 === expected.bwrapSha256, 'Bubblewrap pin mismatch');
    requireEvidence(topology.expectedShape === 'anchor-and-one-direct-exec-child' && topology.matched === true, 'Required quiet topology was not observed');
    requireEvidence(sameProcess(topology.anchor, expected.anchor), 'Committed anchor identity mismatch');
    requireEvidence(binding?.method === 'independent-proc-direct-child/1' && domains.includes(expected.role) && binding.role === expected.role, 'Independent role binding required');
    if (binding.pidfdHeld !== true || binding.procDirectoryHeld !== true) throw blocked('Observer lacks held pidfd/proc-directory references');
    requireEvidence(binding.validatedBeforeUnpark === true, 'Binding was not validated before unpark');
    requireEvidence(Array.isArray(topology.membersBeforeUnpark) && topology.membersBeforeUnpark.length === 2, 'Quiet namespace must contain exactly anchor and one child');
    const members = topology.membersBeforeUnpark;
    const anchors = members.filter((member) => sameProcess(member, expected.anchor));
    const children = members.filter((member) => member.pid !== expected.anchor.pid && member.ppid === expected.anchor.pid && member.pidNs === expected.anchor.pidNs);
    requireEvidence(anchors.length === 1 && children.length === 1, 'No unique direct exec child');
    const child = children[0];
    requireEvidence(sameProcess(binding, child) && binding.ppid === child.ppid && binding.pid !== expected.anchor.pid, 'Bound process is not the independent direct child');
    requireEvidence(fileIdentity(expected.expectedExe) && hash(expected.expectedExe.sha256)
        && same(binding.expectedExe, expected.expectedExe) && sameFile(binding.observedExe, expected.expectedExe)
        && sameFile(child.exe, expected.expectedExe), 'Expected ELF identity mismatch');
    requireEvidence(sameFile(anchors[0].exe, expected.policy.executables?.monitor), 'Anchor monitor image identity mismatch');

    const allowedOps = new Set(['anchor-check', 'namespace-enumeration', 'expected-exe-open', 'pidfd-open', 'proc-directory-open',
        'binding-check', 'binding-persisted', 'unpark', 'snapshot-check', 'snapshot-read', 'namespace-inventory']);
    const records = measurements.observerRecords;
    requireEvidence(Array.isArray(records) && records.length > 0, 'Supporting observer records missing');
    const bySequence = new Map();
    records.forEach((record, index) => {
        requireEvidence(record?.sequence === index + 1 && allowedOps.has(record.op), 'Invalid, repeated, lost or replacement observer sequence');
        requireEvidence(record.observerArtifactSha256 === expected.observerArtifactSha256 && record.runId === expected.runId
            && record.bindingId === measurements.bindingId, 'Observer record provenance differs');
        requireEvidence(same(record.inputPins, inputPins), 'Observer record input pins differ');
        bySequence.set(record.sequence, record);
    });
    const evidence = measurements.bindingEvidence;
    const read = (sequence, op) => {
        const record = bySequence.get(sequence);
        requireEvidence(record?.op === op, `Missing supporting ${op} record`);
        return record;
    };
    const anchor = read(evidence?.anchorCheck, 'anchor-check');
    const enumerated = read(evidence?.members, 'namespace-enumeration');
    const executable = read(evidence?.expectedExe, 'expected-exe-open');
    const heldPidfd = read(evidence?.pidfd, 'pidfd-open');
    const heldProc = read(evidence?.procDirectory, 'proc-directory-open');
    const revalidation = read(evidence?.revalidation, 'binding-check');
    const persisted = read(evidence?.persisted, 'binding-persisted');
    const ordered = [anchor, enumerated, executable, heldPidfd, heldProc, revalidation, persisted];
    requireEvidence(ordered.every((entry, index) => index === 0 || entry.sequence > ordered[index - 1].sequence), 'Binding acquisition order invalid');
    for (const entry of ordered) requireEvidence(records.filter((record) => record.op === entry.op).length === 1, 'Binding must never be acquired again');
    requireEvidence(sameProcess(anchor.subject, expected.anchor) && anchor.alive === true, 'Anchor independent revalidation failed');
    requireEvidence(same(enumerated.members, members), 'Quiet topology has no matching enumeration record');
    requireEvidence(same(executable.identity, expected.expectedExe) && typeof executable.ref === 'string' && executable.ref.length > 0
        && Number.isSafeInteger(executable.fd) && executable.fd >= 0 && executable.fileType === 'regular', 'Expected ELF was not independently opened');
    for (const held of [heldPidfd, heldProc]) requireEvidence(sameChild(held.subject, child) && Number.isSafeInteger(held.fd)
        && held.fd >= 0 && typeof held.ref === 'string' && held.ref.length > 0, 'Held child acquisition failed');
    requireEvidence(heldPidfd.ref !== heldProc.ref && heldPidfd.fd !== heldProc.fd, 'Distinct held references are required');
    requireEvidence(fileIdentity(heldProc.directory), 'Proc-directory acquisition has no file identity');
    const checkChild = (record) => requireEvidence(sameChild(record.binding, child) && record.alive === true
        && record.pidfdRef === heldPidfd.ref && record.procDirectoryRef === heldProc.ref, 'Held child binding changed or vanished; rebinding is forbidden');
    checkChild(revalidation);
    requireEvidence(persisted.bindingSha256 === digest(binding), 'Binding persistence record mismatch');
    for (const record of records.filter((entry) => entry.op === 'unpark')) requireEvidence(record.sequence > persisted.sequence, 'Fixture unparked before durable binding');
    // Latch the first contradictory observation of this held binding. Snapshot references may not skip a loss and
    // resume from later favorable records. Loss after a completed observation does not invalidate that earlier fact.
    // A member's subject is distinct from record.binding, which always describes the selected exec child.
    let bindingLoss = null;
    for (const record of records) {
        try {
            if (['binding-check', 'snapshot-check', 'snapshot-read'].includes(record.op)) {
                requireEvidence(record.sequence > heldProc.sequence, 'Child observation predates held-reference acquisition');
            }
            if (record.op === 'binding-check' || record.op === 'snapshot-check') checkChild(record);
            if (record.op === 'snapshot-check' || record.op === 'snapshot-read') {
                if (record.target === 'exec-child' || record.subject?.pid === child.pid) {
                    requireEvidence(sameChild(record.subject, child), 'Selected child observation changed identity');
                }
            }
            if (record.op === 'namespace-inventory') requireEvidence(Array.isArray(record.members)
                && record.members.filter((member) => member.pid === child.pid).length === 1
                && record.members.some((member) => sameChild(member, child)), 'Selected child vanished from the namespace inventory');
        } catch (error) { bindingLoss = { sequence: record.sequence, error }; break; }
    }
    const validateThrough = (sequence) => {
        if (bindingLoss && bindingLoss.sequence <= sequence) throw bindingLoss.error;
    };
    return { child, anchor: anchors[0], read, checkChild, validateThrough, persisted, records, expected, measurements };
}

function snapshotFor(validated, target, subject) {
    const candidates = validated.measurements.snapshots?.filter((snapshot) => snapshot.target === target
        && snapshot.pid === subject.pid && snapshot.startTime === subject.startTime) ?? [];
    requireEvidence(candidates.length === 1, `Missing or ambiguous ${target} snapshot for the bound identity`);
    const snapshot = candidates[0];
    requireEvidence(snapshot.bindingValidBefore === true && snapshot.bindingValidAfter === true, 'Snapshot reports a lost binding');
    const before = validated.read(snapshot.evidence?.before, 'snapshot-check');
    const read = validated.read(snapshot.evidence?.read, 'snapshot-read');
    const after = validated.read(snapshot.evidence?.after, 'snapshot-check');
    requireEvidence(validated.persisted.sequence < before.sequence && before.sequence < read.sequence && read.sequence < after.sequence, 'Snapshot order invalid');
    for (const record of [before, read, after]) {
        requireEvidence(record.target === target && sameChild(record.subject, subject), 'Snapshot target identity mismatch');
    }
    validated.checkChild(before);
    validated.checkChild(after);
    validated.validateThrough(after.sequence);
    requireEvidence(read.factsSha256 === digest(snapshot.facts), 'Snapshot facts lack matching observer evidence');
    return { snapshot, facts: snapshot.facts, before: before.sequence, after: after.sequence };
}

function mapsValid(value) {
    return Array.isArray(value) && value.length > 0 && value.every((line) => Array.isArray(line) && line.length === 3
        && line.every((part) => Number.isSafeInteger(part) && part >= 0) && line[2] > 0);
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const pathName = (value) => nonempty(value) && value.startsWith('/') && !value.includes('\0');
const capsValid = (facts) => object(facts?.status) && capFields.every((field) => typeof facts.status[field] === 'string' && /^[0-9a-fA-F]{16}$/u.test(facts.status[field]));
const mountsValid = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => object(entry)
    && pathName(entry.target) && nonempty(entry.sourceType) && typeof entry.readOnly === 'boolean')
    && new Set(value.map((entry) => entry.target)).size === value.length;
const descriptorsValid = (value) => Array.isArray(value) && value.every((entry) => object(entry)
    && Number.isSafeInteger(entry.fd) && entry.fd >= 0 && nonempty(entry.kind) && ['inherited', 'runtime'].includes(entry.origin)
    && (entry.authority === null || nonempty(entry.authority))) && new Set(value.map((entry) => entry.fd)).size === value.length;

// Shape/completeness is independent of policy truth. Missing or malformed facts are an invalid measurement; only
// a complete, determinate observation may be compared with the policy or count as an opposite negative control.
function validateFacts(facts, assertion, expected) {
    requireEvidence(object(facts), 'Assertion facts missing or malformed');
    switch (assertion) {
        case 'identityCapabilities':
            requireEvidence(capsValid(facts) && mapsValid(facts.uidMap) && mapsValid(facts.gidMap)
                && mapsValid(expected.policy.uidMap) && mapsValid(expected.policy.gidMap), 'Capabilities and identity maps must be complete');
            break;
        case 'noNewPrivs':
            requireEvidence(object(facts.status) && (facts.status.NoNewPrivs === 0 || facts.status.NoNewPrivs === 1), 'NoNewPrivs observation must be 0 or 1');
            break;
        case 'seccompStatus':
            requireEvidence(object(facts.status) && [0, 1, 2].includes(facts.status.Seccomp), 'Seccomp observation must be 0, 1 or 2');
            break;
        case 'filesystemView': {
            const paths = expected.policy.forbiddenPaths?.[expected.role];
            requireEvidence(mountsValid(facts.mounts) && mountsValid(expected.policy.mounts?.[expected.role]), 'Mount inventory must be complete and determinate');
            requireEvidence(Array.isArray(paths) && paths.length > 0 && paths.every(pathName) && new Set(paths).size === paths.length
                && Array.isArray(facts.pathAttempts) && facts.pathAttempts.length === paths.length
                && paths.every((path) => facts.pathAttempts.filter((entry) => entry?.path === path).length === 1)
                && facts.pathAttempts.every((entry) => object(entry) && Number.isSafeInteger(entry.rc)
                    && ((entry.rc >= 0 && entry.errno === null) || (entry.rc === -1 && /^[A-Z][A-Z0-9_]+$/u.test(entry.errno ?? '')))),
            'Required path attempts must each contain a determinate result');
            break;
        }
        case 'keeperMeasurements': {
            const limit = (value) => value === 'unlimited' || (Number.isSafeInteger(value) && value >= 0);
            requireEvidence(capsValid(facts) && mapsValid(facts.uidMap) && mapsValid(facts.gidMap)
                && object(facts.limits) && Object.keys(facts.limits).length > 0
                && Object.values(facts.limits).every((entry) => object(entry) && limit(entry.soft) && limit(entry.hard))
                && (facts.cgroupSubtree === null || pathName(facts.cgroupSubtree)), 'Keeper measurements must be complete');
            break;
        }
        case 'publicIdentity': requireEvidence(processIdentity(facts.identity), 'Public identity observation is incomplete'); break;
        case 'inheritedDescriptors': break; // The shared descriptor checker validates both facts and policy below.
        default: throw failure('Assertion is not implemented in this pure model');
    }
}

function descriptorsMatch(facts, role, policy) {
    const allowed = policy.descriptorAllowances?.[role];
    requireEvidence(descriptorsValid(allowed) && descriptorsValid(facts?.descriptors), 'Descriptor inventories must be complete and determinate');
    return facts.descriptors.every((descriptor) => {
        if (descriptor.origin === 'runtime' && ['eventpoll', 'eventfd', 'timerfd'].includes(descriptor.kind)
            && policy.runtimeDescriptorKinds?.includes(descriptor.kind) && descriptor.authority === null) return true;
        return allowed.some((entry) => same(entry, descriptor));
    }) && allowed.every((entry) => facts.descriptors.some((descriptor) => same(entry, descriptor)));
}

function custodyFacts(validated) {
    const inventory = validated.measurements.custodyInventory;
    const before = validated.read(inventory?.before, 'namespace-inventory');
    const after = validated.read(inventory?.after, 'namespace-inventory');
    validated.validateThrough(after.sequence);
    requireEvidence(Array.isArray(inventory.members) && inventory.members.length >= 2 && same(before.members, inventory.members)
        && same(after.members, inventory.members), 'Complete stable namespace member inventories are required');
    requireEvidence(before.sequence > validated.persisted.sequence && after.sequence > before.sequence, 'Custody inventory order invalid');
    const members = inventory.members;
    requireEvidence(new Set(members.map((member) => member.pid)).size === members.length
        && members.every((member) => member.pidNs === validated.child.pidNs && processIdentity(member)), 'Invalid namespace member identities');
    requireEvidence(members.some((member) => sameChild(member, validated.anchor)) && members.some((member) => sameChild(member, validated.child)), 'Custody inventory omits anchor or exec child');
    const memberSnapshots = validated.measurements.snapshots?.filter((entry) => entry.target === 'namespace-member') ?? [];
    requireEvidence(memberSnapshots.length === members.length && memberSnapshots.every((entry) => members.some((member) =>
        member.pid === entry.pid && member.startTime === entry.startTime)), 'Custody snapshots and member inventory differ');
    const keeper = validated.expected.keeper;
    requireEvidence(processIdentity(keeper) && fileIdentity(keeper.exe), 'Independent keeper identity required');
    const all = [{ target: 'keeper', member: { ...keeper, role: 'keeper' } }, ...members.map((member) => ({ target: 'namespace-member', member }))];
    let policyMet = true;
    for (const { target, member } of all) {
        const executable = validated.expected.policy.executables?.[member.role];
        requireEvidence(fileIdentity(executable) && sameFile(executable, member.exe), 'Unknown or mismatched namespace member role');
        if (sameProcess(member, validated.anchor)) requireEvidence(member.role === 'monitor', 'Anchor must retain its monitor allowance');
        if (sameProcess(member, validated.child)) requireEvidence(member.role === validated.expected.role, 'Exec child role mismatch');
        const sample = snapshotFor(validated, target, member);
        requireEvidence(sample.before > before.sequence && sample.after < after.sequence, 'Member snapshot outside inventory interval');
        if (!descriptorsMatch(sample.facts, member.role, validated.expected.policy)) policyMet = false;
    }
    return policyMet;
}

function gradeFacts(validated, assertion) {
    const { expected } = validated;
    if (assertion === 'descriptorCustody') return custodyFacts(validated);
    const target = TARGET_TABLE[assertion]?.[0];
    requireEvidence(target && target !== 'namespace-member', 'Assertion is not implemented in this pure model');
    const subject = target === 'exec-child' ? validated.child : target === 'anchor' ? validated.anchor : expected.keeper;
    requireEvidence(processIdentity(subject), 'Required target identity missing');
    const { facts } = snapshotFor(validated, target, subject);
    validateFacts(facts, assertion, expected);
    switch (assertion) {
        case 'identityCapabilities':
            return capFields.every((field) => facts.status[field] === '0000000000000000')
                && same(facts.uidMap, expected.policy.uidMap) && same(facts.gidMap, expected.policy.gidMap);
        case 'noNewPrivs': return facts?.status?.NoNewPrivs === 1;
        case 'seccompStatus': return facts?.status?.Seccomp === 2;
        case 'filesystemView':
            return same(facts.mounts, expected.policy.mounts[expected.role]) && expected.policy.forbiddenPaths[expected.role].every((path) =>
                    facts.pathAttempts.filter((entry) => entry.path === path && entry.rc === -1 && entry.errno === 'ENOENT').length === 1);
        case 'inheritedDescriptors': return descriptorsMatch(facts, expected.role, expected.policy);
        case 'keeperMeasurements':
            return facts.cgroupSubtree === null;
        case 'publicIdentity': return sameProcess(facts?.identity, expected.anchor);
        default: throw failure('Assertion is not implemented in this pure model');
    }
}

export function gradeTargetEvidence({ measurements, expected, assertion } = {}) {
    try {
        const validated = validateBinding(measurements, expected);
        return gradeFacts(validated, assertion) ? verdict('PASS') : verdict('FAIL', [`${assertion} facts violate the target policy`]);
    } catch (error) { return verdict(error.verdict ?? 'FAIL', [error.message]); }
}

// A negative control must have a valid independently held binding and supporting observations. A malformed transcript
// or lost target is not the opposite behavior. Only policy-violating facts with valid provenance count as a control.
export function gradeTargetPair({ measurements, expected, assertion, negativeControl } = {}) {
    const positive = gradeTargetEvidence({ measurements, expected, assertion });
    if (positive.verdict !== 'PASS') return positive;
    if (typeof negativeControl?.command !== 'string' || negativeControl.command.length === 0) return verdict('FAIL', ['Negative control command missing']);
    try {
        const control = validateBinding(negativeControl.measurements, negativeControl.expected);
        requireEvidence(negativeControl.expected.observerArtifactSha256 === expected.observerArtifactSha256, 'Negative control observer pin differs');
        requireEvidence(negativeControl.expected.runtimePolicySha256 === expected.runtimePolicySha256, 'Negative control policy differs');
        requireEvidence(negativeControl.expected.role === expected.role, 'Negative control role differs');
        if (gradeFacts(control, assertion)) return verdict('FAIL', ['Negative control did not expose the opposite facts']);
        return verdict('PASS', ['Synthetic/model evidence only; native capture remains unimplemented']);
    } catch (error) { return verdict('FAIL', [`Negative control evidence invalid: ${error.message}`]); }
}
