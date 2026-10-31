import { randomUUID } from 'node:crypto';

import { createWebchatInteractionResolved } from '../../permissions/protocol.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// The longest free-text answer (decision M-30 / M-53 Q3): the Router refuses a longer one before signing; RoboTeam checks it again.
export const ANSWER_MAX_CHARS = 32000;
// The plain messages of a re-ask (T2). A re-ask closes the card and shows the same question under a new interaction id.
export const UNVERIFIED_ANSWER_NOTICE = 'This answer could not be verified, so it was not used. Choose again.';
export const ANSWER_TOO_LONG_NOTICE = 'The answer is too long; shorten it and send again.';

function interactionId() {
    return `task_control_${randomUUID().replaceAll('-', '_')}`;
}

function publicChallenge(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'device_code') {
        return {
            type: 'device_code',
            verificationUri: String(raw.verificationUri || '').slice(0, 4000),
            userCode: String(raw.userCode || '').slice(0, 100),
            instructions: String(raw.instructions || '').slice(0, 2000),
            ...(Number.isFinite(Number(raw.expiresInSeconds)) ? { expiresInSeconds: Number(raw.expiresInSeconds) } : {}),
        };
    }
    if (raw.type === 'manual_oauth_code') {
        return {
            type: 'manual_oauth_code',
            url: String(raw.url || '').slice(0, 4000),
            instructions: String(raw.instructions || '').slice(0, 2000),
        };
    }
    return null;
}

