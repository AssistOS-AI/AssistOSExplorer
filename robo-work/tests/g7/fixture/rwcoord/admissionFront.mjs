// rwcoord: the worker-side authenticated target-admission front (slice P7, PROOF-FIXTURE).
//
// A coordinator reaches this front only through Ploinky's signed coordinator hop: the coordinator agent calls the
// worker's declared coordinator route on the private Router listener with its private agent assertion, the Router admits
// exactly the declared coordinator principals and forwards a provider-audience Router Request (tool
// `__coordinator_admission__`, HS256 with the worker's own per-agent secret) bound to the received method, path, query
// and body hash. This front composes production modules, unchanged:
//   coordinatorAuth.mjs      `verifyCoordinatorRequest` (signature, lifetime, audience, type, issuer, tool, method, path,
//                            rch, caller = actor = subject, declared coordinator, owner evidence) and `consumeReplay`
//   availability.mjs         `requireExecutionTarget`, the full A1.7 refusal precedence and the proof-fixture activation
//   qualificationStore.mjs   the worker-owned trust anchor: records re-read per request, durable execution counting
//
// Trust split. Request content (rch-bound) names only `originRequestId`, the selection and the Environment surface. The
// coordinator principal, the owner evidence and therefore the operation ID come only from the verified hop. The worker's
// own principal, runtime instance and enable generation come from the identity Ploinky put in the worker container, the
// worker generation from the operator. The front itself adds the exclusions (RoboTeam, the owning worker by principal and
// runtime identity, and the verified coordinator, which stands in for RoboTeam in this fixture) and the qualification
// facts; the operator-supplied base facts may extend the exclusions, never replace them, and may not carry the request,
// the mode, the worker half or the qualification facts at all.
//
// PROOF-FIXTURE departures (each recorded in the README and the evidence): the admission row is the coordinator alone
// (`target-admission` origin key) or the coordinator-API row when owner evidence is present; it is a target-admission
// decision for the proof fixture, never an S1 admission. Discovery entries, HOME and most source facts are
// operator-supplied (labelled LIVE or FIXTURE in the evidence). Replay protection of hop tokens is the verifier's bounded
// in-memory cache (a front restart forgets consumed jtis); the operation ID makes a retry idempotent across restarts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CoordinatorAuthError, consumeReplay, verifyCoordinatorRequest } from '../../../../server/coordinatorAuth.mjs';
import { canonicalJson, isOriginId } from '../../../../server/stateProtocol.mjs';
import { AVAILABILITY_ERROR_CODES, requireExecutionTarget } from '../../../../server/executionTarget/availability.mjs';
import { isId, isOpaqueIdentity, isPrincipal } from '../../../../server/executionTarget/contract.mjs';
import { createQualificationStore } from '../../../../server/executionTarget/qualificationStore.mjs';

export const TARGET_ADMISSION_PATH = '/v1/target-admissions';
// The canonical RoboTeam principal (AGENTS.md: Ploinky names this repository AchillesIDE).
export const ROBOTEAM_PRINCIPAL = 'agent:AchillesIDE/roboTeamAgent';
export const TARGET_ADMISSION_ORIGIN_KEY = 'target-admission';
// Front-level codes, in addition to the availability codes a decision can carry.
export const FRONT_CODES = Object.freeze([
    'invalid_request', 'route_not_found', 'operation_conflict', 'facts_unavailable', 'store_unavailable', 'state_unavailable',
    'internal_error'
]);

