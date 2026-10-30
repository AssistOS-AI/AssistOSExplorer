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
// Tickets come from one of two sources, exactly one per host:
//   ticketKey   PROOF-FIXTURE: `fixtureMinter.mjs` signs with the public fixture key (helper `--proof-fixture-session`)
//   mintTicket  ROUTER (`--router-tickets`): Ploinky's private helper-ticket operation through `server/helperTicketClient.mjs`
//               returns `{ticket, kid, jti, iat, exp, sessionKey}`; the session key is the Router's (A11.5), never derived
//               here, and both are held in memory only: never in argv, environment, output or the state directory (R3)
// PROOF-FIXTURE departures (each recorded in the evidence): the worker's own durable state is this file-backed record,
// not the S1 worker store; facts that Ploinky does not yet produce (source protection, attestation digests, HOME
// compatibility) are fixture-supplied by the operator. Since slice P8 the helper launches one real keeper per execution: a prepare body
// may name the workload (`{executable, args}`, an image inventory name), and `stop`, `release` and a recovery `rebind`
// (a replaced target: the same execution under the new target identity and a new recovery lease) are served.
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
import { HELPER_TICKET_MINT_CODES } from '../../../../server/helperTicketClient.mjs';
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

// Router mint outcomes (`--router-tickets`). The transient Router refusals are retried with bounded backoff: the minter
// refuses them before minting anything (store lock wait -> `caller_mismatch`, target inspection timeout ->
// `target_not_eligible`, secret not readable yet -> `secret_unavailable`, the per-caller limiter or the nonce set ->
// `capacity_exceeded`; the client surfaces a 429 the same way), and an edge generation change answers 503 with nothing
// minted. Every other refusal and every other failure is terminal. A11.6: a code is printed or persisted only as one of
// these spellings, else `refused`; an error message is never propagated.
export const TICKET_TTL_SECONDS = 30;
const RETRYABLE_MINT_CODES = new Set(['caller_mismatch', 'target_not_eligible', 'secret_unavailable', 'capacity_exceeded']);
const RETRYABLE_MINT_THROWS = new Map([['helper_ticket_http_503', 'router_unavailable'], ['helper_ticket_http_429', 'capacity_exceeded']]);
const MINT_CODES = new Set([...HELPER_TICKET_MINT_CODES, 'forbidden', 'invalid_request', 'ticket_binding', 'refused', 'router_unavailable', 'mint_unavailable']);
// Retries within one helper challenge reuse its nonce and epoch (nothing was minted); the whole budget stays well inside
// the helper's challenge timeout (5 s) and the Router's 60 requests per minute. A session whose budget ran out is closed
// and one more is opened after `sessionDelayMs` (a new nonce and a newly recorded attempt epoch, A11.2).
export const MINT_RETRY = Object.freeze({ delaysMs: Object.freeze([150, 400, 900]), challengeBudgetMs: 3000, sessions: 2, sessionDelayMs: 1000 });

export function mintCode(code) {
    return typeof code === 'string' && MINT_CODES.has(code) ? code : 'refused';
}

// {kind: 'ok'} | {kind: 'retry', code} | {kind: 'terminal', code} for one mintTicket outcome ({result} or {error}).
export function classifyMint(outcome) {
    if (outcome && Object.hasOwn(outcome, 'error')) {
        const message = outcome.error instanceof Error ? outcome.error.message : null;
        return RETRYABLE_MINT_THROWS.has(message) ? { kind: 'retry', code: RETRYABLE_MINT_THROWS.get(message) } : { kind: 'terminal', code: 'mint_unavailable' };
    }
    const result = outcome?.result;
    if (result?.ok === true && result.value && typeof result.value.ticket === 'string' && typeof result.value.sessionKey === 'string') return { kind: 'ok' };
    const code = mintCode(result?.ok === false ? result.error?.code : null);
    return RETRYABLE_MINT_CODES.has(code) ? { kind: 'retry', code } : { kind: 'terminal', code };
}

// The exact claim bytes the ticket carries (the client has checked that they are canonical) and the Router's session key.
function routerMaterial(value) {
    const claimsCanonical = Buffer.from(value.ticket.split('.')[1], 'base64url').toString('utf8');
    return { ticket: value.ticket, claimsCanonical, sessionKey: Buffer.from(value.sessionKey, 'base64url'), kid: value.kid, jti: value.jti, exp: value.exp };
}

