import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifiedDirectUser } from '../../../../server/listing-access.mjs';
import { createWorkerCoordinatorHop } from '../../../../server/worker-coordinator/hop.mjs';
import { WebchatOriginStore } from '../../../../server/worker-coordinator/webchat-origins.mjs';
import { errorResult, mapHopOutcome, refusal } from '../../../../server/worker-coordinator/errors.mjs';
import { grantForPrincipal, isInternalId, isOperationId, isReferenceId, newOriginId } from '../../../../server/worker-coordinator/identities.mjs';

// The WebChat row of the worker coordinator (design S3c §6.5 with E12 §2/§7). Owner evidence is
// only a Router-signed `__webchat_message__` token that this process verifies itself over the
// rebuilt signed arguments (including `runtimeScope` and `event`); the grant is the token's own
// signed `providerAdmission` entry naming the same user, held in memory only. Every token is
// verified once: the result is kept per message, so later operations on the same message reuse
// it instead of meeting the replay cache.
//
// A runtime serves one principal (principal runtime scope). The first verified user fixes the
// process principal; a verified envelope for any other user is refused for coordinator
// operations (`runtime_principal_mismatch`, diagnostics only).
//
// Without evidence, a grant or a verifier, every operation refuses with
// `owner_evidence_unavailable` and persists and sends nothing. That includes the operator's
// native terminal, which has no Router-signed envelope (design D1, interim).

const WEBCHAT_TOOL = '__webchat_message__';
export const WEBCHAT_RUNTIME_OPEN_EVENT = 'runtime-open';
const TERMINAL_STATES = new Set(['completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted']);
const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const CONTROL_OP = /^[a-z][a-z-]{0,31}$/u;
const REFUSED = Object.freeze({ ok: false, code: 'owner_evidence_unavailable' });

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exactKeys(value, required, optional = []) {
    if (!isPlainObject(value)) return false;
    const allowed = new Set([...required, ...optional]);
    return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

// The Agent runtime's Router Request verifier for WebChat tokens, with every jti retained for
// the whole acceptance window (exp plus clock skew plus one second). Null when unavailable.
export async function loadWebchatVerifier(env = process.env, { log = () => {} } = {}) {
    const runtimeRoot = env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent';
    let auth, hash, jwt;
    try {
        const load = (relative) => import(pathToFileURL(path.resolve(runtimeRoot, relative)).href);
        [auth, hash, jwt] = await Promise.all([load('lib/invocationAuth.mjs'), load('lib/requestHash.mjs'), load('lib/jwtVerify.mjs')]);
    } catch {
        log('webchat.coordinator.verifier.unavailable', { reason: 'modules' });
        return null;
    }
    if (typeof auth.verifyRouterRequestFromHeaders !== 'function' || typeof hash.computeRchTool !== 'function'
        || typeof jwt.createMemoryReplayCache !== 'function') {
        log('webchat.coordinator.verifier.unavailable', { reason: 'modules' });
        return null;
    }
    if (!String(env.PLOINKY_AGENT_SECRET || '').trim() || !String(env.PLOINKY_AGENT_ID || '').trim()) {
        log('webchat.coordinator.verifier.unavailable', { reason: 'identity' });
        return null;
    }
    const skewMs = ((Number.isFinite(jwt.DEFAULT_CLOCK_SKEW_SECONDS) ? jwt.DEFAULT_CLOCK_SKEW_SECONDS : 30) + 1) * 1000;
    const cache = jwt.createMemoryReplayCache({ maxSize: 4096 });
    const replayCache = {
        seen: (jti) => cache.seen(jti),
        remember: (jti, ttlMs) => cache.remember(jti, Math.max(1, Number(ttlMs) || 1) + skewMs),
    };
    return (token, args) => auth.verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env, replayCache, method: 'POST', path: '/mcp', tool: WEBCHAT_TOOL,
        rch: hash.computeRchTool({ method: 'POST', path: '/mcp', tool: WEBCHAT_TOOL, arguments: args }),
    });
}

function taskRefId(taskRef) {
    const id = typeof taskRef === 'string' ? taskRef : taskRef?.id;
    return isReferenceId(id) ? id : null;
}

