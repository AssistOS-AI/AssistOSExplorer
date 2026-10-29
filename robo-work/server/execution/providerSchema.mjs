// Schema and size bounds for the execution-provider wire protocol, version 1 (ALA DS006, plan section 5.3).
//
// This module decides only what a message looks like: exact keys, types and sizes. Whether a well-formed request is
// admitted is a separate decision that the supervisor makes against the admitted specification
// (supervisorRequestValidator.mjs). The endpoint applies this schema before it relays anything, and the supervisor
// applies it again, because the endpoint is not trusted to have done so.

export const PROVIDER_PROTOCOL = 'ala-execution-provider';
export const PROVIDER_PROTOCOL_VERSION = 1;
export const CLIENT_MESSAGE_TYPES = Object.freeze(['hello', 'start', 'stop', 'inventory', 'tempdir', 'connect']);

const MAX_PROCESS_CLASS_BYTES = 32;
const MAX_ENV_NAME_BYTES = 256;
const MAX_GRACE_MS = 3_600_000;
const MAX_LIFECYCLE_MS = 86_400_000;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
const isCount = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
const textProblem = (value, maxBytes) => {
    if (typeof value !== 'string') return 'is not a string';
    if (value.includes('\0')) return 'contains a NUL byte';
    if (Buffer.byteLength(value) > maxBytes) return 'is too long';
    return null;
};

function exactKeys(object, required, optional = []) {
    const keys = Object.keys(object);
    return required.every((key) => Object.hasOwn(object, key))
        && keys.every((key) => required.includes(key) || optional.includes(key));
}

const invalid = (message) => ({ ok: false, code: 'invalid_request', message });

function folderProblem(folder, limits) {
    if (!isPlainObject(folder) || !exactKeys(folder, ['path', 'access'])) return 'folder shape';
    if (textProblem(folder.path, limits.maxPathBytes)) return 'folder path';
    if (folder.access !== 'read' && folder.access !== 'write') return 'folder access';
    return null;
}

function communicationProblem(communication) {
    if (!isPlainObject(communication)) return 'communication';
    if (communication.kind === 'streams') {
        if (!exactKeys(communication, ['kind', 'stdin'])) return 'communication keys';
    } else if (communication.kind === 'service') {
        if (!exactKeys(communication, ['kind', 'endpoint', 'stdin']) || communication.endpoint !== 'loopback-port') {
            return 'communication endpoint';
        }
    } else return 'communication kind';
    return communication.stdin === 'pipe' || communication.stdin === 'ignore' ? null : 'communication stdin';
}

function lifecycleProblem(lifecycle) {
    if (!isPlainObject(lifecycle) || !exactKeys(lifecycle, ['stopGraceMs'], ['deadlineMs', 'ready'])) return 'lifecycle';
    if (!isCount(lifecycle.stopGraceMs, 0, MAX_GRACE_MS)) return 'lifecycle stopGraceMs';
    if (lifecycle.deadlineMs !== undefined && !isCount(lifecycle.deadlineMs, 1, MAX_LIFECYCLE_MS)) return 'lifecycle deadlineMs';
    if (lifecycle.ready !== undefined) {
        const { ready } = lifecycle;
        if (!isPlainObject(ready) || !exactKeys(ready, ['condition', 'timeoutMs'])
            || ready.condition !== 'announced-endpoint' || !isCount(ready.timeoutMs, 1, MAX_LIFECYCLE_MS)) {
            return 'lifecycle ready';
        }
    }
    return null;
}

