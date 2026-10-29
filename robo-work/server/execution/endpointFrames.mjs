// The frame protocol on fd 4, between the provider endpoint and the supervisor (plan section 5.5). The same schema
// is applied on both sides. Frames are JSON objects:
//
//   endpoint -> supervisor, requests: { id, op: 'start' | 'stop' | 'connect' | 'inventory' | 'tempdir', ... }
//   supervisor -> endpoint, answers:  { id, ok: true, value? } or { id, ok: false, kind: 'refused' | 'failure', error }
//   supervisor -> endpoint, events:   { event: 'exit', process, code, signal } | { event: 'report' }
//   endpoint -> supervisor, events:   { event: 'ready', relayPorts } | { event: 'failure', reason } | { event: 'status', ... }

import { virtualPathProblem, validateStartRequest } from './providerSchema.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const keysOf = (object) => Object.keys(object).sort().join(',');
const STREAM_NAMES = Object.freeze(['stderr', 'stdin', 'stdout']);
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;

export function validateEndpointRequest(frame, limits) {
    if (!isPlainObject(frame) || !isCount(frame.id, 1, 1_000_000_000)) return { ok: false, code: 'bad_frame' };
    switch (frame.op) {
        case 'inventory':
        case 'tempdir':
            return keysOf(frame) === 'id,op' ? { ok: true } : { ok: false, code: 'bad_frame' };
        case 'stop':
            return keysOf(frame) === 'graceMs,id,op,process' && isCount(frame.process, 1, 1_000_000)
                && isCount(frame.graceMs, 0, 3_600_000) ? { ok: true } : { ok: false, code: 'bad_frame' };
        case 'connect':
            return keysOf(frame) === 'id,op,port,process' && isCount(frame.process, 1, 1_000_000)
                && isCount(frame.port, 1, 65535) ? { ok: true } : { ok: false, code: 'bad_frame' };
        case 'start': {
            if (keysOf(frame) !== 'id,op,process,request,streams' || !isCount(frame.process, 1, 1_000_000)) {
                return { ok: false, code: 'bad_frame' };
            }
            if (!isPlainObject(frame.streams)) return { ok: false, code: 'bad_frame' };
            const names = Object.keys(frame.streams);
            if (names.length === 0 || names.some((name) => !STREAM_NAMES.includes(name))
                || names.some((name) => virtualPathProblem(frame.streams[name], limits.maxPathBytes))) {
                return { ok: false, code: 'bad_frame' };
            }
            const verdict = validateStartRequest(frame.request, limits);
            return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, message: verdict.message, schema: true };
        }
        default:
            return { ok: false, code: 'bad_frame' };
    }
}

export function validateEndpointEvent(frame) {
    if (!isPlainObject(frame)) return false;
    if (frame.event === 'ready') {
        return keysOf(frame) === 'event,relayPorts' && Array.isArray(frame.relayPorts) && frame.relayPorts.length <= 64
            && frame.relayPorts.every((port) => isCount(port, 1, 65535));
    }
    if (frame.event === 'failure') return keysOf(frame) === 'event,reason' && REASON.test(frame.reason ?? '');
    if (frame.event === 'status') {
        return Object.keys(frame).every((key) => key === 'event' || isCount(frame[key], 0, Number.MAX_SAFE_INTEGER));
    }
    return false;
}

export function validateSupervisorFrame(frame) {
    if (!isPlainObject(frame)) return false;
    if (Object.hasOwn(frame, 'event')) {
        if (frame.event === 'report') return keysOf(frame) === 'event';
        return frame.event === 'exit' && keysOf(frame) === 'code,event,process,signal'
            && isCount(frame.process, 1, 1_000_000)
            && (frame.code === null || Number.isSafeInteger(frame.code))
            && (frame.signal === null || (typeof frame.signal === 'string' && frame.signal.length <= 32));
    }
    if (!isCount(frame.id, 1, 1_000_000_000)) return false;
    if (frame.ok === true) return Object.keys(frame).every((key) => ['id', 'ok', 'value'].includes(key));
    return frame.ok === false && (frame.kind === 'refused' || frame.kind === 'failure')
        && isPlainObject(frame.error) && typeof frame.error.code === 'string' && typeof frame.error.message === 'string'
        && frame.error.code.length <= 64 && frame.error.message.length <= 512;
}
