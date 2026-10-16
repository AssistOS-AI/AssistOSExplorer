/**
 * Finalize model-result middleware.
 *
 * Runs after the attempt subchain (direct dispatch) or the cascade
 * subchain has populated `ctx.response` with either a buffered
 * completion shape (`{ message, usage, ... }`) or a `CanonicalStream`.
 * Translates the buffered shape into the OpenAI chat-completion
 * envelope (`{ id, object, model, choices, usage }`) that the
 * route-level `respondMiddleware` expects to serialize.
 *
 * For cascade dispatches the envelope's `model` field is the leaf
 * model that actually answered (read from `ctx.metadata.cascadeModel`).
 * For direct dispatches it is `ctx.target.model`.
 *
 * In streaming mode (`ctx.response` is a `CanonicalStream`) this
 * middleware leaves the response untouched and instead flags
 * `ctx.metadata.streamingResponse = true` so `respondMiddleware`
 * takes the SSE branch.
 *
 * Reads:
 *   - `ctx.response`
 *   - `ctx.target.model`
 *   - `ctx.metadata.cascadeModel` (when present)
 *
 * Writes:
 *   - `ctx.response` (chat completion envelope, in buffered mode)
 *   - `ctx.metadata.streamingResponse`
 *
 * @module runtime/execution/finalize-direct-result-middleware
 */

import { isCanonicalStream } from '../kernel/index.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function finalizeDirectResultMiddleware() {
    return async function finalizeDirectResult(ctx, next) {
        await next();

        const collected = ctx.response;
        if (!collected) return;

        // Streaming branch — leave the canonical stream alone for
        // `respondMiddleware`.  Stream envelopes are objects that carry a
        // `.stream` CanonicalStream property; both shapes are passed
        // through unchanged.
        if (
            isCanonicalStream(collected) ||
            (collected.stream && isCanonicalStream(collected.stream))
        ) {
            ctx.metadata.streamingResponse = true;
            return;
        }

        // If the response already looks like a chat completion envelope,
        // leave it alone.  This avoids re-wrapping when something upstream
        // has already shaped it.
        if (Array.isArray(collected.choices)) return;

        // Prefer the cascade-leaf model when one was recorded so the
        // envelope reports the model that actually answered.
        const leafModel = ctx.metadata.cascadeModel || ctx.target?.model || {};
        const modelKey = leafModel.modelKey || leafModel.model_key || null;

        ctx.response = {
            id: ctx.requestId,
            object: 'chat.completion',
            model: modelKey,
            choices: [
                {
                    index: 0,
                    message: collected.message,
                    finish_reason: collected.finishReason || 'stop',
                },
            ],
            usage: {
                prompt_tokens: collected.usage?.input_tokens ?? 0,
                completion_tokens: collected.usage?.output_tokens ?? 0,
                total_tokens: collected.usage?.total_tokens ?? 0,
            },
        };
    };
}