export function createWebchatInteractionController({ stdout = process.stdout, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const pending = new Map();
    const surfaces = new Map();
    let disposed = false;

    function emit(value) {
        stdout.write(`${JSON.stringify(value)}\n`);
    }

    function activate(surface) {
        const queue = surfaces.get(surface);
        const current = queue?.[0];
        if (!current || current.active || disposed) return;
        current.active = true;
        current.timer = setTimeout(() => settle(current, {
            status: 'expired',
            error: new Error('interaction_expired'),
        }), timeoutMs);
        current.timer.unref?.();
        try {
            emit({ __webchatInteraction: 1, version: 1, id: current.id, ...current.envelope });
        } catch (error) {
            settle(current, { status: 'cancelled', error });
        }
    }

    function settle(current, { status = 'resolved', error = null, value, optionId = null } = {}) {
        if (!pending.delete(current.id)) return;
        clearTimeout(current.timer);
        current.signal?.removeEventListener?.('abort', current.abort);
        const queue = surfaces.get(current.surface);
        queue.splice(queue.indexOf(current), 1);
        if (!queue.length) surfaces.delete(current.surface);
        try {
            if (current.active) {
                const { targetTaskId, targetTabId, targetPageInstanceId } = current.envelope;
                emit({
                    ...createWebchatInteractionResolved({ id: current.id, status, optionId }),
                    ...(targetTaskId ? { targetTaskId } : {}),
                    ...(targetTabId ? { targetTabId } : {}),
                    ...(targetPageInstanceId ? { targetPageInstanceId } : {}),
                });
            }
        } finally {
            if (error) current.reject(error);
            else current.resolve(value);
            activate(current.surface);
        }
    }

    // `requireSigned` (T2): only a response that arrived in a Router-signed, verified envelope settles this interaction, and it settles
    // with the verified owner: `{value, owner}` (or `{cancelled: true, owner}` for the owner's cancel). Any other response is not used
    // and the question is asked again under a new interaction id, with a plain notice.
    function request(envelope, { signal, values = null, requireSigned = false } = {}) {
        if (disposed) return Promise.reject(new Error('interaction_controller_closed'));
        if (signal?.aborted) return Promise.reject(new Error('interaction_cancelled'));
        const id = interactionId();
        const surface = JSON.stringify([envelope.targetTabId || '', envelope.targetPageInstanceId || '']);
        return new Promise((resolve, reject) => {
            const current = {
                id, surface, envelope, resolve, reject, values, signal, requireSigned: requireSigned === true,
                active: false, timer: null, input: envelope.input || null,
            };
            current.abort = () => settle(current, {
                status: 'cancelled',
                error: new Error('interaction_cancelled'),
            });
            pending.set(id, current);
            const queue = surfaces.get(surface) || [];
            queue.push(current);
            surfaces.set(surface, queue);
            signal?.addEventListener?.('abort', current.abort, { once: true });
            activate(surface);
        });
    }

    function select({
        title,
        message = '',
        detail = '',
        options,
        searchable = false,
        targetTaskId = '',
        targetTabId = '',
        targetPageInstanceId = '',
        challenge = null,
    }, requestOptions = {}) {
        const normalizedChallenge = publicChallenge(challenge);
        const normalized = (Array.isArray(options) ? options : []).map((option, index) => ({
            id: `choice_${index}`,
            label: String(option?.label || option?.value || ''),
            description: String(option?.description || ''),
            value: option?.value,
            tone: option?.tone === 'danger' ? 'danger' : 'default',
        })).filter((option) => option.label && option.value !== undefined);
        if (!normalized.length) return Promise.reject(new Error('interaction_has_no_options'));
        return request({
            kind: 'select',
            title,
            message,
            detail,
            options: normalized.map(({ value: _value, ...option }) => option),
            defaultOptionId: normalized[0].id,
            searchable: searchable === true,
            ...(targetTaskId ? { targetTaskId } : {}),
            ...(targetTabId ? { targetTabId } : {}),
            ...(targetPageInstanceId ? { targetPageInstanceId } : {}),
            ...(normalizedChallenge ? { challenge: normalizedChallenge } : {}),
        }, {
            ...requestOptions,
            values: new Map(normalized.map((option) => [option.id, option.value])),
        });
    }

    function input({
        title,
        message = '',
        detail = '',
        type = 'text',
        placeholder = '',
        maxLength = 4000,
        targetTaskId = '',
        targetTabId = '',
        targetPageInstanceId = '',
        challenge = null,
    }, requestOptions = {}) {
        const normalizedChallenge = publicChallenge(challenge);
        return request({
            kind: 'input',
            title,
            message,
            detail,
            options: [],
            input: {
                type: type === 'secret' ? 'secret' : 'text',
                placeholder: String(placeholder || ''),
                maxLength: Math.max(1, Math.min(Number(maxLength) || 4000, 65536)),
            },
            ...(targetTaskId ? { targetTaskId } : {}),
            ...(targetTabId ? { targetTabId } : {}),
            ...(targetPageInstanceId ? { targetPageInstanceId } : {}),
            ...(normalizedChallenge ? { challenge: normalizedChallenge } : {}),
        }, requestOptions);
    }

    // Closes the shown card and asks the same question again under a new interaction id (the Router forgets an id once it has forwarded
    // a response for it), keeping the original deadline. `notice` is a plain line shown above the question.
    function reask(current, notice) {
        if (!current.active || pending.get(current.id) !== current) return false;
        const { targetTaskId, targetTabId, targetPageInstanceId } = current.envelope;
        const targets = { ...(targetTaskId ? { targetTaskId } : {}), ...(targetTabId ? { targetTabId } : {}), ...(targetPageInstanceId ? { targetPageInstanceId } : {}) };
        emit({ ...createWebchatInteractionResolved({ id: current.id, status: 'cancelled', optionId: null }), ...targets });
        pending.delete(current.id);
        current.id = interactionId();
        pending.set(current.id, current);
        const message = current.envelope.message ? `${notice}\n\n${current.envelope.message}` : notice;
        try {
            emit({ __webchatInteraction: 1, version: 1, id: current.id, ...current.envelope, message });
        } catch (error) {
            settle(current, { status: 'cancelled', error });
        }
        return true;
    }

    function matchesSource(current, context) {
        if (!context) return true;
        const { targetTabId, targetPageInstanceId } = current.envelope;
        return (!targetTabId || context.sourceTabId === targetTabId)
            && (!targetPageInstanceId || context.sourcePageInstanceId === targetPageInstanceId);
    }

    // `context` carries the response's source tab and page; a Router-signed, verified envelope adds `verified: true` and `owner` (the
    // verified owner evidence). Unsigned legacy lines never carry them.
    function resolve(response, context) {
        const current = pending.get(response?.id);
        if (!current?.active || !matchesSource(current, context)) return false;
        const owner = context?.verified === true && context.owner ? context.owner : null;
        if (current.requireSigned && !owner) {
            reask(current, UNVERIFIED_ANSWER_NOTICE);
            return false;
        }
        const answer = (value) => (current.requireSigned ? { value, owner } : value);
        if (response.cancelled === true) {
            if (response.optionId !== undefined || response.response !== undefined) return false;
            if (current.requireSigned) {
                settle(current, { status: 'cancelled', value: { cancelled: true, owner } });
                return true;
            }
            return cancel(current.id, context);
        }
        if (current.input) {
            if (response.optionId !== undefined || typeof response.response !== 'string') return false;
            // Too long for the answer bound: not used, and never dropped silently: the user is told and asked again.
            if (response.response.length > Math.min(current.input.maxLength, ANSWER_MAX_CHARS)) {
                reask(current, ANSWER_TOO_LONG_NOTICE);
                return false;
            }
            settle(current, { value: answer(response.response) });
            return true;
        }
        if (response.response !== undefined || !current.values?.has(response?.optionId)) return false;
        settle(current, { value: answer(current.values.get(response.optionId)), optionId: response.optionId });
        return true;
    }

    // A response envelope that claimed a Router signature but did not verify (T2): it answers nothing, whatever the interaction, and the
    // question is asked again under a new interaction id. Never a turn.
    function reaskUnverified(id, context) {
        const current = pending.get(id);
        if (!current?.active || !matchesSource(current, context)) return false;
        return reask(current, UNVERIFIED_ANSWER_NOTICE);
    }

    function cancel(id, context) {
        const current = pending.get(id);
        if (!current || !matchesSource(current, context)) return false;
        settle(current, { status: 'cancelled', error: new Error('interaction_cancelled') });
        return true;
    }

    function dispose() {
        disposed = true;
        for (const current of pending.values()) {
            settle(current, { status: 'cancelled', error: new Error('interaction_controller_closed') });
        }
    }

    return {
        select,
        input,
        resolve,
        reaskUnverified,
        cancel,
        dispose,
        get pendingId() {
            for (const current of pending.values()) if (current.active) return current.id;
            return null;
        },
    };
}

export const __testables = { DEFAULT_TIMEOUT_MS };