// The version-1 start request: exactly the fields of DS006 and nothing more.
export function validateStartRequest(request, limits) {
    if (!isPlainObject(request)) return invalid('The start request is not an object');
    const fields = ['processClass', 'executable', 'args', 'env', 'home', 'cwd', 'folders', 'exclusions',
        'communication', 'lifecycle', 'network', 'requirements'];
    if (!exactKeys(request, fields)) return invalid('The start request has missing or unknown fields');
    if (textProblem(request.processClass, MAX_PROCESS_CLASS_BYTES)) return invalid('processClass is not valid');
    if (!request.executable || textProblem(request.executable, limits.maxPathBytes)) return invalid('executable is not valid');
    if (!Array.isArray(request.args) || request.args.length > limits.maxArgs
        || request.args.some((value) => textProblem(value, limits.maxArgBytes))) return invalid('args are not valid');
    if (!isPlainObject(request.env) || Object.keys(request.env).length > limits.maxEnvEntries
        || Object.entries(request.env).some(([name, value]) => !name || textProblem(name, MAX_ENV_NAME_BYTES)
            || textProblem(value, limits.maxEnvValueBytes))) return invalid('env is not valid');
    if (textProblem(request.home, limits.maxPathBytes)) return invalid('home is not valid');
    if (textProblem(request.cwd, limits.maxPathBytes)) return invalid('cwd is not valid');
    if (!Array.isArray(request.folders) || request.folders.length > limits.maxFolders
        || request.folders.some((folder) => folderProblem(folder, limits))) return invalid('folders are not valid');
    if (!Array.isArray(request.exclusions) || request.exclusions.length > limits.maxExclusions
        || request.exclusions.some((value) => textProblem(value, limits.maxPathBytes))) return invalid('exclusions are not valid');
    if (communicationProblem(request.communication)) return invalid('communication is not valid');
    if (lifecycleProblem(request.lifecycle)) return invalid('lifecycle is not valid');
    if (textProblem(request.network, MAX_PROCESS_CLASS_BYTES)) return invalid('network is not valid');
    if (!isPlainObject(request.requirements) || !exactKeys(request.requirements, ['privateProc'])
        || typeof request.requirements.privateProc !== 'boolean') return invalid('requirements are not valid');
    // The whole encoded request is bounded, so any request that passes always fits a frame (executionLimits.mjs).
    if (Buffer.byteLength(JSON.stringify(request)) > limits.maxRequestBytes) return invalid('The start request is too large');
    return { ok: true };
}

// A client message other than the handshake. `id` and `process` are small positive integers that the client picks.
export function validateClientMessage(message, limits) {
    if (!isPlainObject(message) || typeof message.type !== 'string') return invalid('The message is not an object with a type');
    switch (message.type) {
        case 'hello':
            if (!exactKeys(message, ['type', 'protocol', 'versions'])) return invalid('hello has missing or unknown fields');
            if (message.protocol !== PROVIDER_PROTOCOL) return invalid('hello names another protocol');
            if (!Array.isArray(message.versions) || message.versions.length === 0 || message.versions.length > 8
                || message.versions.some((version) => !isCount(version, 1, 1_000_000))) return invalid('hello versions are not valid');
            return { ok: true };
        case 'start':
            if (!exactKeys(message, ['type', 'process', 'request'])) return invalid('start has missing or unknown fields');
            if (!isCount(message.process, 1, 1_000_000)) return invalid('start process is not valid');
            return validateStartRequest(message.request, limits);
        case 'stop':
            if (!exactKeys(message, ['type', 'process', 'graceMs'])) return invalid('stop has missing or unknown fields');
            if (!isCount(message.process, 1, 1_000_000) || !isCount(message.graceMs, 0, MAX_GRACE_MS)) return invalid('stop is not valid');
            return { ok: true };
        case 'inventory':
        case 'tempdir':
            if (!exactKeys(message, ['type', 'id'])) return invalid(`${message.type} has missing or unknown fields`);
            return isCount(message.id, 1, 1_000_000_000) ? { ok: true } : invalid(`${message.type} id is not valid`);
        case 'connect': {
            if (!exactKeys(message, ['type', 'id', 'process', 'endpoint'])) return invalid('connect has missing or unknown fields');
            if (!isCount(message.id, 1, 1_000_000_000) || !isCount(message.process, 1, 1_000_000)) return invalid('connect ids are not valid');
            const { endpoint } = message;
            if (!isPlainObject(endpoint)) return invalid('connect endpoint is not valid');
            if (endpoint.kind === 'loopback-port') {
                if (!exactKeys(endpoint, ['kind', 'host', 'port']) || endpoint.host !== '127.0.0.1'
                    || !isCount(endpoint.port, 1, 65535)) return invalid('connect endpoint is not valid');
                return { ok: true };
            }
            if (endpoint.kind === 'unix-socket') {
                if (!exactKeys(endpoint, ['kind', 'path']) || textProblem(endpoint.path, limits.maxPathBytes)) {
                    return invalid('connect endpoint is not valid');
                }
                return { ok: true };
            }
            return invalid('connect endpoint kind is not valid');
        }
        default:
            return { ok: false, code: 'unknown_message_type', message: 'The message type is not part of the protocol' };
    }
}

// A normalized absolute virtual path: no empty, "." or ".." segment, no trailing slash, no control character.
export function virtualPathProblem(value, maxBytes = 1024) {
    const text = textProblem(value, maxBytes);
    if (text) return `path ${text}`;
    if (!value.startsWith('/')) return 'path is not absolute';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/u.test(value)) return 'path contains a control character or backslash';
    if (value === '/') return null;
    const segments = value.slice(1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'path is not normalized';
    return null;
}
