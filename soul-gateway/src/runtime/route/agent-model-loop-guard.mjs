/**
 * Route middleware: agent self-recursion loop guard.
 *
 * Ploinky agents are reconciled into Soul Gateway as discovered models
 * (see `src/ploinky/reconcile-agents.mjs`). Each such model carries a
 * `metadata` marker identifying the agent it fronts:
 *
 *     { discoverySource: 'ploinky-agent-discovery', subjectId, repo, agent, ... }
 *
 * Without a guard, an agent that calls the discovered model representing
 * *itself* triggers immediate self-recursion: the gateway dispatches back
 * to the same agent, which can call the same model again, and so on. This
 * middleware blocks that single-hop case before dispatch by comparing the
 * authenticated caller's subject id against the target model's subject id.
 *
 * Scope: this only blocks SAME-subject recursion (A calls A). Cross-agent
 * loops (A -> B -> A) require trace-depth propagation and are intentionally
 * NOT handled here; they remain bounded by rate limits, provider timeouts,
 * and budget controls.
 *
 * Placement: runs AFTER `resolveModel` (so `ctx.metadata.resolvedModel` is
 * populated) and BEFORE `gatewayDispatch` (so no upstream call is made for a
 * self-recursive request).
 *
 * @module runtime/route/agent-model-loop-guard
 */

import { GatewayError } from '../../core/errors.mjs';
import { HTTP_STATUS } from '../../core/constants.mjs';

/** Metadata marker tagging models the Ploinky agent reconciler owns. */
const DISCOVERY_MARKER = 'ploinky-agent-discovery';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function agentModelLoopGuardMiddleware() {
    return async function agentModelLoopGuard(ctx, next) {
        // Caller subject id. The signed-subject API key is the only identity
        // source (see `authenticate.mjs` + `api-key-auth.mjs`): authenticate
        // sets `ctx.auth = { ..., apiKeyRecord }`, and the api-key auth path
        // returns a row merged with `{ subjectId, subjectType, ... }`, so the
        // caller's subject id lives at `ctx.auth.apiKeyRecord.subjectId`.
        // `ctx.identity` is header-derived and never carries a subject id, so
        // the fallbacks below are defensive only.
        const callerSubjectId =
            ctx.auth?.apiKeyRecord?.subjectId ||
            ctx.auth?.subjectId ||
            ctx.identity?.subjectId ||
            null;

        // `ctx.metadata.resolvedModel` is a wrapper built by resolve-model.mjs:
        //   { model, kind, strategyKind, requestedModel, resolvedVia }
        // The model record and its parsed metadata live under `.model`.
        const model = ctx.metadata?.resolvedModel?.model;
        const modelMeta = readModelMetadata(model);
        const targetSubjectId = modelMeta.subjectId;
        const isDiscoveredAgentModel =
            modelMeta.discoverySource === DISCOVERY_MARKER;

        if (
            callerSubjectId &&
            targetSubjectId &&
            isDiscoveredAgentModel &&
            callerSubjectId === targetSubjectId
        ) {
            throw new GatewayError(
                'Agent cannot call its own discovered Soul Gateway model.',
                {
                    httpStatus: HTTP_STATUS.BAD_REQUEST,
                    errorType: 'invalid_request_error',
                }
            );
        }

        return next();
    };
}

/**
 * Read a model record's metadata as a plain object.
 *
 * The snapshot loader exposes `model.metadata` as the parsed JSON object, but
 * be defensive in case a row ever arrives with an unparsed metadata string.
 *
 * @param {object|null|undefined} model
 * @returns {object}
 */
function readModelMetadata(model) {
    const meta = model?.metadata;
    if (!meta) return {};
    if (typeof meta === 'string') {
        try {
            return JSON.parse(meta);
        } catch {
            return {};
        }
    }
    return meta;
}
