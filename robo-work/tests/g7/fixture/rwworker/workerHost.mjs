// rwworker: the proof-fixture worker host (slice P6b; decision B2: a worker host composed from production
// `robo-work/server/` modules inside a fixture worker image counts as the T2 worker image for proof-fixture G7; the
// packaged production worker agent stays a T3 deliverable).
//
// Production modules it composes, unchanged:
//   qualificationStore.mjs   the worker-owned trust anchor (record installed by tests/g7/tools/install-fixture-record.mjs)
//   availability.mjs         admission (`requireExecutionTarget`) and the admitted-binding revalidation before commit
//   contract.mjs             TargetBinding, canonical encoding and digests, receipt validation
//   receipts.mjs             receipt reconciliation and the three-way start classification
//   transportContract.mjs    every reply frame is re-validated (`validateTargetFrame`) and every minted ticket is
//                            checked (`validateHelperTicketClaims`) before it is presented
// The mailbox seam is the native worker-side peer (`rw-target-helper worker-peer --session`, decision B4); this host
// drives it over stdin/stdout and gives it the session key only on stdin.
//
// PROOF-FIXTURE departures (each recorded in the evidence): tickets come from `fixtureMinter.mjs` (no Router mint route
// and no per-incarnation secret delivery exist yet); the helper runs the fixture launcher, which launches no keeper (G1);
// the worker's own durable state is this file-backed record, not the S1 worker store; facts that Ploinky does not yet
// produce (source protection, attestation digests, HOME compatibility) are fixture-supplied by the operator.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { requireExecutionTarget } from '../../../../server/executionTarget/availability.mjs';
import {
    canonicalTargetJson, digestOf, parseCanonicalTargetJson, validateTargetBinding, validateTargetReceipt
} from '../../../../server/executionTarget/contract.mjs';
import { createQualificationStore } from '../../../../server/executionTarget/qualificationStore.mjs';
import { CONTRACT_ERROR_CODES } from '../../../../server/executionTarget/contract.mjs';
import { JOURNAL_ERROR_CODES } from '../../../../server/executionTarget/journalModel.mjs';
import { RECEIPT_ERROR_CODES, classifyTargetStartOutcome, reconcileTargetReceipt } from '../../../../server/executionTarget/receipts.mjs';
import { TRANSPORT_ERROR_CODES, validateHelperTicketClaims, validateTargetFrame } from '../../../../server/executionTarget/transportContract.mjs';
import { mintFixtureTicket } from './fixtureMinter.mjs';

const STATE_FILE = 'worker-state.json';
const STATE_BYTES = 4 * 1024 * 1024;
const LINE_TIMEOUT_MS = 40_000;
const RESOURCES_DIGEST_BYTES = 1 << 20;
// Execution-specific binding digests that this slice has no manifests for (input, channel, skill view, native config,
// grant policy): fixture-supplied, recorded in the evidence.
const FIXTURE_DIGEST_KEYS = Object.freeze(['grantPolicyDigest', 'inputManifestDigest', 'skillViewManifestDigest', 'nativeConfigProjectionDigest', 'channelManifestDigest']);

// A11.6: a code that came from the helper is printed or persisted only as a known enumerated spelling, else `refused`.
const KNOWN_CODES = new Set([...TRANSPORT_ERROR_CODES, ...JOURNAL_ERROR_CODES, ...CONTRACT_ERROR_CODES, ...RECEIPT_ERROR_CODES, 'keeper_unavailable', 'not_found']);
export function knownCode(code) {
    return typeof code === 'string' && KNOWN_CODES.has(code) ? code : 'refused';
}

// Local codes (the worker peer's own transport errors) are kept only when they are plain identifiers.
function localCode(code) {
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'refused';
}

function canonical(value, maxBytes = 64 * 1024) {
    const result = canonicalTargetJson(value, { maxBytes });
    if (!result.ok) throw new Error(`canonical encoding refused: ${result.error.code}`);
    return result.value;
}

function randomId(random) {
    return Buffer.from(random(16)).toString('base64url');
}

