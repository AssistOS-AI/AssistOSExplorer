import crypto from 'node:crypto';
import { exactObject, isInternalId, isPublicReferenceId } from '../stateProtocol.mjs';

export const CATALOG_MAX_BYTES = 512 * 1024;
export const CATALOG_ERRORS = Object.freeze(['invalid_request', 'catalog_busy', 'catalog_timeout', 'catalog_unavailable', 'catalog_too_large', 'execution_ended']);
export const catalogError = (code) => Object.assign(new Error(code), { code });

// Validate the complete response before it can cross into a workload. Unknown fields are refused, never silently forwarded.
export function validateCatalogResult(result) {
    try {
        if (result?.ok === false) {
            exactObject(result, ['ok', 'error']);
            if (!CATALOG_ERRORS.includes(result.error)) throw catalogError('invalid_request');
        } else {
            exactObject(result, ['ok', 'workflows']);
            if (result.ok !== true || !Array.isArray(result.workflows)) throw catalogError('invalid_request');
            for (const workflow of result.workflows) {
                exactObject(workflow, ['id', 'name', 'description', 'hasDefaultObjective', 'tasks'], ['kind']);
                if (['id', 'name', 'description'].some((key) => typeof workflow[key] !== 'string')
                    || typeof workflow.hasDefaultObjective !== 'boolean' || !Array.isArray(workflow.tasks)
                    || (workflow.kind !== undefined && workflow.kind !== 'default')) throw catalogError('invalid_request');
                for (const task of workflow.tasks) {
                    exactObject(task, ['name'], ['executionType']);
                    if (typeof task.name !== 'string' || (task.executionType !== undefined && !['terminal', 'desktop', 'browser'].includes(task.executionType))) throw catalogError('invalid_request');
                }
            }
        }
        if (Buffer.byteLength(JSON.stringify(result)) > CATALOG_MAX_BYTES) throw catalogError('catalog_too_large');
        return JSON.parse(JSON.stringify(result));
    } catch (error) {
        throw catalogError(error?.code === 'catalog_too_large' ? 'catalog_too_large' : 'invalid_request');
    }
}

// In-memory requests belong to one live worker generation. Recovery deliberately restores none of them.
export function createWorkflowCatalogRequests({ store, clock = { now: Date.now, setTimeout, clearTimeout } }) {
    const attempts = new Map();
    let closed = false;
    const arm = clock.setTimeout ?? setTimeout;
    const disarm = clock.clearTimeout ?? clearTimeout;
    const keyOf = ({ executionId, attemptId }) => `${executionId}:${attemptId}`;
    function settle(attempt, request, result, error) {
        if (!attempt.pending.delete(request.requestId)) return false;
        disarm(request.timer);
        request.signal?.removeEventListener('abort', request.abort);
        if (error) request.reject(catalogError(error));
        else if (result.ok === false) request.reject(catalogError(result.error));
        else request.resolve(result);
        return true;
    }
    function end(attempt) {
        if (attempts.get(keyOf(attempt.binding)) === attempt) attempts.delete(keyOf(attempt.binding));
        for (const request of attempt.pending.values()) settle(attempt, request, null, 'execution_ended');
    }
    function current(attempt) {
        try {
            if (JSON.stringify(store.workflowCatalogBinding(attempt.bindingIds)) === JSON.stringify(attempt.binding)) return true;
        } catch { /* A terminal, changed or foreign binding is no longer a capability. */ }
        end(attempt);
        return false;
    }
    function authorized(context) {
        store.requireWorkflowCatalogCoordinator(context);
    }
    return Object.freeze({
        registerAttempt(bindingIds) {
            if (closed) throw catalogError('execution_ended');
            const binding = store.workflowCatalogBinding(bindingIds);
            const key = keyOf(bindingIds);
            if (attempts.has(key)) throw catalogError('catalog_unavailable');
            const attempt = { bindingIds: { ...bindingIds }, binding, pending: new Map() };
            attempts.set(key, attempt);
            return Object.freeze({
                read({ signal } = {}) {
                    if (closed || attempts.get(key) !== attempt || !current(attempt)) return Promise.reject(catalogError('execution_ended'));
                    if (signal?.aborted) return Promise.reject(catalogError('catalog_unavailable'));
                    if (attempt.pending.size >= 2) return Promise.reject(catalogError('catalog_busy'));
                    return new Promise((resolve, reject) => {
                        const requestId = crypto.randomBytes(16).toString('base64url');
                        const request = { requestId, resolve, reject, deadline: clock.now() + 30000, signal };
                        attempt.pending.set(requestId, request);
                        request.abort = () => settle(attempt, request, null, 'catalog_unavailable');
                        signal?.addEventListener('abort', request.abort, { once: true });
                        request.timer = arm(() => settle(attempt, request, null, 'catalog_timeout'), 30000);
                        request.timer.unref?.();
                    });
                },
                close() { end(attempt); },
            });
        },
        listPending(context) {
            authorized(context);
            const pending = [];
            for (const attempt of attempts.values()) {
                if (!current(attempt) || attempt.binding.coordinator !== context.coordinator) continue;
                for (const request of attempt.pending.values()) {
                    if (clock.now() >= request.deadline) { settle(attempt, request, null, 'catalog_timeout'); continue; }
                    if (pending.length < 16) pending.push({ referenceId: attempt.binding.referenceId, attemptId: attempt.binding.attemptId, requestId: request.requestId });
                }
            }
            return { requests: pending };
        },
        reply(context, input) {
            authorized(context);
            exactObject(input, ['referenceId', 'attemptId', 'requestId', 'result']);
            if (!isPublicReferenceId(input.referenceId) || !isInternalId(input.attemptId) || !isInternalId(input.requestId)) throw catalogError('invalid_request');
            const result = validateCatalogResult(input.result);
            for (const attempt of attempts.values()) {
                if (attempt.binding.referenceId !== input.referenceId || attempt.binding.attemptId !== input.attemptId
                    || attempt.binding.coordinator !== context.coordinator || !current(attempt)) continue;
                const request = attempt.pending.get(input.requestId);
                if (!request) break;
                if (clock.now() >= request.deadline) { settle(attempt, request, null, 'catalog_timeout'); break; }
                return { ok: true, settled: settle(attempt, request, result) };
            }
            return { ok: true, settled: false };
        },
        close() {
            closed = true;
            for (const attempt of attempts.values()) end(attempt);
        },
    });
}