function countIn(bytes, needles) {
    if (!Buffer.isBuffer(bytes)) return null;
    let total = 0;
    for (const needle of needles) {
        for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) total += 1;
    }
    return total;
}

function readOrNull(file) {
    try {
        return fs.readFileSync(file);
    } catch {
        return null;
    }
}

function filesUnder(root) {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) out.push(full);
        }
    };
    walk(root);
    return out;
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
//   ticketKey       PROOF-FIXTURE {kid, secret} from fixtureMinter.loadFixtureTicketKey(), or
//   mintTicket      ROUTER: async (request) => helperTicketClient result (exactly one of the two)
//   self            ROUTER: the worker's own {principal, runtimeInstanceId, enableGeneration} (Ploinky identity); admission
//                   and rebind refuse facts whose worker half differs from it or from the advanced generation
//   sourceProtection  ROUTER: the source-protection client (`advanceWorkerGeneration`) for `advanceGeneration`
//   qualification   {root, uid, forbiddenRoots}: the worker-owned qualification store
//   now, random     injectable clock and randomness; monoNow, sleep, retry: the mint retry clock, wait and budget
export function createWorkerHost({
    stateDir, mailbox, peerCommand, ticketKey = null, mintTicket = null, self = null, sourceProtection = null, qualification, now = Date.now, random = crypto.randomBytes,
    monoNow = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), retry = MINT_RETRY
} = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof mailbox !== 'string' || typeof peerCommand !== 'string'
        || (ticketKey === null) === (mintTicket === null) || (mintTicket !== null && typeof mintTicket !== 'function')) {
        throw new TypeError('createWorkerHost: stateDir, mailbox, peerCommand and exactly one of ticketKey or mintTicket are required');
    }
    const routerMode = mintTicket !== null;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stateFile = path.join(stateDir, STATE_FILE);

    function load() {
        if (!fs.existsSync(stateFile)) return { version: 1, admission: null, binding: null, leaseId: null, leaseEpoch: null, leaseAttempt: null, workerGeneration: null, generationAdvance: null, operations: {}, history: [] };
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

    // The receipt an operation's record carries names the binding and lease that defined it (they differ from the current
    // ones only after a recovery `rebind`).
    function expectedFor(state, op) {
        return {
            key: operationKey(state, op.operationId), targetBindingDigest: op.bindingDigest ?? digestOf(state.binding), reservationId: op.reservationId,
            requestDigest: op.requestDigest, journalStoreIdentity: state.binding.journalStoreIdentity, leaseId: op.leaseId ?? state.leaseId,
            lastReceiptSequence: op.lastReceiptSequence
        };
    }

    // ROUTER mode: the binding's worker half must be this worker as the Router will see it (its Ploinky identity and the
    // generation it advanced in the source-protection store), else every mint would be `caller_mismatch`.
    function workerMismatch(state, facts) {
        if (!routerMode) return false;
        const worker = facts?.current?.worker;
        return !self || !worker || worker.principal !== self.principal || worker.runtimeInstanceId !== self.runtimeInstanceId
            || worker.enableGeneration !== self.enableGeneration || typeof state.workerGeneration !== 'string' || worker.generation !== state.workerGeneration;
    }

    // Admission from trusted facts (live and fixture-supplied, see the module header) and the qualification store; on
    // success the execution is counted and the TargetBinding recorded.
    function admit({ selection, facts, operationId, fixtureDigests }) {
        const state = load();
        if (state.binding !== null) return record(state, fail('admit', 'already_admitted'));
        if (workerMismatch(state, facts)) return record(state, { ...fail('admit', 'worker_identity_mismatch'), step: 'admit' });
        const decision = requireExecutionTarget(selection, factsWith(facts, null));
        if (!decision.ok) return record(state, { ...fail('admit', decision.error.code), step: 'admit' });
        const store = openStore();
        const found = store.get(decision.value.ref);
        if (!found.ok) return record(state, { ...fail('admit', found.error.code), step: 'admit' });
        const qualificationRecord = found.value.record;
        const counted = store.consumeExecution(decision.value.ref, operationId);
        if (!counted.ok) return record(state, { ...fail('admit', counted.error.code), step: 'admit' });
        const binding = bindingFor({ facts, decision, qualificationRecord, fixtureDigests, ids: { robotId: randomId(random), executionId: randomId(random), attemptId: randomId(random) } });
        const checked = validateTargetBinding(binding);
        if (!checked.ok) return record(state, { ...fail('admit', `binding_${checked.error.code}`), step: 'admit' });
        state.binding = binding;
        state.admission = { selection, ref: decision.value.ref, principal: decision.value.principal, qualificationRecordDigest: decision.value.qualificationRecordDigest, operationId, executionsUsed: counted.value.used };
        state.leaseId = randomId(random);
        return record(state, { ok: true, step: 'admit', admission: state.admission, targetBindingDigest: digestOf(binding) });
    }

    // The TargetBinding for an admission decision and the execution identifiers.
    function bindingFor({ facts, decision, qualificationRecord, fixtureDigests, ids }) {
        const entry = facts.entries.find((candidate) => candidate.ref === decision.value.ref);
        const worker = facts.current.worker;
        const sourceRecord = facts.sourceState.record;
        return {
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
            robotId: ids.robotId, executionId: ids.executionId, attemptId: ids.attemptId, configRevision: 1,
            helperExecutableDigest: qualificationRecord.helperExecutableDigest, contractDigest: qualificationRecord.contractDigest,
            inventoryDigest: qualificationRecord.inventoryDigest, profileDigest: qualificationRecord.profileDigest,
            limitsDigest: facts.current.limitsDigest, qualificationRecordDigest: decision.value.qualificationRecordDigest,
            effectiveSecurityDigest: qualificationRecord.effectiveSecurityDigest,
            ...Object.fromEntries(FIXTURE_DIGEST_KEYS.map((key) => [key, fixtureDigests[key]])),
            homeCompatibilityDigest: digestOf(qualificationRecord.homeCompatibility)
        };
    }

    // RECOVERY (slice P8): the admitted target was replaced (new container and helper incarnation, same helper-only
    // journal). The same execution (robot, execution and attempt IDs) is bound to the replacement's current identity for
    // lookup, stop and release of its old operations only, under a new recovery lease; nothing is admitted or counted
    // again. The journal refuses a prepare (changed binding digest) and the helper a commit (another lease), so the old
    // operation can never be adopted or relaunched.
    function rebind({ facts, fixtureDigests }) {
        const state = load();
        if (state.binding === null) return fail('rebind', 'not_admitted');
        if (workerMismatch(state, facts)) return record(state, { ...fail('rebind', 'worker_identity_mismatch'), step: 'rebind' });
        const decision = requireExecutionTarget(state.admission.selection, factsWith(facts, null));
        if (!decision.ok) return record(state, { ...fail('rebind', decision.error.code), step: 'rebind' });
        const store = openStore();
        const found = store.get(decision.value.ref);
        if (!found.ok) return record(state, { ...fail('rebind', found.error.code), step: 'rebind' });
        const ids = { robotId: state.binding.robotId, executionId: state.binding.executionId, attemptId: state.binding.attemptId };
        const binding = bindingFor({ facts, decision, qualificationRecord: found.value.record, fixtureDigests, ids });
        const checked = validateTargetBinding(binding);
        if (!checked.ok) return record(state, { ...fail('rebind', `binding_${checked.error.code}`), step: 'rebind' });
        if (binding.journalStoreIdentity !== state.binding.journalStoreIdentity) return record(state, { ...fail('rebind', 'journal_store_changed'), step: 'rebind' });
        state.previousBindings = [...(state.previousBindings ?? []), { binding: state.binding, leaseId: state.leaseId }];
        state.binding = binding;
        state.leaseId = randomId(random);
        state.leaseEpoch = null;
        state.leaseAttempt = null;
        return record(state, { ok: true, step: 'rebind', targetBindingDigest: digestOf(binding), helperIncarnation: binding.scope.helperIncarnation });
    }

    // Revalidation of the admitted binding against current trusted facts (queued dispatch / final gate release).
    function revalidate(facts) {
        const state = load();
        if (state.binding === null) return fail('revalidate', 'not_admitted');
        const decision = requireExecutionTarget(state.admission.selection, factsWith(facts, state.binding));
        return record(state, decision.ok ? { ok: true, step: 'revalidate' } : { ...fail('revalidate', decision.error.code), step: 'revalidate' });
    }

    // ROUTER mode, Q3: register this worker's generation in Ploinky's source-protection store (T0 A2.3), the pointer the
    // Router binds into every ticket. The body is recorded before it is sent and resent unchanged after an unknown
    // outcome, so a retry replays the store's receipt instead of advancing twice. `priorGeneration` names the registered
    // generation for a state directory that has none yet (the fixture keeps one state directory per execution); the store
    // compares it with its pointer, so a wrong value is refused there (`stale_generation`).
    async function advanceGeneration({ priorGeneration = null } = {}) {
        if (!sourceProtection || typeof sourceProtection.advanceWorkerGeneration !== 'function') throw new Error('advanceGeneration needs the source-protection client');
        const state = load();
        if (state.binding !== null) return record(state, { ...fail('advance', 'already_admitted'), step: 'advance' });
        if (priorGeneration !== null && (typeof priorGeneration !== 'string' || (state.workerGeneration ?? priorGeneration) !== priorGeneration)) {
            return record(state, { ...fail('advance', 'prior_generation_mismatch'), step: 'advance' });
        }
        const body = state.generationAdvance?.pending
            ?? { version: 1, operationId: randomId(random), priorGeneration: state.workerGeneration ?? priorGeneration, nextGeneration: randomId(random) };
        state.generationAdvance = { pending: body };
        save(state);
        let result;
        try {
            result = await sourceProtection.advanceWorkerGeneration(null, body);
        } catch {
            return record(state, { ...fail('advance', 'outcome_unknown'), step: 'advance' });
        }
        state.generationAdvance = null;
        if (result?.ok !== true || result.value?.currentGeneration !== body.nextGeneration || result.value?.priorGeneration !== body.priorGeneration) {
            return record(state, { ...fail('advance', localCode(result?.ok === false ? result.error?.code : 'advance_result_mismatch')), step: 'advance' });
        }
        state.workerGeneration = body.nextGeneration;
        return record(state, { ok: true, step: 'advance', workerPrincipal: result.value.workerPrincipal, priorGeneration: body.priorGeneration, workerGeneration: body.nextGeneration });
    }

    // A worker operation: one exact request body, so one request digest. A second label may reuse the operation ID of
    // another (`sameOperationAs`) only to exercise the conflicting-payload refusal.
    // `workload` (slice P8): `{executable, args}` for the target keeper, part of the ticketed request body.
    function defineOperation(label, { resources, sameOperationAs = null, workload = null }) {
        const state = load();
        if (state.binding === null) throw new Error('not admitted');
        if (state.operations[label]) throw new Error(`operation ${label} exists`);
        const sorted = [...resources].sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1));
        const body = canonical(workload === null ? { version: 1, resources: sorted } : { version: 1, resources: sorted, workload }, 256 * 1024);
        // A target operation ID is the worker's own (distinct from the coordinator operation that was admitted).
        const operationId = sameOperationAs ? state.operations[sameOperationAs].operationId : randomId(random);
        state.operations[label] = {
            operationId, reservationId: sameOperationAs ? state.operations[sameOperationAs].reservationId : randomId(random), body,
            requestDigest: crypto.createHash('sha256').update(body, 'utf8').digest('hex'), lastReceiptSequence: 0, receipt: null, outcome: null,
            bindingDigest: digestOf(state.binding), leaseId: state.leaseId
        };
        save(state);
        return { label, operationId, requestDigest: state.operations[label].requestDigest };
    }

    // ROUTER: one mint for this helper challenge, retrying the transient refusals within the challenge budget.
    async function routerTicket(request) {
        const started = monoNow();
        let attempts = 0;
        for (let index = 0; ; index += 1) {
            attempts += 1;
            let outcome;
            try {
                outcome = { result: await mintTicket(request) };
            } catch (error) {
                outcome = { error };
            }
            const verdict = classifyMint(outcome);
            if (verdict.kind === 'ok') return { ok: true, material: routerMaterial(outcome.result.value), attempts };
            if (verdict.kind === 'terminal') return { ok: false, code: verdict.code, retryable: false, attempts };
            const delay = retry.delaysMs[index];
            if (delay === undefined || monoNow() - started + delay > retry.challengeBudgetMs) return { ok: false, code: verdict.code, retryable: true, attempts };
            await sleep(delay);
        }
    }

    // `loseAccepted`: the PROOF-FIXTURE lost-`accepted` fault (the peer sends the bootstrap and closes without reading).
    // `scan` (ROUTER, U7/R3): {sink(needles)}; see scanSession.
    async function openSession(state, op, options = {}) {
        let attempts = 0;
        for (let round = 1; ; round += 1) {
            const session = await openSessionOnce(state, op, options);
            attempts += session.mintAttempts ?? 0;
            if (!session.retryMint || round >= retry.sessions) {
                if (session.refusal && routerMode) session.refusal.mintAttempts = attempts;
                if (session.minted) session.ticketInfo = { source: routerMode ? 'router' : 'proof-fixture', mintAttempts: routerMode ? attempts : null, kid: session.minted.kid ?? null, jti: session.minted.jti ?? null, exp: session.minted.exp ?? null };
                delete session.retryMint;
                delete session.mintAttempts;
                return session;
            }
            await sleep(retry.sessionDelayMs);
        }
    }

    async function openSessionOnce(state, op, { loseAccepted = false, permissions = ['commit', 'lookup', 'prepare'] } = {}) {
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
        let minted;
        let mintAttempts = 0;
        if (routerMode) {
            const got = await routerTicket({
                binding: state.binding, leaseId: state.leaseId, reservationId: op.reservationId, operationId: op.operationId, requestDigest: op.requestDigest,
                helperNonce: challenge.helperNonce, channelEpoch: epoch, previousChannelEpoch: previous, permissions: [...permissions].sort(), ttlSeconds: TICKET_TTL_SECONDS
            });
            mintAttempts = got.attempts;
            if (!got.ok) {
                await peer.close();
                return { refusal: fail('mint', got.code), retryMint: got.retryable, mintAttempts };
            }
            minted = got.material;
        } else {
            minted = mintFixtureTicket({
                key: ticketKey, binding: state.binding, reservationId: op.reservationId, leaseId: state.leaseId, operationId: op.operationId,
                requestDigest: op.requestDigest, helperNonce: challenge.helperNonce, channelEpoch: epoch, previousChannelEpoch: previous, nowMs: now(),
                randomBytes: random, permissions
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
        }
        // The ticket and session key reach the native peer only on its stdin, never in argv or the environment.
        const wipe = () => minted.sessionKey.fill(0);
        if (loseAccepted) {
            peer.send({ op: 'bootstrap-drop', ticket: minted.ticket, sessionKey: minted.sessionKey.toString('base64url') });
            const sent = await peer.next();
            await peer.close();
            wipe();
            return { fault: { fault: 'accepted-lost', attemptedEpoch: epoch, peer: sent?.event === 'bootstrap-dropped' ? 'bootstrap-dropped' : 'unexpected' }, mintAttempts };
        }
        peer.send({ op: 'bootstrap', ticket: minted.ticket, sessionKey: minted.sessionKey.toString('base64url') });
        const answer = await peer.next();
        if (answer === null || answer.event !== 'accepted') {
            await peer.close();
            wipe();
            // A helper refusal is reduced to a known spelling; a local peer error keeps its plain identifier.
            const code = answer?.event === 'refused' ? knownCode(answer.code) : localCode(answer?.code ?? 'no_answer');
            return { refusal: fail('bootstrap', code), challengeIncarnation: challenge.helperIncarnation, mintAttempts };
        }
        state.leaseEpoch = epoch;
        save(state);
        const close = async () => {
            const code = await peer.close();
            wipe();
            return code;
        };
        return { peer, minted, epoch, receiveSequence: 1n, challengeIncarnation: challenge.helperIncarnation, mintAttempts, close };
    }

    // ROUTER U7/R3 probe, while the session is live: match counts (never values; the signature needle also matches inside
    // a full ticket, so any count > 0 is a leak) of the session key and the full ticket in this
    // process's argv and environment, the native peer's argv and environment, and every file of the state directory, with
    // a positive control (how many of the needles are found) on an in-memory buffer that holds them. `scan.sink(needles)` hands the needles to an external
    // scanner over a pipe only (main.mjs `--needle-fd`); they are never printed or persisted here.
    function scanSession(session, scan) {
        const { ticket, sessionKey } = session.minted;
        const needles = [ticket, ticket.split('.')[2], sessionKey.toString('base64url'), sessionKey.toString('hex')].map((text) => Buffer.from(text, 'utf8'));
        const peerPid = session.peer.child.pid;
        const control = Buffer.concat([crypto.randomBytes(64), ...needles.flatMap((needle) => [needle, Buffer.from('\n')]), crypto.randomBytes(64)]);
        const stateFiles = filesUnder(stateDir);
        const report = {
            needles: needles.length, positiveControl: needles.filter((needle) => control.includes(needle)).length,
            selfArgv: countIn(readOrNull('/proc/self/cmdline'), needles), selfEnviron: countIn(readOrNull('/proc/self/environ'), needles),
            peerArgv: countIn(readOrNull(`/proc/${peerPid}/cmdline`), needles), peerEnviron: countIn(readOrNull(`/proc/${peerPid}/environ`), needles),
            stateFiles: stateFiles.length, stateMatches: stateFiles.reduce((sum, file) => sum + (countIn(readOrNull(file), needles) ?? 0), 0)
        };
        if (typeof scan.sink === 'function') scan.sink(needles.map((needle) => needle.toString('utf8')));
        return report;
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
            await session.close();
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'transport', detail: 'reply-lost' } });
            op.outcome = outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`;
            return record(state, { ok: true, step: 'prepare', label, fault: 'lost-reply', peer: dropped?.event ?? null, classification: op.outcome });
        }
        const reply = await request(state, op, session, 'prepare', op.body);
        await session.close();
        if (reply.kind === 'prepared') {
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'receipt', receipt: reply.value } });
            if (!outcome.ok) return record(state, { ...fail('prepare', outcome.error.code), step: 'prepare', label });
            adopt(op, reply.value);
            op.outcome = outcome.value.outcome;
            return record(state, { ok: true, step: 'prepare', label, classification: op.outcome, receipt: summary(reply.value), nodeValidated: reply.nodeValidated, ticket: session.ticketInfo });
        }
        if (reply.kind === 'failure') {
            // An authenticated refusal without journal absence evidence is not proof that nothing was created.
            const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'refused', code: knownCode(reply.value.code) } });
            op.outcome = outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`;
            return record(state, { ok: false, step: 'prepare', label, stage: 'helper', code: knownCode(reply.value.code), classification: op.outcome, nodeValidated: reply.nodeValidated });
        }
        return record(state, { ...fail('prepare', localCode(reply.transport ?? reply.frameRefused)), step: 'prepare', label });
    }

    async function lookup(label, { loseAccepted = false, scan = null } = {}) {
        const state = load();
        const op = state.operations[label];
        const expected = expectedFor(state, op);
        if (scan !== null && !routerMode) throw new Error('scan applies to Router tickets only');
        const session = await openSession(state, op, { loseAccepted });
        if (session.fault) return record(state, { ok: true, step: 'lookup', label, ...session.fault });
        if (session.refusal) return record(state, { step: 'lookup', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        const reply = await request(state, op, session, 'lookup', canonical({ version: 1 }));
        const scanned = scan === null ? null : scanSession(session, scan);
        await session.close();
        if (reply.kind !== 'lookup-result') return record(state, { ...fail('lookup', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'lookup', label });
        const reconciled = reconcileTargetReceipt(expected, reply.value);
        const outcome = classifyTargetStartOutcome({ expected, reply: { kind: 'lookup', result: reply.value } });
        if (reconciled.ok && reconciled.value.kind === 'receipt') adopt(op, reply.value.receipt);
        if (outcome.ok) op.outcome = outcome.value.outcome;
        return record(state, {
            ok: reconciled.ok, step: 'lookup', label, state: reply.value.state, reconciled: reconciled.ok ? reconciled.value.kind : reconciled.error.code,
            classification: outcome.ok ? outcome.value.outcome : `invalid:${outcome.error.code}`,
            receipt: reply.value.receipt ? summary(reply.value.receipt) : null, nodeValidated: reply.nodeValidated, ticket: session.ticketInfo,
            ...(scanned ? { scan: scanned } : {})
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
        await session.close();
        if (reply.kind !== 'receipt') return record(state, { ...fail('commit', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'commit', label });
        const reconciled = reconcileTargetReceipt(expected, { state: reply.value.state, receipt: reply.value });
        if (!reconciled.ok) return record(state, { ...fail('commit', reconciled.error.code), step: 'commit', label });
        adopt(op, reply.value);
        return record(state, { ok: true, step: 'commit', label, receipt: summary(reply.value), nodeValidated: reply.nodeValidated, ticket: session.ticketInfo });
    }

    // stop (slice P8): exact-tree cancellation of this operation; the helper answers the `exited` receipt once the tree is
    // verified gone. Any lease of this execution may stop (a recovery lease after `rebind` included).
    async function stop(label) {
        const state = load();
        const op = state.operations[label];
        const expected = expectedFor(state, op);
        const session = await openSession(state, op, { permissions: ['lookup', 'stop'] });
        if (session.refusal) return record(state, { step: 'stop', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        const reply = await request(state, op, session, 'stop', canonical({ version: 1 }));
        await session.close();
        if (reply.kind !== 'receipt') return record(state, { ...fail('stop', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'stop', label });
        const reconciled = reconcileTargetReceipt(expected, { state: reply.value.state, receipt: reply.value });
        if (!reconciled.ok) return record(state, { ...fail('stop', reconciled.error.code), step: 'stop', label });
        adopt(op, reply.value);
        return record(state, { ok: true, step: 'stop', label, receipt: summary(reply.value), nodeValidated: reply.nodeValidated, ticket: session.ticketInfo });
    }

    // release (slice P8): every recorded resource with PROOF-FIXTURE worker evidence (a digest naming the exited receipt);
    // the helper verifies each absence itself before it records the release.
    async function release(label) {
        const state = load();
        const op = state.operations[label];
        if (!op.receipt || !['exited', 'stopping', 'quarantined'].includes(op.receipt.state)) return record(state, { ...fail('release', 'not_ended'), step: 'release', label });
        const expected = expectedFor(state, op);
        const session = await openSession(state, op, { permissions: ['lookup', 'release'] });
        if (session.refusal) return record(state, { step: 'release', label, ...session.refusal, challengeIncarnation: session.challengeIncarnation ?? null });
        const evidence = {
            resources: op.receipt.resources.map((entry) => ({
                resourceId: entry.resourceId, kind: 'verified-absent',
                evidenceDigest: digestOf({ version: 1, key: expected.key, resourceId: entry.resourceId, endedReceiptSequence: op.receipt.receiptSequence })
            }))
        };
        const reply = await request(state, op, session, 'release', canonical({ version: 1, evidence }));
        await session.close();
        if (reply.kind !== 'receipt') return record(state, { ...fail('release', reply.value ? knownCode(reply.value.code) : localCode(reply.transport ?? reply.frameRefused)), step: 'release', label });
        const reconciled = reconcileTargetReceipt(expected, { state: reply.value.state, receipt: reply.value });
        if (!reconciled.ok) return record(state, { ...fail('release', reconciled.error.code), step: 'release', label });
        adopt(op, reply.value);
        return record(state, { ok: true, step: 'release', label, receipt: summary(reply.value), nodeValidated: reply.nodeValidated, ticket: session.ticketInfo });
    }

    function summary(receipt) {
        const checked = validateTargetReceipt(receipt);
        return {
            valid: checked.ok, state: receipt.state, receiptSequence: receipt.receiptSequence, gateReleased: receipt.gateReleased,
            helperIncarnation: receipt.helperIncarnation, journalStoreIdentity: receipt.journalStoreIdentity, targetBindingDigest: receipt.targetBindingDigest,
            requestDigest: receipt.requestDigest, resources: receipt.resources.map((entry) => ({ resourceId: entry.resourceId, state: entry.state }))
        };
    }

    return Object.freeze({ admit, revalidate, rebind, advanceGeneration, defineOperation, prepare, lookup, commit, stop, release, state: load });
}
