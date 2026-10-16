/**
 * Per-model request parameters supplied by cascade child settings.
 *
 * @module runtime/backends/model-request-params
 */

// Per-tier cascade children may tune reasoning only; every other request
// field stays under client, provider, and policy control.
const MODEL_REQUEST_PARAM_KEYS = Object.freeze(['reasoning', 'reasoning_effort']);

export function applyModelRequestParams(params, requestParams) {
    if (!requestParams || typeof requestParams !== 'object') return params;
    const next = { ...params };
    for (const key of MODEL_REQUEST_PARAM_KEYS) {
        if (Object.hasOwn(requestParams, key)) next[key] = requestParams[key];
    }
    return next;
}