const BODY_BYTES = 64 * 1024;
const SELECTION_BYTES = 512;
const BODY_KEYS = Object.freeze(['originRequestId', 'selection', 'surface', 'version']);
const BASE_KEYS = Object.freeze(['current', 'entries', 'excluded', 'home', 'live', 'sourceState']);
const SURFACES = Object.freeze(['terminal', 'browser', 'desktop']);
const AUTH_STATUS = Object.freeze({ unauthorized: 401, forbidden: 403, invalid_request: 400, unavailable: 503, operation_unavailable: 501 });
const STORE_CODE = Object.freeze({
    capacity_exceeded: 'capacity_exceeded', scope_mismatch: 'qualification_scope', not_found: 'qualification_missing',
    class_not_allowed: 'qualification_class'
});

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function exactKeys(value, keys) {
    return isPlainObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sortedUnique(values) {
    return [...new Set(values)].sort();
}

// The operation ID of a target admission: the first 22 base64url characters of SHA-256 over the canonical JSON
// {originNamespace, originKey, originRequestId}, the S1 rule (`stateProtocol.deriveOperationId`) applied to the
// verified coordinator row. `ownerUserId` is the verified owner (coordinator-API row) or null (coordinator alone).
export function deriveTargetOperationId({ coordinator, ownerUserId = null, originRequestId }) {
    if (!isPrincipal(coordinator) || !isOriginId(originRequestId) || (ownerUserId !== null && typeof ownerUserId !== 'string')) {
        throw new TypeError('deriveTargetOperationId: coordinator principal and originRequestId are required');
    }
    const originKey = ownerUserId === null ? TARGET_ADMISSION_ORIGIN_KEY : `owner:user:${ownerUserId}`;
    return crypto.createHash('sha256')
        .update(canonicalJson({ originNamespace: `coordinator:${coordinator}`, originKey, originRequestId }))
        .digest('base64url').slice(0, 22);
}

function answer(status, body) {
    return Object.freeze({ status, body: Object.freeze(body) });
}

function refusal(status, stage, code, extra = {}) {
    return answer(status, { ok: false, stage, code, ...extra });
}

function authRefusal(error) {
    if (!(error instanceof CoordinatorAuthError)) return refusal(500, 'authenticate', 'internal_error');
    return refusal(AUTH_STATUS[error.code] ?? 500, 'authenticate', error.code, { reason: error.reason });
}

function parseBody(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > BODY_BYTES) return null;
    let value;
    try {
        value = JSON.parse(raw.toString('utf8'));
    } catch {
        return null;
    }
    if (!isPlainObject(value)) return null;
    const keys = Object.keys(value);
    if (!keys.every((key) => BODY_KEYS.includes(key)) || !['originRequestId', 'selection', 'version'].every((key) => Object.hasOwn(value, key))) return null;
    if (value.version !== 1 || !isOriginId(value.originRequestId)) return null;
    // A blank selection is the ordinary backend, which this target-admission front does not serve; the selection text
    // itself is judged by requireExecutionTarget (invalid_selection), never here.
    if (typeof value.selection !== 'string' || value.selection.length < 1 || Buffer.byteLength(value.selection, 'utf8') > SELECTION_BYTES) return null;
    const surface = value.surface ?? 'terminal';
    if (!SURFACES.includes(surface)) return null;
    return { originRequestId: value.originRequestId, selection: value.selection, surface };
}

// The operator-supplied base facts: exactly {live, entries, sourceState, home, current: {limitsDigest,
// journalStoreIdentity}, excluded: {principals, aliases, runtimeInstanceIds}}. Anything front-owned is refused.
function checkBaseFacts(base) {
    if (!exactKeys(base, BASE_KEYS)) return false;
    if (!exactKeys(base.current, ['journalStoreIdentity', 'limitsDigest'])) return false;
    if (!exactKeys(base.excluded, ['aliases', 'principals', 'runtimeInstanceIds'])) return false;
    const excluded = base.excluded;
    return excluded.principals.every?.(isPrincipal) === true && excluded.aliases.every?.(isPrincipal) === true
        && excluded.runtimeInstanceIds.every?.(isOpaqueIdentity) === true && Array.isArray(base.entries);
}