function fail(stage, code) {
    return { ok: false, stage, code };
}

// One `worker-peer --session` child: canonical JSON lines both ways.
class PeerProcess {
    constructor(command, args) {
        this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.queue = [];
        this.waiters = [];
        this.closed = false;
        this.stderr = '';
        this.exit = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
        this.child.stderr.on('data', (chunk) => { if (this.stderr.length < 65536) this.stderr += chunk.toString('utf8'); });
        const lines = readline.createInterface({ input: this.child.stdout });
        lines.on('line', (line) => this.push(line));
        lines.on('close', () => { this.closed = true; this.flush(); });
        this.child.stdin.on('error', () => {});
    }

    push(line) {
        this.queue.push(line);
        this.flush();
    }

    flush() {
        while (this.waiters.length > 0 && (this.queue.length > 0 || this.closed)) {
            const waiter = this.waiters.shift();
            waiter(this.queue.length > 0 ? this.queue.shift() : null);
        }
    }

    // The next stdout line as an object; null when the peer closed its output or the wait timed out.
    next(timeoutMs = LINE_TIMEOUT_MS) {
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
            this.waiters.push((line) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (line === null) return resolve(null);
                const parsed = parseCanonicalTargetJson(line, { maxBytes: 8 * 1024 * 1024 });
                resolve(parsed.ok ? parsed.value : { event: 'error', code: 'peer_output_noncanonical' });
            });
            this.flush();
        });
    }

    send(value) {
        this.child.stdin.write(`${canonical(value, 8 * 1024 * 1024)}\n`);
    }

    async close() {
        if (this.child.exitCode === null && !this.child.stdin.destroyed) this.child.stdin.end();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
        const code = await this.exit;
        clearTimeout(timer);
        return code;
    }
}

