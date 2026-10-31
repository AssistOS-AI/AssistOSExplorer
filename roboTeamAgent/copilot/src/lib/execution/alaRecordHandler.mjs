// The handling of one ALA event record. workerEngine feeds it the records the worker relays as
// reference events (RoboTeam runs no local ALA, decision M-5).

export const ALA_BACKENDS = Object.freeze(['codex', 'opencode', 'pi', 'claude']);

// `backend` is the coding agent the turn must run on, or null when it is only known from ALA's
// own selection (the worker decides it from the robot configuration); then any known agent is
// accepted once and fixed for the rest of the turn.
// `bindEngine(agent)` records the selection in the conversation. `reply(id, optionId, owner)` answers a
// native permission request (`optionId` null is the owner's cancel) with the verified owner of the signed
// response that carried the answer (T2: the worker's `answer` control needs that response's own grant).
// `interactions.request` resolves to `{optionId, owner}` for an answer, or null when nothing was answered
// (the turn ended, the request was resolved elsewhere, or the WebChat card timed out): then nothing is
// sent, and the worker's own deadline decides. `fail(error)` ends the turn with an error.
export function createAlaRecordHandler({ backend, permissionMode, efforts = {}, skillExecution = null, sessionId,
    sanitize, emit, interactions, context, signal, turnId, bindEngine, reply, fail }) {
    let expected = backend || null;
    let selected = false;
    let finalText = null;
    let remainingFinals = 1;
    const pendingRequests = new Set();

    async function handle(event) {
        // The wrapper publishes the policy applied to this turn. A pinned envelope may carry an older policy version.
        if (event?.type === 'skill-catalog' && skillExecution) {
            if (/^[a-f0-9]{64}$/.test(skillExecution.catalogId) && event.revision !== skillExecution.revision) throw new Error('ALA received a different execution catalog revision.');
            return;
        }
        if (!event || typeof event.type !== 'string') throw new Error('Malformed mandatory ALA event.');
        if (event.type === 'coding-agent-selected') {
            if (expected === null && ALA_BACKENDS.includes(event.agent)) expected = event.agent;
            if (event.agent !== expected || event.permissionMode !== permissionMode) throw new Error('ALA selected an unexpected backend or permission policy.');
            selected = true;
            event = { ...event, effort: efforts[expected] || null };
            await bindEngine(event.agent);
        } else if (event.type === 'coding-agent-final') {
            if (remainingFinals <= 0 || event.agent !== expected || typeof event.message !== 'string') throw new Error('Malformed or duplicate ALA final event.');
            remainingFinals--;
            finalText = event.message;
        } else if (event.type === 'message-accepted' && event.delivery === 'queued') {
            remainingFinals++;
        } else if (event.type === 'session-ready' && event.sessionId !== sessionId) {
            throw new Error('ALA returned a different conversation UUID.');
        } else if (event.type === 'coding-agent-request') {
            if (typeof event.id !== 'string' || event.agent !== expected || event.kind !== 'permission'
                || !Array.isArray(event.options) || !event.options.length
                || event.options.some((option) => typeof option.id !== 'string' || typeof option.label !== 'string')) {
                throw new Error('Malformed mandatory ALA permission request.');
            }
            if (pendingRequests.has(event.id)) throw new Error('Duplicate native permission request ID.');
            pendingRequests.add(event.id);
            // `reply` may answer {retry: true} when the answer did not reach the worker (no usable grant, a refused or failed control
            // other than "already resolved"): the card is closed by then, so the question is asked again, under a new interaction id,
            // while the request is still pending. Each retry waits for the user, so this cannot spin.
            const ask = () => Promise.resolve().then(() => interactions?.request(sanitize(event), { context, signal, turnId, requireSigned: true }) ?? null)
                .then(async (answer) => {
                    if (answer === null || answer === undefined) return;
                    const { optionId = null, owner = null } = typeof answer === 'object' ? answer : { optionId: answer };
                    if (optionId !== null && !event.options.some((option) => option.id === optionId)) throw new Error('Unadvertised native permission response.');
                    if (!pendingRequests.has(event.id)) return;
                    const outcome = await reply(event.id, optionId, owner);
                    if (outcome?.retry === true && pendingRequests.has(event.id) && !signal?.aborted) await ask();
                });
            ask().catch(fail);
        } else if (event.type === 'coding-agent-request-resolved') {
            pendingRequests.delete(event.id);
            interactions?.resolve(event.id, event.reason);
        }
        // ALA records coding-agent output in its transcript. Progress is delivered as a transient WebChat status, never persisted on the message.
        await emit(event);
    }

    return {
        handle,
        // True once, for a request that is still pending; the caller then writes the answer.
        claimRequest: (id) => pendingRequests.delete(id),
        clearRequests: () => pendingRequests.clear(),
        get selected() { return selected; },
        get finalText() { return finalText; },
        get backend() { return expected; },
    };
}