export function createWebchatCoordinator({ hop = null, store = null, verifier = null, log = () => {} } = {}) {
    const verified = new WeakMap();
    let processPrincipal = null;

    function verify(message) {
        if (typeof verifier !== 'function') return REFUSED;
        const token = message.invocationToken;
        const args = message.signedArgs;
        if (typeof token !== 'string' || !token || !isPlainObject(args)) return REFUSED;
        let result;
        try {
            result = verifier(token, args);
        } catch {
            return REFUSED;
        }
        if (!result?.ok || !verifiedDirectUser(result.payload)) return REFUSED;
        const payload = result.payload;
        const principal = payload.actor.id;
        if (processPrincipal === null) processPrincipal = principal;
        if (processPrincipal !== principal) {
            log('webchat.coordinator.runtime_principal_mismatch', {});
            return Object.freeze({ ok: false, code: 'runtime_principal_mismatch' });
        }
        return Object.freeze({
            ok: true,
            principal,
            roles: Array.isArray(payload.actor.roles) ? payload.actor.roles.map(String) : [],
            grant: grantForPrincipal(payload.delegations, principal),
            event: typeof args.event === 'string' ? args.event : '',
            tabId: typeof args.tabId === 'string' ? args.tabId : '',
            pageInstanceId: typeof args.pageInstanceId === 'string' ? args.pageInstanceId : '',
        });
    }

    // {ok: true, principal, roles, grant | null, event, tabId, pageInstanceId} or {ok: false, code}.
    function evidenceFor(message) {
        if (!message || typeof message !== 'object') return REFUSED;
        if (!verified.has(message)) verified.set(message, verify(message));
        return verified.get(message);
    }

    const hasGrant = (evidence) => evidence?.ok === true && typeof evidence.grant === 'string' && evidence.grant.length > 0
        && typeof evidence.principal === 'string' && /^user:.+/u.test(evidence.principal);

    async function reattachRow(row, grant) {
        if (row.state === 'admitted') {
            // A kept row (not terminal, read failed, or no reference) is re-stamped so admitted rows rotate.
            const id = taskRefId(JSON.parse(row.task_ref || 'null'));
            if (!id) {
                store.touch(row);
                return;
            }
            const read = await hop.call(`references/${id}/read`, {}, { grant });
            const done = (read.outcome === 'response' && !read.refusal && read.status === 404)
                || (read.outcome === 'response' && !read.refusal && read.status === 200 && TERMINAL_STATES.has(read.json?.state));
            if (done) store.remove(row.origin_request_id, 'admitted');
            else store.touch(row);
            return;
        }
        const release = () => store.settle(row.origin_request_id, 'unknown', ['sent']);
        try {
            const lookup = await hop.call('lookup', { originRequestId: row.origin_request_id }, { grant });
            if (lookup.outcome === 'response' && !lookup.refusal && lookup.status === 200) {
                store.settle(row.origin_request_id, 'admitted', ['sent', 'unknown', 'persisted'], { taskRef: lookup.json?.taskRef ?? null });
                return;
            }
            if (!(lookup.outcome === 'response' && !lookup.refusal && lookup.status === 404)) {
                release();
                return;
            }
            // Not admitted: transmit the stored bytes once more, with this envelope's grant.
            const retry = await hop.call('admissions', row.admission_body, { grant });
            if (retry.outcome === 'response' && !retry.refusal && retry.status === 200) {
                store.settle(row.origin_request_id, 'admitted', ['sent', 'unknown', 'persisted'], { taskRef: retry.json?.taskRef ?? null });
            } else if (retry.outcome === 'response') {
                store.settle(row.origin_request_id, 'refused', ['sent'], { error: mapHopOutcome(retry).body.error });
            } else {
                release();
            }
        } catch {
            release();
        }
    }

    // Recovers this user's in-flight origins: per envelope, at most one batch of recovery rows
    // and one batch of admitted follow-ups (WebchatOriginStore.candidates). Each recovery row is
    // selected once, then claimed by compare-and-set right before its hop; a row another
    // process claimed first is skipped.
    async function reattach(evidence) {
        if (!hasGrant(evidence) || !hop || !store) return { attempted: 0 };
        let rows;
        try {
            rows = store.candidates(evidence.principal);
        } catch {
            log('webchat.coordinator.store.unavailable', {});
            return { attempted: 0 };
        }
        let attempted = 0;
        for (const row of rows) {
            try {
                if (row.state !== 'admitted' && !store.claim(row)) continue;
                attempted += 1;
                await reattachRow(row, evidence.grant);
            } catch {
                log('webchat.coordinator.reattach.failed', {});
            }
        }
        return { attempted };
    }

    // Called for every Router-signed envelope before any turn handling. Returns the verified
    // event ('' when none or unverified) and the reattachment promise.
    function onEnvelope(message) {
        const evidence = evidenceFor(message);
        if (!evidence.ok) return { event: '', done: Promise.resolve({ attempted: 0 }) };
        const done = hasGrant(evidence) ? reattach(evidence).catch(() => ({ attempted: 0 })) : Promise.resolve({ attempted: 0 });
        return { event: evidence.event, done };
    }

    // Admits task work for the verified user. The origin row is persisted before the first
    // transmission. Not called by the WebChat dispatcher until turn conversion (S6).
    async function admit(evidence, request) {
        if (!hasGrant(evidence)) return refusal('owner_evidence_unavailable');
        if (!exactKeys(request, ['conversationId', 'robotId', 'configRevision', 'kind', 'specification'], ['logicalId'])) return refusal('invalid_request');
        if (request.kind !== 'task' && request.kind !== 'continuation') return refusal('logical_kind_unavailable');
        if (typeof request.conversationId !== 'string' || !CONVERSATION_ID.test(request.conversationId) || !isInternalId(request.robotId)
            || !Number.isSafeInteger(request.configRevision) || request.configRevision < 1 || !isPlainObject(request.specification)
            || (request.kind === 'task' && request.logicalId !== undefined) || (request.kind === 'continuation' && !isInternalId(request.logicalId))) {
            return refusal('invalid_request');
        }
        if (!hop || !store) return refusal('worker_coordinator_unavailable');
        const originRequestId = newOriginId();
        const body = JSON.stringify({ originRequestId, robotId: request.robotId, configRevision: request.configRevision, kind: request.kind,
            specification: request.specification, ...(request.kind === 'continuation' ? { logical: { logicalId: request.logicalId } } : {}) });
        return transmit(evidence, originRequestId, request.conversationId, body);
    }

    // Admits one WebChat turn as session work for the verified user (S6 delta Part C, interface
    // note §2.3(9) "Turn admission"): the conversation ID is the worker session key. Same
    // evidence, persistence, outcome mapping and lost-reply recovery as admit. Not called by the
    // WebChat dispatcher until turn conversion.
    async function admitTurn(evidence, request) {
        if (!hasGrant(evidence)) return refusal('owner_evidence_unavailable');
        if (!exactKeys(request, ['conversationId', 'robotId', 'configRevision', 'specification'])) return refusal('invalid_request');
        if (typeof request.conversationId !== 'string' || !CONVERSATION_ID.test(request.conversationId) || !isInternalId(request.robotId)
            || !Number.isSafeInteger(request.configRevision) || request.configRevision < 1 || !isPlainObject(request.specification)) {
            return refusal('invalid_request');
        }
        if (!hop || !store) return refusal('worker_coordinator_unavailable');
        const originRequestId = newOriginId();
        const body = JSON.stringify({ originRequestId, robotId: request.robotId, configRevision: request.configRevision, kind: 'turn',
            logical: { sessionKey: request.conversationId }, specification: request.specification });
        return transmit(evidence, originRequestId, request.conversationId, body);
    }

    // Persists the origin row, then sends the admission once with the envelope grant and maps
    // the outcome: a reference settles `admitted`, an unknown outcome stays recoverable as
    // `unknown`, and a complete refusal settles `refused`.
    async function transmit(evidence, originRequestId, conversationId, body) {
        try {
            const inserted = store.insertPersisted({ originRequestId, principal: evidence.principal, tabId: evidence.tabId || '',
                conversationId, digest: crypto.createHash('sha256').update(body).digest('hex'), body });
            if (!inserted.ok) return refusal(inserted.code);
        } catch {
            log('webchat.coordinator.store.unavailable', {});
            return refusal('worker_coordinator_unavailable');
        }
        let outcome;
        try {
            outcome = await hop.call('admissions', body, { grant: evidence.grant });
        } catch (error) {
            const result = errorResult(error);
            store.settle(originRequestId, 'refused', ['persisted', 'sent'], { error: result.body.error });
            return result;
        }
        if (outcome.outcome === 'response' && !outcome.refusal && outcome.status === 200) {
            store.settle(originRequestId, 'admitted', ['persisted', 'sent', 'unknown'], { taskRef: outcome.json?.taskRef ?? null });
            return { status: 200, body: outcome.json };
        }
        if (outcome.outcome === 'unknown') {
            store.settle(originRequestId, 'unknown', ['persisted', 'sent']);
            return refusal('worker_reply_unknown', { originRequestId });
        }
        const mapped = mapHopOutcome(outcome);
        store.settle(originRequestId, 'refused', ['persisted', 'sent'], { error: mapped.body.error });
        return mapped;
    }

    // Relays a user control on a reference with the envelope grant.
    async function control(evidence, taskRef, request) {
        if (!hasGrant(evidence)) return refusal('owner_evidence_unavailable');
        const id = taskRefId(taskRef);
        if (!id || !exactKeys(request, ['operationId', 'op'], ['attemptId', 'payload']) || !isOperationId(request.operationId)
            || typeof request.op !== 'string' || !CONTROL_OP.test(request.op)
            || (request.attemptId !== undefined && !isInternalId(request.attemptId))) return refusal('invalid_request');
        if (!hop) return refusal('worker_coordinator_unavailable');
        const body = { operationId: request.operationId, op: request.op,
            ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
            ...(request.payload !== undefined ? { payload: request.payload } : {}) };
        try {
            return mapHopOutcome(await hop.call(`references/${id}/control`, body, { grant: evidence.grant }));
        } catch (error) {
            return errorResult(error);
        }
    }

    return Object.freeze({ evidenceFor, onEnvelope, reattach, admit, admitTurn, control, close: () => store?.close() });
}

// The production coordinator of one WebChat runtime process: the Agent verifier, the private
// coordinator hop and the shared origin store. Each fails closed on first use when unavailable.
export async function createRuntimeWebchatCoordinator({ env = process.env, log = () => {} } = {}) {
    return createWebchatCoordinator({
        hop: createWorkerCoordinatorHop({ env }),
        store: new WebchatOriginStore(),
        verifier: await loadWebchatVerifier(env, { log }),
        log,
    });
}