// `options`:
//   verifier        createVerifierConfig({secret: the worker's per-agent secret, audience: worker principal,
//                   coordinators: the declared coordinator principals (trusted operator configuration), replayCache})
//   worker          {principal, runtimeInstanceId, enableGeneration, generation}: Ploinky identity + operator generation
//   mode            'proof-fixture' (default) or 'production' (production admission must refuse every fixture record)
//   store           {fs, root, uid, forbiddenRoots}: the worker-owned qualification store
//   loadBaseFacts   () => base facts object (re-read for every request; a throw is facts_unavailable)
//   sourceState     async (baseSourceState) => sourceState fact or null; default: the operator object itself, and null
//                   for a `{provider}` placeholder (then the decision is source_unavailable)
//   stateDir        private directory for the admission records (created 0700)
//   now             millisecond clock
//   log             (event) => void, one bounded event per request; never receives tokens, secrets or bodies
export function createAdmissionFront({
    verifier, worker, mode = 'proof-fixture', store, loadBaseFacts, sourceState = defaultSourceState, stateDir, now = Date.now, log = () => {}
} = {}) {
    if (!verifier || !isPlainObject(worker) || worker.principal !== verifier.audience || !isPrincipal(worker.principal)
        || !isOpaqueIdentity(worker.runtimeInstanceId) || !isOpaqueIdentity(worker.enableGeneration) || !isId(worker.generation)
        || !['proof-fixture', 'production'].includes(mode) || !isPlainObject(store) || typeof loadBaseFacts !== 'function'
        || typeof sourceState !== 'function' || typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof now !== 'function') {
        throw new TypeError('createAdmissionFront: verifier, worker identity, mode, store, loadBaseFacts and stateDir are required');
    }
    const workerFact = Object.freeze({ ...worker });
    const admissionsDir = path.join(stateDir, 'admissions');
    // An intent is written before an execution is counted: a retry after a lost admission record finds it and is not
    // charged a second slot for the same operation.
    const intentsDir = path.join(stateDir, 'intents');
    fs.mkdirSync(admissionsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(intentsDir, { recursive: true, mode: 0o700 });

    function openStore() {
        const opened = createQualificationStore({ fs: store.fs ?? fs, root: store.root, uid: store.uid, forbiddenRoots: store.forbiddenRoots ?? [] });
        return opened.ok ? opened.value : null;
    }

    function readRecord(operationId, dir = admissionsDir) {
        const file = path.join(dir, `${operationId}.json`);
        let text;
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > 64 * 1024) return { unusable: true };
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            return error && error.code === 'ENOENT' ? null : { unusable: true };
        }
        try {
            return JSON.parse(text);
        } catch {
            return { unusable: true };
        }
    }

    // temp file, fsync, rename, directory fsync.
    function writeRecord(operationId, value, dir = admissionsDir) {
        const temp = path.join(dir, `.${operationId}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
            fs.writeSync(fd, `${JSON.stringify(value)}\n`);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, path.join(dir, `${operationId}.json`));
        const handle = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    }

    function removeIntent(operationId) {
        try {
            fs.unlinkSync(path.join(intentsDir, `${operationId}.json`));
        } catch {
            // A leftover intent is harmless: the record is consulted first.
        }
    }

    async function handleNow(request) {
        // 1. The coordinator hop, verified against what this front actually received.
        let hop;
        try {
            hop = verifyCoordinatorRequest(verifier, request);
        } catch (error) {
            return authRefusal(error);
        }
        // 2. A verified token is burned whatever the outcome, before anything else is read.
        try {
            consumeReplay(verifier, [hop]);
        } catch (error) {
            return authRefusal(error);
        }
        if (hop.method !== 'POST' || hop.query !== '' || hop.path !== TARGET_ADMISSION_PATH) return refusal(404, 'route', 'route_not_found');
        const body = parseBody(request.body);
        if (body === null) return refusal(400, 'request', 'invalid_request');
        const ownerUserId = hop.owner ? hop.owner.userId : null;
        const operationId = deriveTargetOperationId({ coordinator: hop.coordinator, ownerUserId, originRequestId: body.originRequestId });
        const requestDigest = crypto.createHash('sha256').update(canonicalJson({
            coordinator: hop.coordinator, ownerUserId, originRequestId: body.originRequestId, selection: body.selection, surface: body.surface
        })).digest('hex');
        // 3. A recorded admission of this operation is returned as recorded; another body under it conflicts.
        const recorded = readRecord(operationId);
        if (recorded !== null) {
            if (recorded.unusable || recorded.requestDigest === undefined) return refusal(503, 'state', 'state_unavailable', { operationId });
            if (recorded.requestDigest !== requestDigest) return refusal(200, 'admission', 'operation_conflict', { operationId });
            return answer(200, { ok: true, replayed: true, value: recorded.value });
        }
        // An intent of this operation (an earlier attempt that may have counted before its record was lost): another body
        // conflicts; the same body is re-evaluated without charging the operation's own slot again (below).
        const intent = readRecord(operationId, intentsDir);
        if (intent !== null) {
            if (intent.unusable || intent.requestDigest === undefined || typeof intent.ref !== 'string') return refusal(503, 'state', 'state_unavailable', { operationId });
            if (intent.requestDigest !== requestDigest) return refusal(200, 'admission', 'operation_conflict', { operationId });
        }
        // 4. Trusted facts: base facts (operator) + front-owned facts. Nothing is cached between requests.
        let base;
        try {
            base = loadBaseFacts();
        } catch {
            base = null;
        }
        if (!checkBaseFacts(base)) return refusal(503, 'facts', 'facts_unavailable', { operationId });
        const qualificationStore = openStore();
        const qualifications = qualificationStore ? qualificationStore.facts() : null;
        if (!qualifications || !qualifications.ok) return refusal(503, 'store', 'store_unavailable', { operationId });
        let source;
        try {
            source = await sourceState(base.sourceState);
        } catch {
            source = null;
        }
        const facts = {
            surface: body.surface, mode, live: base.live,
            excluded: {
                principals: sortedUnique([ROBOTEAM_PRINCIPAL, workerFact.principal, hop.coordinator, ...base.excluded.principals]),
                aliases: sortedUnique(base.excluded.aliases),
                runtimeInstanceIds: sortedUnique([workerFact.runtimeInstanceId, ...base.excluded.runtimeInstanceIds])
            },
            entries: base.entries, sourceState: source ?? null, qualifications: ownSlotExcluded(qualifications.value, intent),
            request: { coordinatorPrincipal: hop.coordinator, operationId, nowMs: now() },
            home: base.home, admittedBinding: null,
            current: { worker: workerFact, limitsDigest: base.current.limitsDigest, journalStoreIdentity: base.current.journalStoreIdentity }
        };
        // 5. The decision, in the A1.7 precedence order.
        const decision = requireExecutionTarget(body.selection, facts);
        if (!decision.ok) return refusal(200, 'admission', decision.error.code, { operationId });
        if (decision.value.backend !== 'target') return refusal(200, 'admission', 'invalid_selection', { operationId });
        // 6. Durable intent, durable count (deduplicated by operation ID, and authoritative for the budget), then the record.
        try {
            if (intent === null) writeRecord(operationId, { version: 1, requestDigest, ref: decision.value.ref }, intentsDir);
        } catch {
            return refusal(503, 'state', 'state_unavailable', { operationId });
        }
        const counted = qualificationStore.consumeExecution(decision.value.ref, operationId);
        if (!counted.ok) {
            // Only the intent this request wrote is removed, and only on a definite store refusal (nothing was counted by
            // this request). An intent that was already there may belong to an earlier attempt that did count: an
            // unreadable counter reads as exhausted (`capacity_exceeded`), so a refusal proves nothing about that attempt.
            // `io_error` cannot tell whether the count landed either: the intent stays, as it enables the idempotent retry.
            if (intent === null && counted.error.code !== 'io_error') removeIntent(operationId);
            return refusal(200, 'admission', STORE_CODE[counted.error.code] ?? 'store_unavailable', { operationId });
        }
        const value = {
            backend: 'target', ref: decision.value.ref, principal: decision.value.principal, qualificationClass: decision.value.qualificationClass,
            qualificationRecordDigest: decision.value.qualificationRecordDigest, operationId, coordinator: hop.coordinator,
            executionsUsed: counted.value.used
        };
        try {
            writeRecord(operationId, { version: 1, requestDigest, admittedAtMs: now(), value });
        } catch {
            return refusal(503, 'state', 'state_unavailable', { operationId });
        }
        // The operation is counted and recorded; a failed record write above keeps the intent (counted, so a retry needs it).
        removeIntent(operationId);
        return answer(200, { ok: true, replayed: false, value });
    }

    // Requests are handled one at a time: the count and the record of one admission never interleave with another.
    let chain = Promise.resolve();
    function handle(request) {
        const run = chain.then(async () => {
            let result;
            try {
                result = await handleNow(request);
            } catch {
                result = refusal(500, 'internal', 'internal_error');
            }
            try {
                log({ atMs: now(), status: result.status, ok: result.body.ok, stage: result.body.stage ?? 'admitted', code: result.body.code ?? null,
                    operationId: result.body.operationId ?? result.body.value?.operationId ?? null, replayed: result.body.replayed ?? null });
            } catch {
                // Logging never changes the answer.
            }
            return result;
        });
        chain = run.catch(() => {});
        return run;
    }

    return Object.freeze({ handle });
}

// The qualification facts with one execution slot given back to the intent's target: the operation of an intent may
// already be counted, and availability.mjs compares the count with the budget before the store deduplicates by
// operation ID. Never an extra slot: `consumeExecution` re-checks the budget and refuses an operation it has not counted.
function ownSlotExcluded(qualifications, intent) {
    if (intent === null || !isPlainObject(qualifications.executionsUsed) || !Object.hasOwn(qualifications.executionsUsed, intent.ref)) return qualifications;
    const used = qualifications.executionsUsed[intent.ref];
    if (!Number.isSafeInteger(used) || used < 1) return qualifications;
    return { ...qualifications, executionsUsed: { ...qualifications.executionsUsed, [intent.ref]: used - 1 } };
}

function defaultSourceState(value) {
    return isPlainObject(value) && Object.hasOwn(value, 'provider') ? null : value;
}

// Every code a front answer can carry.
export function isKnownFrontCode(code) {
    return FRONT_CODES.includes(code) || AVAILABILITY_ERROR_CODES.includes(code)
        || ['unauthorized', 'forbidden', 'unavailable', 'operation_unavailable'].includes(code);
}

// The HTTP listener for the front. Bind it to loopback inside the worker container: the Router's agent-port relay is the
// only intended client, and every request still has to carry a verifiable hop token.
export function serveAdmissionFront(front, { port, host = '127.0.0.1' } = {}) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        let total = 0;
        let oversize = false;
        const reply = (result) => {
            const payload = Buffer.from(JSON.stringify(result.body), 'utf8');
            res.writeHead(result.status, { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
            res.end(payload);
        };
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > BODY_BYTES) oversize = true;
            else chunks.push(chunk);
        });
        req.on('end', () => {
            if (oversize) return reply(refusal(413, 'request', 'invalid_request'));
            const raw = String(req.url || '');
            const queryIndex = raw.indexOf('?');
            const authInfo = req.headers['x-ploinky-auth-info'];
            front.handle({
                authInfo: typeof authInfo === 'string' ? authInfo : undefined, method: String(req.method || ''),
                path: queryIndex < 0 ? raw : raw.slice(0, queryIndex), query: queryIndex < 0 ? '' : raw.slice(queryIndex), body: Buffer.concat(chunks)
            }).then(reply, () => reply(refusal(500, 'internal', 'internal_error')));
        });
        req.on('error', () => res.destroy());
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}