// `options`:
//   stateDir        private directory for the worker's durable fixture state (created 0700)
//   mailbox         the target helper's mailbox socket path as seen by this worker
//   peerCommand     the rw-target-helper executable (fixture build not required on the worker side)
//   ticketKey       {kid, secret} from fixtureMinter.loadFixtureTicketKey()
//   qualification   {root, uid, forbiddenRoots}: the worker-owned qualification store
//   now, random     injectable clock and randomness
export function createWorkerHost({ stateDir, mailbox, peerCommand, ticketKey, qualification, now = Date.now, random = crypto.randomBytes } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof mailbox !== 'string' || typeof peerCommand !== 'string' || !ticketKey) {
        throw new TypeError('createWorkerHost: stateDir, mailbox, peerCommand and ticketKey are required');
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stateFile = path.join(stateDir, STATE_FILE);

    function load() {
        if (!fs.existsSync(stateFile)) return { version: 1, admission: null, binding: null, leaseId: null, leaseEpoch: null, leaseAttempt: null, operations: {}, history: [] };
        const stat = fs.lstatSync(stateFile);
        if (!stat.isFile() || stat.size > STATE_BYTES) throw new Error('worker state file is unsafe');
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }

    // temp file, fsync, rename, directory fsync.
    function save(state) {
        const temp = path.join(stateDir, `.${STATE_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
            fs.writeSync(fd, `${JSON.stringify(state, null, 1)}\n`);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, stateFile);
        const dir = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }

    function record(state, entry) {
        state.history.push({ atMs: now(), ...entry });
        save(state);
        return entry;
    }

    function openStore() {
        const opened = createQualificationStore({ fs, root: qualification.root, uid: qualification.uid, forbiddenRoots: qualification.forbiddenRoots ?? [] });
        if (!opened.ok) throw new Error(`qualification store refused: ${opened.error.code}`);
        return opened.value;
    }

    function factsWith(facts, admittedBinding) {
        const store = openStore();
        const qualifications = store.facts();
        if (!qualifications.ok) throw new Error(`qualification facts refused: ${qualifications.error.code}`);
        return { ...facts, qualifications: qualifications.value, admittedBinding };
    }

    function operationKey(state, operationId) {
        const binding = state.binding;
        return {
            workspaceId: binding.scope.workspaceId, workerGeneration: binding.scope.workerGeneration, executionId: binding.executionId,
            attemptId: binding.attemptId, operationId
        };
    }

    function expectedFor(state, op) {
        return {
            key: operationKey(state, op.operationId), targetBindingDigest: digestOf(state.binding), reservationId: op.reservationId,
            requestDigest: op.requestDigest, journalStoreIdentity: state.binding.journalStoreIdentity, leaseId: state.leaseId,
            lastReceiptSequence: op.lastReceiptSequence
        };
    }

    // Admission from trusted facts (live and fixture-supplied, see the module header) and the qualification store; on
    // success the execution is counted and the TargetBinding recorded.
    function admit({ selection, facts, operationId, fixtureDigests }) {
        const state = load();
        if (state.binding !== null) return record(state, fail('admit', 'already_admitted'));
        const decision = requireExecutionTarget(selection, factsWith(facts, null));
        if (!decision.ok) return record(state, { ...fail('admit', decision.error.code), step: 'admit' });
        const store = openStore();
        const found = store.get(decision.value.ref);
        if (!found.ok) return record(state, { ...fail('admit', found.error.code), step: 'admit' });
        const qualificationRecord = found.value.record;
        const counted = store.consumeExecution(decision.value.ref, operationId);
        if (!counted.ok) return record(state, { ...fail('admit', counted.error.code), step: 'admit' });
        const entry = facts.entries.find((candidate) => candidate.ref === decision.value.ref);
        const worker = facts.current.worker;
        const sourceRecord = facts.sourceState.record;
        const binding = {
            version: 1,
            scope: {
                workspaceId: facts.live.workspaceId, boxIdentity: facts.live.boxIdentity, boxGeneration: facts.live.boxGeneration,
                workerPrincipal: worker.principal, workerRuntimeInstanceId: worker.runtimeInstanceId, workerEnableGeneration: worker.enableGeneration,
                workerGeneration: worker.generation, agentPrincipal: entry.principal, containerId: entry.containerId,
                runtimeInstanceId: entry.runtimeInstanceId, enableGeneration: entry.enableGeneration, helperIncarnation: entry.helperIncarnation
            },
            source: {
                repositorySourceMode: facts.sourceState.repositorySourceMode, sourceRepositoryIdentity: facts.sourceState.repositoryIdentity,
                sourceRevision: facts.sourceState.revision, sourceProtectionEpoch: sourceRecord.sourceProtectionEpoch,
                sourceSelectionDigest: sourceRecord.sourceSelectionDigest, sourceClosureDigest: sourceRecord.sourceClosureDigest,
                sourceAcceptanceIdentity: sourceRecord.sourceAcceptanceIdentity
            },
            targetImageDigest: qualificationRecord.targetImageDigest, contractVersion: 1, journalStoreIdentity: facts.current.journalStoreIdentity,
            robotId: randomId(random), executionId: randomId(random), attemptId: randomId(random), configRevision: 1,
            helperExecutableDigest: qualificationRecord.helperExecutableDigest, contractDigest: qualificationRecord.contractDigest,
            inventoryDigest: qualificationRecord.inventoryDigest, profileDigest: qualificationRecord.profileDigest,
            limitsDigest: facts.current.limitsDigest, qualificationRecordDigest: decision.value.qualificationRecordDigest,
            effectiveSecurityDigest: qualificationRecord.effectiveSecurityDigest,
            ...Object.fromEntries(FIXTURE_DIGEST_KEYS.map((key) => [key, fixtureDigests[key]])),
            homeCompatibilityDigest: digestOf(qualificationRecord.homeCompatibility)
        };
        const checked = validateTargetBinding(binding);
        if (!checked.ok) return record(state, { ...fail('admit', `binding_${checked.error.code}`), step: 'admit' });
        state.binding = binding;
        state.admission = { selection, ref: decision.value.ref, principal: decision.value.principal, qualificationRecordDigest: decision.value.qualificationRecordDigest, operationId, executionsUsed: counted.value.used };
        state.leaseId = randomId(random);
        return record(state, { ok: true, step: 'admit', admission: state.admission, targetBindingDigest: digestOf(binding) });
    }

    // Revalidation of the admitted binding against current trusted facts (queued dispatch / final gate release).
    function revalidate(facts) {
        const state = load();
        if (state.binding === null) return fail('revalidate', 'not_admitted');
        const decision = requireExecutionTarget(state.admission.selection, factsWith(facts, state.binding));
        return record(state, decision.ok ? { ok: true, step: 'revalidate' } : { ...fail('revalidate', decision.error.code), step: 'revalidate' });
    }

    // A worker operation: one exact request body, so one request digest. A second label may reuse the operation ID of
    // another (`sameOperationAs`) only to exercise the conflicting-payload refusal.
    function defineOperation(label, { resources, sameOperationAs = null }) {
        const state = load();
        if (state.binding === null) throw new Error('not admitted');
        if (state.operations[label]) throw new Error(`operation ${label} exists`);
        const body = canonical({ version: 1, resources: [...resources].sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1)) }, 256 * 1024);
        // A target operation ID is the worker's own (distinct from the coordinator operation that was admitted).
        const operationId = sameOperationAs ? state.operations[sameOperationAs].operationId : randomId(random);
        state.operations[label] = {
            operationId, reservationId: sameOperationAs ? state.operations[sameOperationAs].reservationId : randomId(random), body,
            requestDigest: crypto.createHash('sha256').update(body, 'utf8').digest('hex'), lastReceiptSequence: 0, receipt: null, outcome: null
        };
        save(state);
        return { label, operationId, requestDigest: state.operations[label].requestDigest };
    }

    // `loseAccepted`: the PROOF-FIXTURE lost-`accepted` fault (the peer sends the bootstrap and closes without reading).
    async function openSession(state, op, { loseAccepted = false } = {}) {
        const peer = new PeerProcess(peerCommand, ['worker-peer', '--mailbox', mailbox, '--session']);
        const first = await peer.next();
        if (first === null || first.ok === false) {
            await peer.close();
            return { refusal: fail('connect', localCode(first?.error?.code ?? 'peer_silent')) };
        }
        const challenge = first.event === 'connected' ? await peer.next() : null;
        if (challenge === null || challenge.event !== 'challenge') {
            await peer.close();
            return { refusal: fail('challenge', localCode(challenge?.code ?? 'no_challenge')) };
        }
        // A11.2: request max(recorded attempt, last accepted) + 1, and record the attempt durably before the bootstrap.
        const previous = state.leaseEpoch;
        const highest = [state.leaseEpoch, state.leaseAttempt ?? null].filter((value) => value !== null)
            .reduce((left, right) => (left === null || BigInt(right) > BigInt(left) ? right : left), null);
        const epoch = highest === null ? '1' : String(BigInt(highest) + 1n);
        state.leaseAttempt = epoch;
        save(state);
        const minted = mintFixtureTicket({
            key: ticketKey, binding: state.binding, reservationId: op.reservationId, leaseId: state.leaseId, operationId: op.operationId,
            requestDigest: op.requestDigest, helperNonce: challenge.helperNonce, channelEpoch: epoch, previousChannelEpoch: previous, nowMs: now(),
            randomBytes: random
        });
        // The production validator must accept every ticket this stand-in mints (fresh replay map: nothing is consumed).
        const selfCheck = validateHelperTicketClaims(minted.ticket, {
            secret: ticketKey.secret, kid: ticketKey.kid, binding: state.binding,
            expected: { reservationId: op.reservationId, leaseId: state.leaseId, operationId: op.operationId, requestDigest: op.requestDigest, helperNonce: challenge.helperNonce },
            channel: { currentEpoch: previous, leaseState: 'active' }, challenge: { id: challenge.challengeId, issuedMonoMs: 0 }, nowMonoMs: 0,
            nowMs: now(), replay: new Map()
        });
        if (!selfCheck.ok) {
            await peer.close();
            return { refusal: fail('mint', selfCheck.error.code) };
        }
        if (loseAccepted) {
            peer.send({ op: 'bootstrap-drop', ticket: minted.ticket, sessionKey: minted.sessionKey.toString('base64url') });
            const sent = await peer.next();
            await peer.close();
            return { fault: { fault: 'accepted-lost', attemptedEpoch: epoch, peer: sent?.event === 'bootstrap-dropped' ? 'bootstrap-dropped' : 'unexpected' } };
        }
        peer.send({ op: 'bootstrap', ticket: minted.ticket, sessionKey: minted.sessionKey.toString('base64url') });
        const answer = await peer.next();
        if (answer === null || answer.event !== 'accepted') {
            await peer.close();
            // A helper refusal is reduced to a known spelling; a local peer error keeps its plain identifier.
            const code = answer?.event === 'refused' ? knownCode(answer.code) : localCode(answer?.code ?? 'no_answer');
            return { refusal: fail('bootstrap', code), challengeIncarnation: challenge.helperIncarnation };
        }
        state.leaseEpoch = epoch;
        save(state);
        return { peer, minted, epoch, receiveSequence: 1n, challengeIncarnation: challenge.helperIncarnation };
    }

    async function request(state, op, session, messageKind, body) {
        session.peer.send({ op: 'frame', messageKind, body });
        const line = await session.peer.next();
        if (line === null || line.event !== 'reply') return { transport: line?.code ?? 'peer_closed' };
        const bytes = Buffer.from(line.frame, 'base64url');
        const checked = validateTargetFrame(bytes, {
            direction: 'target-to-worker', sessionKey: session.minted.sessionKey, claimsCanonical: session.minted.claimsCanonical,
            binding: state.binding, expected: { leaseId: state.leaseId, reservationId: op.reservationId, operationId: op.operationId, requestDigest: op.requestDigest },
            channelEpoch: session.epoch, nextSequence: String(session.receiveSequence), leaseState: 'active',
            ancillary: { count: 0, truncated: false, wellFormed: true, onFirstByte: true }
        });
        if (!checked.ok) return { frameRefused: checked.error.code };
        session.receiveSequence += 1n;
        const text = bytes.subarray(checked.value.bodyOffset, checked.value.bodyOffset + checked.value.bodyLength).toString('utf8');
        if (text !== line.body || checked.value.header.messageKind !== line.messageKind) return { frameRefused: 'peer_report_mismatch' };
        const parsed = parseCanonicalTargetJson(text, { maxBytes: 256 * 1024 });
        if (!parsed.ok) return { frameRefused: parsed.error.code };
        return { kind: checked.value.header.messageKind, value: parsed.value, nodeValidated: true };
    }

    function adopt(op, receipt) {
        op.receipt = receipt;
        op.lastReceiptSequence = Math.max(op.lastReceiptSequence, receipt.receiptSequence);
    }

    // prepare (`drop: true`: the PROOF-FIXTURE lost-reply fault, the peer closes after sending without reading).
    async function prepare(label, { drop = false } = {}) {
        const state = load();
        const op = state.operations[label];
        const expected = expectedFor(state, op);
        const session = await openSession(state, op);
        if (session.refusal) return record(state, { step: 'prepare', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        if (drop) {
            session.peer.send({ op: 'drop', messageKind: 'prepare', body: op.body });
            const dropped = await session.peer.next();
            await session.peer.close();
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'transport', detail: 'reply-lost' } });
            op.outcome = outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`;
            return record(state, { ok: true, step: 'prepare', label, fault: 'lost-reply', peer: dropped?.event ?? null, classification: op.outcome });
        }
        const reply = await request(state, op, session, 'prepare', op.body);
        await session.peer.close();
        if (reply.kind === 'prepared') {
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'receipt', receipt: reply.value } });
            if (!outcome.ok) return record(state, { ...fail('prepare', outcome.error.code), step: 'prepare', label });
            adopt(op, reply.value);
            op.outcome = outcome.value.outcome;
            return record(state, { ok: true, step: 'prepare', label, classification: op.outcome, receipt: summary(reply.value), nodeValidated: reply.nodeValidated });
        }
        if (reply.kind === 'failure') {
            // An authenticated refusal without journal absence evidence is not proof that nothing was created.
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'refused', code: knownCode(reply.value.code) } });
            op.outcome = outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`;
            return record(state, { ok: false, step: 'prepare', label, stage: 'helper', code: knownCode(reply.value.code), classification: op.outcome, nodeValidated: reply.nodeValidated });
        }
        return record(state, { ...fail('prepare', localCode(reply.transport ?? reply.frameRefused)), step: 'prepare', label });
    }

    async function lookup(label, { loseAccepted = false } = {}) {
        const state = load();
        const op = state.operations[label];
        const expected = expectedFor(state, op);
        const session = await openSession(state, op, { loseAccepted });
        if (session.fault) return record(state, { ok: true, step: 'lookup', label, ...session.fault });
        if (session.refusal) return record(state, { step: 'lookup', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        const reply = await request(state, op, session, 'lookup', canonical({ version: 1 }));
        await session.peer.close();
        if (reply.kind !== 'lookup-result') return record(state, { ...fail('lookup', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'lookup', label });
        const reconciled = reconcileTargetReceipt(expected, reply.value);
        const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'lookup', result: reply.value } });
        if (reconciled.ok && reconciled.value.kind === 'receipt') adopt(op, reply.value.receipt);
        if (outcome.ok) op.outcome = outcome.value.outcome;
        return record(state, {
            ok: reconciled.ok, step: 'lookup', label, state: reply.value.state, reconciled: reconciled.ok ? reconciled.value.kind : reconciled.error.code,
            classification: outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`,
            receipt: reply.value.receipt ? summary(reply.value.receipt) : null, nodeValidated: reply.nodeValidated
        });
    }

    // commit; `facts` (when given) first revalidates the admitted binding and refuses before any helper contact.
    async function commit(label, { facts = null } = {}) {
        const state = load();
        const op = state.operations[label];
        if (facts !== null) {
            const decision = requireExecutionTarget(state.admission.selection, factsWith(facts, state.binding));
            if (!decision.ok) return record(state, { ...fail('revalidate', decision.error.code), step: 'commit', label });
        }
        if (!op.receipt || op.receipt.state !== 'prepared') return record(state, { ...fail('commit', 'not_prepared'), step: 'commit', label });
        const expected = expectedFor(state, op);
        const session = await openSession(state, op);
        if (session.refusal) return record(state, { step: 'commit', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        const body = canonical({
            version: 1, workerCommitDigest: digestOf({ version: 1, key: expected.key, requestDigest: op.requestDigest, preparedReceiptSequence: op.receipt.receiptSequence }),
            preparedReceiptSequence: op.receipt.receiptSequence, preparedResourcesDigest: digestOf(op.receipt.resources, RESOURCES_DIGEST_BYTES)
        });
        const reply = await request(state, op, session, 'commit', body);
        await session.peer.close();
        if (reply.kind !== 'receipt') return record(state, { ...fail('commit', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'commit', label });
        const reconciled = reconcileTargetReceipt(expected, { state: reply.value.state, receipt: reply.value });
        if (!reconciled.ok) return record(state, { ...fail('commit', reconciled.error.code), step: 'commit', label });
        adopt(op, reply.value);
        return record(state, { ok: true, step: 'commit', label, receipt: summary(reply.value), nodeValidated: reply.nodeValidated });
    }

    function summary(receipt) {
        const checked = validateTargetReceipt(receipt);
        return {
            valid: checked.ok, state: receipt.state, receiptSequence: receipt.receiptSequence, gateReleased: receipt.gateReleased,
            helperIncarnation: receipt.helperIncarnation, journalStoreIdentity: receipt.journalStoreIdentity, targetBindingDigest: receipt.targetBindingDigest,
            requestDigest: receipt.requestDigest, resources: receipt.resources.map((entry) => ({ resourceId: entry.resourceId, state: entry.state }))
        };
    }

    return Object.freeze({ admit, revalidate, defineOperation, prepare, lookup, commit, state: load });
}
