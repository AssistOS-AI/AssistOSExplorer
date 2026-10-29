import crypto from 'node:crypto';

// Existing-agent execution-target contract (T0 freeze: base + amendments A1 and A2).
//
// Strict schemas, canonical encoding and digests for the private target documents. Every validator is pure: it performs
// no I/O, never throws for a malformed input and returns exactly {ok: true, value} with a deeply frozen copy of the
// validated value, or exactly {ok: false, error: {code}} with an enumerated code and nothing else (no input, path,
// token or exception text). These codes are private to the target contract; they never extend the S1 error classes.
//
// Check order inside a validator (documented so that the shared vectors are deterministic in both repositories):
//   1. canonical encoding of the whole value (non-JSON values, floats, -0, unsafe integers, depth: invalid_request;
//      lone surrogates and non-ASCII object keys: noncanonical_encoding);
//   2. the document size bound (capacity_exceeded);
//   3. per object, top-down in declared field order: plain object (invalid_request), then `version` when the object is
//      versioned (missing or not exactly the number 1: unsupported_version), then the exact key set (invalid_request),
//      then each field; an array over its count bound is capacity_exceeded, under its minimum invalid_request; an
//      unsorted or duplicate collection is invalid_request.

export const CONTRACT_ERROR_CODES = Object.freeze([
    'invalid_request', 'unsupported_version', 'noncanonical_encoding', 'capacity_exceeded', 'required_channel_missing',
    'peer_trust_unaccepted', 'peer_authority_exposed', 'descriptor_role', 'descriptor_count', 'descriptor_identity'
]);

const MAX_NESTING = 16;
const OBJECT_BYTES = 65536;
const CLOSURE_BYTES = 64 * 1024 * 1024;
// A receipt with 512 resource entries and 64 cursors does not fit the 64 KiB object bound; receipts and start outcomes
// are bounded at 256 KiB instead (explicit larger bound, base §2).
export const RECEIPT_BYTES = 256 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const FIXTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

class Refusal {
    constructor(code) { this.code = code; }
}

function refuse(code) {
    throw new Refusal(code);
}

function need(condition, code = 'invalid_request') {
    if (!condition) refuse(code);
}

// Runs a throwing check and converts it into the common result shape. Anything that is not a Refusal is a bug in this
// module or a hostile input object (for example a throwing proxy) and is reported as invalid_request.
export function asResult(check) {
    try {
        return Object.freeze({ ok: true, value: check() });
    } catch (error) {
        const code = error instanceof Refusal ? error.code : 'invalid_request';
        return failure(code);
    }
}

export function failure(code) {
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

export function success(value) {
    return Object.freeze({ ok: true, value: deepFreeze(value) });
}

export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

// ---- Canonical JSON -------------------------------------------------------------------------------------------------

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function ownDataKeys(value) {
    if (Object.getOwnPropertySymbols(value).length > 0) refuse('invalid_request');
    const names = Object.getOwnPropertyNames(value);
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refuse('invalid_request');
    }
    return names;
}

function encode(value, depth) {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'string':
            if (!value.isWellFormed()) refuse('noncanonical_encoding');
            return JSON.stringify(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isSafeInteger(value) || Object.is(value, -0)) refuse('invalid_request');
            return String(value);
        case 'object': {
            if (depth + 1 > MAX_NESTING) refuse('invalid_request');
            if (Array.isArray(value)) {
                if (Object.getPrototypeOf(value) !== Array.prototype) refuse('invalid_request');
                if (Object.getOwnPropertySymbols(value).length > 0) refuse('invalid_request');
                if (Object.getOwnPropertyNames(value).length !== value.length + 1) refuse('invalid_request');
                const parts = [];
                for (let index = 0; index < value.length; index += 1) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, index);
                    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refuse('invalid_request');
                    parts.push(encode(descriptor.value, depth + 1));
                }
                return `[${parts.join(',')}]`;
            }
            if (!isPlainObject(value)) refuse('invalid_request');
            const keys = ownDataKeys(value);
            for (const key of keys) {
                if (!/^[\x00-\x7f]*$/.test(key)) refuse('noncanonical_encoding');
            }
            keys.sort();
            return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`).join(',')}}`;
        }
        default:
            return refuse('invalid_request');
    }
}

function encodeBounded(value, maxBytes) {
    const text = encode(value, 0);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) refuse('capacity_exceeded');
    return text;
}

function boundOption(options) {
    if (options === undefined) return OBJECT_BYTES;
    need(isPlainObject(options) && Object.keys(options).every((key) => key === 'maxBytes'));
    const max = options.maxBytes === undefined ? OBJECT_BYTES : options.maxBytes;
    need(Number.isSafeInteger(max) && max > 0 && max <= CLOSURE_BYTES);
    return max;
}

// Canonical target JSON text of a JSON value: {ok, value: string}. `options.maxBytes` (default 64 KiB, at most 64 MiB).
export function canonicalTargetJson(value, options) {
    return asResult(() => encodeBounded(value, boundOption(options)));
}

// Lowercase hex SHA-256 over the canonical UTF-8 bytes: {ok, value: digest}.
export function targetDigest(value, options) {
    return asResult(() => sha256Hex(encodeBounded(value, boundOption(options))));
}

export function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

// Internal throwing forms, for the sibling modules.
export function canonicalText(value, maxBytes = OBJECT_BYTES) {
    return encodeBounded(value, maxBytes);
}

export function digestOf(value, maxBytes = OBJECT_BYTES) {
    return sha256Hex(encodeBounded(value, maxBytes));
}

// ---- Strict wire parser ---------------------------------------------------------------------------------------------

// Parses canonical target JSON text. `text` is a string or UTF-8 bytes. Refusals: a BOM, invalid UTF-8, a lone surrogate,
// a syntax error, a duplicate key, or any text that differs from the canonical encoding of the parsed value (whitespace,
// key order, escapes) is noncanonical_encoding; a fraction, exponent, -0 or an integer outside the safe range, and nesting
// deeper than 16, are invalid_request; text over `options.maxBytes` (default 64 KiB) is capacity_exceeded. Duplicate keys
// are detected while parsing, before an ordinary object is built.
export function parseCanonicalTargetJson(text, options) {
    return asResult(() => {
        const maxBytes = boundOption(options);
        let source;
        if (typeof text === 'string') {
            need(Buffer.byteLength(text, 'utf8') <= maxBytes || !text.isWellFormed(), 'capacity_exceeded');
            if (!text.isWellFormed()) refuse('noncanonical_encoding');
            source = text;
        } else if (text instanceof Uint8Array) {
            need(text.length <= maxBytes, 'capacity_exceeded');
            if (text.length >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) refuse('noncanonical_encoding');
            try {
                source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(text);
            } catch {
                return refuse('noncanonical_encoding');
            }
        } else {
            return refuse('invalid_request');
        }
        if (source.charCodeAt(0) === 0xfeff) refuse('noncanonical_encoding');
        const value = new StrictParser(source).parseDocument();
        if (encode(value, 0) !== source) refuse('noncanonical_encoding');
        return deepFreeze(value);
    });
}

class StrictParser {
    constructor(text) {
        this.text = text;
        this.index = 0;
    }

    parseDocument() {
        this.skipSpace();
        const value = this.parseValue(0);
        this.skipSpace();
        if (this.index !== this.text.length) refuse('noncanonical_encoding');
        return value;
    }

    skipSpace() {
        while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index])) this.index += 1;
    }

    parseValue(depth) {
        const char = this.text[this.index];
        if (char === '{') return this.parseObject(depth + 1);
        if (char === '[') return this.parseArray(depth + 1);
        if (char === '"') return this.parseString();
        if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();
        for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
            if (this.text.startsWith(literal, this.index)) {
                this.index += literal.length;
                return value;
            }
        }
        return refuse('noncanonical_encoding');
    }

    parseObject(depth) {
        if (depth > MAX_NESTING) refuse('invalid_request');
        this.index += 1;
        const result = {};
        const seen = new Set();
        this.skipSpace();
        if (this.text[this.index] === '}') { this.index += 1; return result; }
        for (;;) {
            this.skipSpace();
            if (this.text[this.index] !== '"') refuse('noncanonical_encoding');
            const key = this.parseString();
            if (seen.has(key)) refuse('noncanonical_encoding');
            seen.add(key);
            this.skipSpace();
            if (this.text[this.index] !== ':') refuse('noncanonical_encoding');
            this.index += 1;
            this.skipSpace();
            const value = this.parseValue(depth);
            Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
            this.skipSpace();
            const next = this.text[this.index];
            this.index += 1;
            if (next === '}') return result;
            if (next !== ',') refuse('noncanonical_encoding');
        }
    }

    parseArray(depth) {
        if (depth > MAX_NESTING) refuse('invalid_request');
        this.index += 1;
        const result = [];
        this.skipSpace();
        if (this.text[this.index] === ']') { this.index += 1; return result; }
        for (;;) {
            this.skipSpace();
            result.push(this.parseValue(depth));
            this.skipSpace();
            const next = this.text[this.index];
            this.index += 1;
            if (next === ']') return result;
            if (next !== ',') refuse('noncanonical_encoding');
        }
    }

    parseString() {
        this.index += 1;
        let out = '';
        for (;;) {
            if (this.index >= this.text.length) refuse('noncanonical_encoding');
            const char = this.text[this.index];
            const code = char.charCodeAt(0);
            if (char === '"') { this.index += 1; break; }
            if (code < 0x20) refuse('noncanonical_encoding');
            if (char !== '\\') { out += char; this.index += 1; continue; }
            const escape = this.text[this.index + 1];
            const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (Object.hasOwn(simple, escape)) {
                out += simple[escape];
                this.index += 2;
            } else if (escape === 'u') {
                const hex = this.text.slice(this.index + 2, this.index + 6);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) refuse('noncanonical_encoding');
                out += String.fromCharCode(Number.parseInt(hex, 16));
                this.index += 6;
            } else {
                refuse('noncanonical_encoding');
            }
        }
        if (!out.isWellFormed()) refuse('noncanonical_encoding');
        return out;
    }

    parseNumber() {
        const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(this.index));
        if (!match) refuse('noncanonical_encoding');
        this.index += match[0].length;
        if (match[2] !== undefined || match[3] !== undefined) refuse('invalid_request');
        if (match[0] === '-0') refuse('invalid_request');
        const value = Number(match[0]);
        if (!Number.isSafeInteger(value)) refuse('invalid_request');
        return value;
    }
}

// ---- Primitive types ------------------------------------------------------------------------------------------------

const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REF_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/;
const LOWER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const BACKEND_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const GRANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const U64_MAX = 18446744073709551615n;

export function isId(value) {
    return typeof value === 'string' && BASE64URL_22.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function isOperationId(value) {
    return typeof value === 'string' && BASE64URL_22.test(value);
}

export function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}

function hasControl(value) {
    return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isOpaqueIdentity(value) {
    return typeof value === 'string' && value.isWellFormed() && utf8Bytes(value) >= 1 && utf8Bytes(value) <= 200
        && !hasControl(value) && !/\s/u.test(value);
}

export function isRef(value) {
    if (typeof value !== 'string') return false;
    const parts = value.split('/');
    return parts.length === 2 && parts.every((part) => REF_COMPONENT.test(part) && part !== '.' && part !== '..');
}

export function isPrincipal(value) {
    return typeof value === 'string' && value.startsWith('agent:') && isRef(value.slice('agent:'.length));
}

export function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}

function isImageDigest(value) {
    return typeof value === 'string' && value.startsWith('sha256:') && isDigest(value.slice(7));
}

export function isCounter(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveCounter(value) {
    return Number.isSafeInteger(value) && value >= 1;
}

export function isU64Text(value) {
    return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= U64_MAX;
}

export function isPositiveU64Text(value) {
    return isU64Text(value) && value !== '0';
}

export function isContainerId(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isLowerId(value) {
    return typeof value === 'string' && LOWER_ID.test(value);
}

function isGrantId(value) {
    return typeof value === 'string' && GRANT_ID.test(value);
}

// Bounded display/version text: 1-`max` UTF-8 bytes, no control character.
function isBoundedText(value, max) {
    return typeof value === 'string' && value.isWellFormed() && utf8Bytes(value) >= 1 && utf8Bytes(value) <= max && !hasControl(value);
}

// Repository identity: canonical credential-free text from the trusted resolver, 1-512 UTF-8 bytes. URL user
// information (anything before `@` in the authority) is a credential and refuses.
function isRepositoryIdentity(value) {
    return isBoundedText(value, 512) && !/\s/u.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(value);
}

function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// RelativePath: 1-4096 bytes, components 1-255 bytes, at most 128 components; over a bound is capacity_exceeded.
function checkRelativePath(value) {
    need(typeof value === 'string' && value.isWellFormed());
    need(utf8Bytes(value) >= 1);
    need(utf8Bytes(value) <= 4096, 'capacity_exceeded');
    need(!hasControl(value) && !value.includes('\\'));
    const parts = value.split('/');
    need(parts.length <= 128, 'capacity_exceeded');
    for (const part of parts) {
        need(part.length > 0 && part !== '.' && part !== '..');
        need(utf8Bytes(part) <= 255, 'capacity_exceeded');
    }
}

function exact(value, keys, versioned = false) {
    need(isPlainObject(value));
    if (versioned) need(Object.hasOwn(value, 'version') && value.version === 1, 'unsupported_version');
    const allowed = new Set(versioned ? ['version', ...keys] : keys);
    for (const key of Object.keys(value)) need(allowed.has(key));
    for (const key of allowed) need(Object.hasOwn(value, key));
    return value;
}

function list(value, min, max) {
    need(Array.isArray(value));
    need(value.length <= max, 'capacity_exceeded');
    need(value.length >= min);
    return value;
}

function sortedUnique(items, keyOf) {
    for (let index = 1; index < items.length; index += 1) {
        need(compareUtf8(keyOf(items[index - 1]), keyOf(items[index])) < 0);
    }
}

function oneOf(value, options) {
    need(options.includes(value));
}

function nullOr(value, check) {
    if (value !== null) check(value);
}

const id = (value) => need(isId(value));
const opId = (value) => need(isOperationId(value));
const opaque = (value) => need(isOpaqueIdentity(value));
const principal = (value) => need(isPrincipal(value));
const digest = (value) => need(isDigest(value));
const time = (value) => need(isCounter(value));
const positive = (value) => need(isPositiveCounter(value));
const bool = (value) => need(typeof value === 'boolean');

const FILE_TYPES = Object.freeze(['directory', 'regular', 'symlink']);

function fsIdentity(value) {
    exact(value, ['filesystemId', 'mountId', 'device', 'inode', 'fileType']);
    opaque(value.filesystemId);
    for (const key of ['mountId', 'device', 'inode']) need(isU64Text(value[key]));
    oneOf(value.fileType, FILE_TYPES);
}

function sourceRevision(value) {
    exact(value, ['algorithm', 'value']);
    oneOf(value.algorithm, ['git-sha1', 'git-sha256']);
    need(typeof value.value === 'string' && (value.algorithm === 'git-sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(value.value));
}

function finish(value, check, maxBytes = OBJECT_BYTES) {
    return asResult(() => {
        encodeBounded(value, maxBytes);
        check(value);
        return deepFreeze(JSON.parse(encode(value, 0)));
    });
}

// ---- Binding and qualification (base §4) ----------------------------------------------------------------------------

const LIVE_SCOPE_KEYS = Object.freeze([
    'workspaceId', 'boxIdentity', 'boxGeneration', 'workerPrincipal', 'workerRuntimeInstanceId', 'workerEnableGeneration',
    'workerGeneration', 'agentPrincipal', 'containerId', 'runtimeInstanceId', 'enableGeneration', 'helperIncarnation'
]);

function liveScope(value) {
    exact(value, LIVE_SCOPE_KEYS);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    principal(value.workerPrincipal);
    opaque(value.workerRuntimeInstanceId);
    opaque(value.workerEnableGeneration);
    id(value.workerGeneration);
    principal(value.agentPrincipal);
    need(isContainerId(value.containerId));
    opaque(value.runtimeInstanceId);
    opaque(value.enableGeneration);
    id(value.helperIncarnation);
}

function sourceBinding(value) {
    exact(value, ['repositorySourceMode', 'sourceRepositoryIdentity', 'sourceRevision', 'sourceProtectionEpoch',
        'sourceSelectionDigest', 'sourceClosureDigest', 'sourceAcceptanceIdentity']);
    oneOf(value.repositorySourceMode, ['dev', 'prod']);
    need(isRepositoryIdentity(value.sourceRepositoryIdentity));
    sourceRevision(value.sourceRevision);
    positive(value.sourceProtectionEpoch);
    digest(value.sourceSelectionDigest);
    digest(value.sourceClosureDigest);
    opaque(value.sourceAcceptanceIdentity);
}

const BINDING_DIGEST_KEYS = Object.freeze([
    'helperExecutableDigest', 'contractDigest', 'inventoryDigest', 'profileDigest', 'limitsDigest', 'qualificationRecordDigest',
    'effectiveSecurityDigest', 'grantPolicyDigest', 'inputManifestDigest', 'skillViewManifestDigest',
    'nativeConfigProjectionDigest', 'channelManifestDigest', 'homeCompatibilityDigest'
]);

function targetBinding(value) {
    exact(value, ['scope', 'source', 'targetImageDigest', 'contractVersion', 'journalStoreIdentity', 'robotId', 'executionId',
        'attemptId', 'configRevision', ...BINDING_DIGEST_KEYS], true);
    liveScope(value.scope);
    sourceBinding(value.source);
    need(isImageDigest(value.targetImageDigest));
    need(value.contractVersion === 1, 'unsupported_version');
    for (const key of BINDING_DIGEST_KEYS) digest(value[key]);
    id(value.journalStoreIdentity);
    id(value.robotId);
    id(value.executionId);
    id(value.attemptId);
    positive(value.configRevision);
}

export function validateTargetBinding(value) {
    return finish(value, targetBinding);
}

const PEER_ACCESS_CELLS = Object.freeze([
    'workerStore', 'otherRobotHomes', 'qualificationRecords', 'sourceAcceptanceRecords', 'executionReceipts', 'helperJournal',
    'mailbox', 'credentials', 'robotProcAndDescriptors', 'workloadChannels'
]);

function peerEntry(value) {
    exact(value, ['classId', 'executableClosureDigest', 'trustClass', 'existingTrustEvidenceDigest', 'access']);
    need(isLowerId(value.classId));
    digest(value.executableClosureDigest);
    oneOf(value.trustClass, ['existing-management', 'untrusted-peer']);
    nullOr(value.existingTrustEvidenceDigest, digest);
    exact(value.access, PEER_ACCESS_CELLS);
    for (const cell of PEER_ACCESS_CELLS) oneOf(value.access[cell], ['deny', 'existing-management']);
}

function homeCompatibility(value) {
    exact(value, ['homeIdentity', 'transitions'], true);
    opaque(value.homeIdentity);
    list(value.transitions, 0, 256);
    for (const entry of value.transitions) {
        exact(entry, ['backendId', 'fromInventoryDigest', 'toInventoryDigest', 'continuation', 'loginState', 'modelState', 'rollback', 'evidenceDigest']);
        need(typeof entry.backendId === 'string' && BACKEND_ID.test(entry.backendId));
        digest(entry.fromInventoryDigest);
        digest(entry.toInventoryDigest);
        for (const key of ['continuation', 'loginState', 'modelState']) need(entry[key] === 'preserved');
        bool(entry.rollback);
        digest(entry.evidenceDigest);
    }
    sortedUnique(value.transitions, (entry) => `${entry.backendId}\u0000${entry.fromInventoryDigest}\u0000${entry.toInventoryDigest}`);
}

const PLATFORM_DIGEST_KEYS = Object.freeze([
    'kernelBuildDigest', 'runtimeConfigDigest', 'uidMappingDigest', 'gidMappingDigest', 'boxPolicyDigest',
    'targetProcBaselineDigest', 'workloadProcPolicyDigest'
]);

function qualificationRecord(value) {
    exact(value, ['qualificationClass', 'scope', 'fixture', 'source', 'targetImageDigest', 'helperExecutableDigest', 'contractDigest',
        'inventoryDigest', 'profileDigest', 'effectiveSecurityDigest', 'limitsDigest', 'inputSchemaDigest', 'channelSchemaDigest',
        'platform', 'peerTrustInventory', 'homeCompatibility', 'evidence', 'acceptedBy', 'acceptedAtMs'], true);
    oneOf(value.qualificationClass, ['proof-fixture', 'production']);
    liveScope(value.scope);
    if (value.qualificationClass === 'production') {
        need(value.fixture === null);
    } else {
        const fixture = exact(value.fixture, ['coordinatorPrincipal', 'fixtureId', 'authorizationDigest', 'operationIds', 'maxExecutions', 'notBeforeMs', 'notAfterMs']);
        principal(fixture.coordinatorPrincipal);
        id(fixture.fixtureId);
        digest(fixture.authorizationDigest);
        list(fixture.operationIds, 1, 64);
        fixture.operationIds.forEach(opId);
        sortedUnique(fixture.operationIds, (entry) => entry);
        need(Number.isSafeInteger(fixture.maxExecutions) && fixture.maxExecutions >= 1 && fixture.maxExecutions <= 8);
        time(fixture.notBeforeMs);
        time(fixture.notAfterMs);
        need(fixture.notAfterMs > fixture.notBeforeMs && fixture.notAfterMs - fixture.notBeforeMs <= FIXTURE_WINDOW_MS);
    }
    sourceBinding(value.source);
    need(isImageDigest(value.targetImageDigest));
    for (const key of ['helperExecutableDigest', 'contractDigest', 'inventoryDigest', 'profileDigest', 'effectiveSecurityDigest',
        'limitsDigest', 'inputSchemaDigest', 'channelSchemaDigest']) digest(value[key]);
    const platform = exact(value.platform, ['hostPlatform', 'kernelRelease', 'runtimeName', 'runtimeVersion', ...PLATFORM_DIGEST_KEYS]);
    oneOf(platform.hostPlatform, ['linux-amd64', 'darwin-linux-arm64']);
    need(isBoundedText(platform.kernelRelease, 128));
    oneOf(platform.runtimeName, ['podman', 'docker']);
    need(isBoundedText(platform.runtimeVersion, 128));
    for (const key of PLATFORM_DIGEST_KEYS) digest(platform[key]);
    list(value.peerTrustInventory, 1, 64);
    value.peerTrustInventory.forEach(peerEntry);
    sortedUnique(value.peerTrustInventory, (entry) => entry.classId);
    homeCompatibility(value.homeCompatibility);
    const evidence = exact(value.evidence, ['candidateManifestDigest', 'g7EvidenceDigest', 'independentVerificationDigest']);
    Object.values(evidence).forEach(digest);
    opaque(value.acceptedBy);
    time(value.acceptedAtMs);
    // Trust semantics after the structure: an untrusted peer has no evidence and every authority cell denied; a
    // management class needs evidence of pre-existing management trust (relabelling arbitrary code is refused).
    for (const entry of value.peerTrustInventory) {
        if (entry.trustClass === 'untrusted-peer') {
            need(entry.existingTrustEvidenceDigest === null);
            need(PEER_ACCESS_CELLS.every((cell) => entry.access[cell] === 'deny'), 'peer_authority_exposed');
        } else {
            need(entry.existingTrustEvidenceDigest !== null, 'peer_trust_unaccepted');
        }
    }
}

export function validateQualificationRecord(value) {
    return finish(value, qualificationRecord);
}

// ---- Input, channel and descriptor manifests (base §7, §8) ---------------------------------------------------------

const HOME_DESTINATION = '/home/robot';
const SKILL_DESTINATION = '/run/robo-work/skills';
const NATIVE_CONFIG_DESTINATION = '/run/robo-work/config/native';

function directoryIdentity(value) {
    fsIdentity(value);
    need(value.fileType === 'directory', 'descriptor_identity');
}

function isGrantDestination(value) {
    if (typeof value !== 'string') return false;
    const projects = /^\/projects\/([a-z0-9][a-z0-9-]{0,63})$/.exec(value);
    const environment = /^\/environment\/([a-z][a-z0-9-]{0,63})$/.exec(value);
    return Boolean(projects || environment);
}

function inputManifest(value) {
    exact(value, ['executionId', 'attemptId', 'configRevision', 'home', 'grants', 'skillOverlay', 'nativeConfigView'], true);
    id(value.executionId);
    id(value.attemptId);
    positive(value.configRevision);
    const home = exact(value.home, ['descriptorId', 'identity', 'destination', 'access']);
    id(home.descriptorId);
    directoryIdentity(home.identity);
    need(home.destination === HOME_DESTINATION && home.access === 'write');
    list(value.grants, 0, 32);
    for (const grant of value.grants) {
        exact(grant, ['grantId', 'descriptorId', 'identity', 'destination', 'access', 'filterPolicyDigest']);
        need(isGrantId(grant.grantId));
        id(grant.descriptorId);
        directoryIdentity(grant.identity);
        need(isGrantDestination(grant.destination));
        if (grant.destination.startsWith('/projects/')) need(grant.destination === `/projects/${grant.grantId}`);
        oneOf(grant.access, ['read', 'write']);
        digest(grant.filterPolicyDigest);
    }
    sortedUnique(value.grants, (grant) => grant.grantId);
    need(new Set(value.grants.map((grant) => grant.destination)).size === value.grants.length);
    const skill = exact(value.skillOverlay, ['descriptorId', 'identity', 'destination', 'access', 'semantics', 'selectionDigest',
        'policyDigest', 'viewStructureDigest', 'roots', 'requiredSelectionIds']);
    id(skill.descriptorId);
    directoryIdentity(skill.identity);
    need(skill.destination === SKILL_DESTINATION && skill.access === 'read' && skill.semantics === 'live-source');
    digest(skill.selectionDigest);
    digest(skill.policyDigest);
    digest(skill.viewStructureDigest);
    list(skill.roots, 0, 128);
    for (const root of skill.roots) {
        exact(root, ['grantId', 'identity', 'bindingChainDigest', 'required']);
        need(isGrantId(root.grantId));
        directoryIdentity(root.identity);
        digest(root.bindingChainDigest);
        bool(root.required);
    }
    sortedUnique(skill.roots, (root) => root.grantId);
    list(skill.requiredSelectionIds, 0, 128);
    for (const selection of skill.requiredSelectionIds) need(isBoundedText(selection, 512));
    sortedUnique(skill.requiredSelectionIds, (entry) => entry);
    const native = exact(value.nativeConfigView, ['descriptorId', 'identity', 'destination', 'access', 'semantics', 'configRevision', 'projectionDigest', 'entries']);
    id(native.descriptorId);
    directoryIdentity(native.identity);
    need(native.destination === NATIVE_CONFIG_DESTINATION && native.access === 'read' && native.semantics === 'immutable-backed');
    need(native.configRevision === value.configRevision);
    digest(native.projectionDigest);
    list(native.entries, 0, 128);
    for (const entry of native.entries) {
        exact(entry, ['path', 'contentDigest', 'mode']);
        checkRelativePath(entry.path);
        digest(entry.contentDigest);
        oneOf(entry.mode, ['0400', '0444']);
    }
    sortedUnique(native.entries, (entry) => entry.path);
    // The projection digest covers the canonical entry metadata and raw-content digests.
    need(native.projectionDigest === digestOf(native.entries));
    const descriptorIds = [home.descriptorId, ...value.grants.map((grant) => grant.descriptorId), skill.descriptorId, native.descriptorId];
    need(new Set(descriptorIds).size === descriptorIds.length);
}

export function validateInputManifest(value) {
    return finish(value, inputManifest);
}

export const CHANNEL_KINDS = Object.freeze(['model', 'broker', 'mcp', 'human-input', 'task-failure']);
const CHANNEL_HANDLERS = Object.freeze({
    model: 'model-adapter', broker: 'execution-broker', mcp: 'execution-mcp',
    'human-input': 'execution-human-input', 'task-failure': 'execution-task-failure'
});
const CHANNEL_TOKENS = Object.freeze({
    model: 'ROBOWORK_MODEL_TOKEN', broker: 'ROBOWORK_BROKER_TOKEN', mcp: 'ROBOWORK_MCP_TOKEN',
    'human-input': 'ROBOWORK_HUMAN_INPUT_TOKEN', 'task-failure': 'ROBOWORK_TASK_FAILURE_TOKEN'
});
const CHANNEL_SOCKETS = Object.freeze({
    model: '/run/robo-work/channels/model.sock', broker: '/run/robo-work/channels/broker.sock',
    'human-input': '/run/robo-work/channels/human-input.sock', 'task-failure': '/run/robo-work/channels/task-failure.sock'
});

function channelEndpoint(kind, endpoint) {
    if (kind === 'mcp') {
        exact(endpoint, ['transport', 'host', 'port']);
        need(endpoint.transport === 'tcp' && endpoint.host === '127.0.0.1');
        need(Number.isSafeInteger(endpoint.port) && endpoint.port >= 1024 && endpoint.port <= 65535);
    } else {
        exact(endpoint, ['transport', 'path']);
        need(endpoint.transport === 'unix' && endpoint.path === CHANNEL_SOCKETS[kind]);
    }
}

function channelManifest(value, requirements) {
    exact(value, ['executionId', 'attemptId', 'limitsDigest', 'channels'], true);
    id(value.executionId);
    id(value.attemptId);
    digest(value.limitsDigest);
    need(Array.isArray(value.channels) && value.channels.length === CHANNEL_KINDS.length);
    value.channels.forEach((channel, index) => {
        exact(channel, ['channelId', 'kind', 'enabled', 'required', 'endpoint', 'handler', 'policyDigest', 'finalExecTokenName']);
        const kind = CHANNEL_KINDS[index];
        need(channel.kind === kind && channel.channelId === kind);
        bool(channel.enabled);
        bool(channel.required);
        if (!channel.enabled) {
            need(!channel.required, 'required_channel_missing');
            need(channel.endpoint === null && channel.handler === null && channel.policyDigest === null && channel.finalExecTokenName === null);
        } else {
            channelEndpoint(kind, channel.endpoint);
            need(channel.handler === CHANNEL_HANDLERS[kind]);
            digest(channel.policyDigest);
            need(channel.finalExecTokenName === null || channel.finalExecTokenName === CHANNEL_TOKENS[kind]);
        }
    });
    if (requirements !== undefined) {
        exact(requirements, ['requiredKinds']);
        need(Array.isArray(requirements.requiredKinds) && requirements.requiredKinds.every((kind) => CHANNEL_KINDS.includes(kind)));
        for (const kind of requirements.requiredKinds) {
            const channel = value.channels[CHANNEL_KINDS.indexOf(kind)];
            need(channel.enabled && channel.required, 'required_channel_missing');
        }
    }
}

// `requirements` (optional): {requiredKinds} the admitted backend, skills and workflow capabilities need; each must be
// enabled and required (no silent downgrade after admission).
export function validateChannelManifest(value, requirements) {
    return asResult(() => {
        encodeBounded(value, OBJECT_BYTES);
        channelManifest(value, requirements);
        return deepFreeze(JSON.parse(encode(value, 0)));
    });
}

const DESCRIPTOR_ROLES = Object.freeze(['home', 'grant-root', 'skill-overlay', 'native-config-view', 'connected-stream']);
const DESCRIPTORS_PER_FRAME_CEILING = 8;

function descriptorEntry(entry, index) {
    need(isPlainObject(entry));
    need(Object.hasOwn(entry, 'slot') && entry.slot === index, 'descriptor_count');
    exact(entry, ['slot', 'descriptorId', 'role', 'kind', 'access', 'identity', 'destination', 'resourceId']);
    need(DESCRIPTOR_ROLES.includes(entry.role), 'descriptor_role');
    id(entry.descriptorId);
    id(entry.resourceId);
    if (entry.role === 'connected-stream') {
        need(entry.kind === 'connected-stream' && entry.access === 'duplex' && entry.destination === null, 'descriptor_role');
        exact(entry.identity, ['socketCookie']);
        need(isU64Text(entry.identity.socketCookie));
        return;
    }
    need(entry.kind === 'directory', 'descriptor_role');
    const expected = {
        home: [HOME_DESTINATION, ['write']],
        'skill-overlay': [SKILL_DESTINATION, ['read']],
        'native-config-view': [NATIVE_CONFIG_DESTINATION, ['read']]
    }[entry.role];
    if (expected) {
        need(entry.destination === expected[0] && expected[1].includes(entry.access), 'descriptor_role');
    } else {
        need(isGrantDestination(entry.destination) && ['read', 'write'].includes(entry.access), 'descriptor_role');
    }
    directoryIdentity(entry.identity);
}

function descriptorManifest(value) {
    need(Array.isArray(value));
    need(value.length <= DESCRIPTORS_PER_FRAME_CEILING, 'capacity_exceeded');
    value.forEach(descriptorEntry);
    need(new Set(value.map((entry) => entry.descriptorId)).size === value.length);
}

// The ordered descriptor entries of one frame (the frame header `descriptors` array): contiguous zero-based slots, a fixed
// role set, and the kind/access/destination/identity form of each role. Semantic comparison with the admitted input
// manifest is validateDescriptorTransfer (transportContract.mjs).
export function validateDescriptorManifest(value) {
    return finish(value, descriptorManifest);
}

// ---- Journal receipts and start outcomes (base §9) ------------------------------------------------------------------

const RECORD_STATES = Object.freeze(['reserved', 'prepared', 'running', 'stopping', 'exited', 'quarantined']);
export const RESOURCE_KINDS = Object.freeze(['keeper', 'gate', 'descriptor', 'filtered-view', 'listener', 'connection', 'namespace', 'process-tree', 'cgroup']);
const RESOURCE_STATES = Object.freeze(['reserved', 'committed', 'released', 'quarantined']);
const RESOURCES_PER_OPERATION_CEILING = 512;
const CONNECTIONS_PER_EXECUTION_CEILING = 64;

function operationKey(value) {
    exact(value, ['workspaceId', 'workerGeneration', 'executionId', 'attemptId', 'operationId']);
    opaque(value.workspaceId);
    id(value.workerGeneration);
    id(value.executionId);
    id(value.attemptId);
    opId(value.operationId);
}

function resourceReceipt(value) {
    exact(value, ['resourceId', 'kind', 'locatorDigest', 'identityDigest', 'state', 'absenceEvidenceDigest']);
    id(value.resourceId);
    oneOf(value.kind, RESOURCE_KINDS);
    digest(value.locatorDigest);
    oneOf(value.state, RESOURCE_STATES);
    nullOr(value.identityDigest, digest);
    if (value.state === 'committed') need(value.identityDigest !== null);
    if (value.state === 'released') digest(value.absenceEvidenceDigest);
    else need(value.absenceEvidenceDigest === null);
}

function targetReceipt(value) {
    exact(value, ['key', 'targetBindingDigest', 'reservationId', 'requestDigest', 'journalStoreIdentity', 'helperIncarnation', 'leaseId',
        'state', 'receiptSequence', 'gateReleased', 'resources', 'inputCursors', 'observedAtMs'], true);
    operationKey(value.key);
    digest(value.targetBindingDigest);
    id(value.reservationId);
    digest(value.requestDigest);
    id(value.journalStoreIdentity);
    id(value.helperIncarnation);
    id(value.leaseId);
    oneOf(value.state, RECORD_STATES);
    positive(value.receiptSequence);
    bool(value.gateReleased);
    if (value.state === 'reserved' || value.state === 'prepared') need(value.gateReleased === false);
    if (value.state === 'running') need(value.gateReleased === true);
    list(value.resources, 0, RESOURCES_PER_OPERATION_CEILING);
    value.resources.forEach(resourceReceipt);
    sortedUnique(value.resources, (entry) => entry.resourceId);
    list(value.inputCursors, 0, CONNECTIONS_PER_EXECUTION_CEILING);
    for (const cursor of value.inputCursors) {
        exact(cursor, ['connectionId', 'acceptedThrough', 'delivery']);
        id(cursor.connectionId);
        need(isU64Text(cursor.acceptedThrough));
        oneOf(cursor.delivery, ['acknowledged', 'unknown']);
    }
    sortedUnique(value.inputCursors, (cursor) => cursor.connectionId);
    time(value.observedAtMs);
}

export function validateTargetReceipt(value) {
    return finish(value, targetReceipt, RECEIPT_BYTES);
}

const START_OUTCOMES = Object.freeze(['refused-before-create', 'committed-or-reconciled', 'outcome-unknown']);

function startOutcome(value) {
    need(isPlainObject(value));
    need(Object.hasOwn(value, 'version') && value.version === 1, 'unsupported_version');
    oneOf(value.outcome, START_OUTCOMES);
    if (value.outcome === 'refused-before-create') {
        exact(value, ['outcome', 'key', 'requestDigest', 'code', 'absenceEvidenceDigest'], true);
        need(typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.code));
        digest(value.absenceEvidenceDigest);
    } else if (value.outcome === 'committed-or-reconciled') {
        exact(value, ['outcome', 'key', 'requestDigest', 'receipt'], true);
        targetReceipt(value.receipt);
        need(encode(value.receipt.key, 0) === encode(value.key, 0) && value.receipt.requestDigest === value.requestDigest);
    } else {
        exact(value, ['outcome', 'key', 'requestDigest', 'reservationId', 'lastReceiptSequence'], true);
        id(value.reservationId);
        need(isCounter(value.lastReceiptSequence));
    }
    operationKey(value.key);
    digest(value.requestDigest);
}

export function validateStartOutcome(value) {
    return finish(value, startOutcome, RECEIPT_BYTES);
}

// ---- Source protection, selection and closure (base §5; A1.3) -------------------------------------------------------

function sourceProtectionRecord(value) {
    exact(value, ['workspaceId', 'boxIdentity', 'boxGeneration', 'sourceProtectionEpoch', 'sourceSelectionDigest', 'sourceClosureDigest',
        'sourceAcceptanceIdentity', 'sourceStoreIdentity', 'protectionStatus', 'enforcementDigest', 'aliasCoverageDigest', 'acceptedAtMs'], true);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    positive(value.sourceProtectionEpoch);
    digest(value.sourceSelectionDigest);
    digest(value.sourceClosureDigest);
    opaque(value.sourceAcceptanceIdentity);
    id(value.sourceStoreIdentity);
    oneOf(value.protectionStatus, ['protected', 'unavailable']);
    if (value.protectionStatus === 'protected') {
        digest(value.enforcementDigest);
        digest(value.aliasCoverageDigest);
    } else {
        nullOr(value.enforcementDigest, digest);
        nullOr(value.aliasCoverageDigest, digest);
    }
    time(value.acceptedAtMs);
}

export function validateSourceProtectionRecord(value) {
    return finish(value, sourceProtectionRecord);
}

const SELECTION_ROLES = Object.freeze(['controller', 'worker', 'coordinator', 'agent', 'helper', 'shared-library', 'dependency', 'skill-source']);
const SOURCE_KINDS = Object.freeze(['workspace', 'managed', 'link-install', 'image', 'dependency-store']);

function sourceSelection(value) {
    exact(value, ['repositorySourceMode', 'selections'], true);
    oneOf(value.repositorySourceMode, ['dev', 'prod']);
    list(value.selections, 1, 512);
    for (const selection of value.selections) {
        exact(selection, ['consumerPrincipal', 'role', 'repositoryIdentity', 'revision', 'sourceKind', 'rootIdentity', 'dependencyIdentity']);
        principal(selection.consumerPrincipal);
        oneOf(selection.role, SELECTION_ROLES);
        need(isRepositoryIdentity(selection.repositoryIdentity));
        sourceRevision(selection.revision);
        oneOf(selection.sourceKind, SOURCE_KINDS);
        fsIdentity(selection.rootIdentity);
        nullOr(selection.dependencyIdentity, digest);
    }
    sortedUnique(value.selections, (selection) => encode(selection, 0));
}

export function validateSourceSelection(value) {
    return finish(value, sourceSelection);
}

const DEPENDENCY_KINDS = Object.freeze(['link-install', 'shared-library', 'package-tree', 'executable-runtime']);
const GIT_STATES = Object.freeze(['tracked-clean', 'tracked-dirty', 'untracked', 'non-git']);

function closureEntry(entry, rootIds, dependencyIds) {
    exact(entry, ['rootId', 'path', 'fileType', 'mode', 'gitState', 'contentDigest', 'linkTarget', 'resolvedIdentity', 'dependencyIdentity']);
    need(rootIds.has(entry.rootId));
    checkRelativePath(entry.path);
    oneOf(entry.fileType, FILE_TYPES);
    need(typeof entry.mode === 'string' && /^0[0-7]{3}$/.test(entry.mode));
    oneOf(entry.gitState, GIT_STATES);
    nullOr(entry.resolvedIdentity, fsIdentity);
    if (entry.dependencyIdentity !== null) need(dependencyIds.has(entry.dependencyIdentity));
    if (entry.fileType === 'regular') {
        digest(entry.contentDigest);
        need(entry.linkTarget === null);
        need(entry.resolvedIdentity !== null && entry.resolvedIdentity.fileType === 'regular');
    } else if (entry.fileType === 'directory') {
        need(entry.contentDigest === null && entry.linkTarget === null);
        if (entry.resolvedIdentity !== null) need(entry.resolvedIdentity.fileType === 'directory');
    } else {
        need(entry.contentDigest === null);
        need(typeof entry.linkTarget === 'string' && entry.linkTarget.isWellFormed() && utf8Bytes(entry.linkTarget) >= 1
            && utf8Bytes(entry.linkTarget) <= 4096 && !entry.linkTarget.includes('\u0000'));
        need(entry.resolvedIdentity !== null && entry.resolvedIdentity.fileType !== 'symlink');
    }
}

function sourceClosure(value) {
    exact(value, ['roots', 'entries', 'dependencies', 'secretReferences'], true);
    list(value.roots, 1, 512);
    for (const root of value.roots) {
        exact(root, ['rootId', 'rootIdentity', 'repositoryIdentity', 'revision', 'sourceKind']);
        id(root.rootId);
        fsIdentity(root.rootIdentity);
        need(root.rootIdentity.fileType === 'directory');
        nullOr(root.repositoryIdentity, (entry) => need(isRepositoryIdentity(entry)));
        nullOr(root.revision, sourceRevision);
        oneOf(root.sourceKind, SOURCE_KINDS);
    }
    sortedUnique(value.roots, (root) => root.rootId);
    list(value.dependencies, 0, 4096);
    for (const dependency of value.dependencies) {
        exact(dependency, ['id', 'kind', 'selectionDigest', 'closureDigest', 'rootIdentity', 'lockDigest']);
        id(dependency.id);
        oneOf(dependency.kind, DEPENDENCY_KINDS);
        digest(dependency.selectionDigest);
        digest(dependency.closureDigest);
        fsIdentity(dependency.rootIdentity);
        nullOr(dependency.lockDigest, digest);
    }
    sortedUnique(value.dependencies, (dependency) => dependency.id);
    const rootIds = new Set(value.roots.map((root) => root.rootId));
    const dependencyIds = new Set(value.dependencies.map((dependency) => dependency.id));
    list(value.entries, 0, 65536);
    for (const entry of value.entries) closureEntry(entry, rootIds, dependencyIds);
    sortedUnique(value.entries, (entry) => `${entry.rootId}\u0000${entry.path}`);
    // A symlink's resolved target must itself be part of the closure: a root or a non-link entry of the same identity.
    const included = new Set(value.roots.map((root) => encode(root.rootIdentity, 0)));
    for (const entry of value.entries) {
        if (entry.fileType !== 'symlink' && entry.resolvedIdentity !== null) included.add(encode(entry.resolvedIdentity, 0));
    }
    for (const entry of value.entries) {
        if (entry.fileType === 'symlink') need(included.has(encode(entry.resolvedIdentity, 0)));
    }
    list(value.secretReferences, 0, 1024);
    for (const reference of value.secretReferences) {
        exact(reference, ['rootId', 'path', 'secretHandleId', 'revisionId']);
        need(rootIds.has(reference.rootId));
        checkRelativePath(reference.path);
        opaque(reference.secretHandleId);
        opaque(reference.revisionId);
    }
    sortedUnique(value.secretReferences, (reference) => `${reference.rootId}\u0000${reference.path}`);
    // A5.3: a secret-bearing path is modelled only as a reference, never also as a content entry.
    const entryPaths = new Set(value.entries.map((entry) => `${entry.rootId}\u0000${entry.path}`));
    for (const reference of value.secretReferences) need(!entryPaths.has(`${reference.rootId}\u0000${reference.path}`));
}

export function validateSourceClosure(value) {
    return finish(value, sourceClosure, CLOSURE_BYTES);
}

// ---- Writable reservations and the private source operations (base §6; A1.2, A1.3, A1.5; A2.2, A2.3) ----------------

const WRITABLE_KINDS = Object.freeze(['home', 'project', 'target-state', 'retained-gui', 'broker-write', 'pending-create']);
const CONSUMER_KINDS = Object.freeze(['execution', 'terminal', 'retained-gui', 'broker']);
const RESERVATION_RESOURCES_CEILING = 64;

function writableResource(value) {
    exact(value, ['resourceId', 'kind', 'rootIdentity', 'bindingChainDigest', 'access', 'aliasCoverageDigest']);
    id(value.resourceId);
    oneOf(value.kind, WRITABLE_KINDS);
    fsIdentity(value.rootIdentity);
    digest(value.bindingChainDigest);
    need(value.access === 'write');
    digest(value.aliasCoverageDigest);
}

function writableResources(value) {
    list(value, 1, RESERVATION_RESOURCES_CEILING);
    value.forEach(writableResource);
    sortedUnique(value, (resource) => resource.resourceId);
}

function executionPair(value) {
    id(value.robotId);
    need((value.executionId === null) === (value.attemptId === null));
    nullOr(value.executionId, id);
    nullOr(value.attemptId, id);
    oneOf(value.consumerKind, CONSUMER_KINDS);
    id(value.consumerId);
}

function writableReservation(value) {
    exact(value, ['reservationId', 'operationId', 'workspaceId', 'boxIdentity', 'boxGeneration', 'workerPrincipal',
        'workerRuntimeInstanceId', 'workerEnableGeneration', 'workerGeneration', 'robotId', 'executionId', 'attemptId', 'consumerKind',
        'consumerId', 'sourceProtectionEpoch', 'sourceSelectionDigest', 'sourceClosureDigest', 'sourceAcceptanceIdentity',
        'sourceStoreIdentity', 'resources', 'requestDigest', 'state', 'createdAtMs', 'releaseEvidenceDigest'], true);
    id(value.reservationId);
    opId(value.operationId);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    principal(value.workerPrincipal);
    opaque(value.workerRuntimeInstanceId);
    opaque(value.workerEnableGeneration);
    id(value.workerGeneration);
    executionPair(value);
    positive(value.sourceProtectionEpoch);
    digest(value.sourceSelectionDigest);
    digest(value.sourceClosureDigest);
    opaque(value.sourceAcceptanceIdentity);
    id(value.sourceStoreIdentity);
    writableResources(value.resources);
    digest(value.requestDigest);
    oneOf(value.state, ['reserved', 'released']);
    time(value.createdAtMs);
    if (value.state === 'reserved') need(value.releaseEvidenceDigest === null);
    else digest(value.releaseEvidenceDigest);
}

export function validateWritableReservation(value) {
    return finish(value, writableReservation);
}

// Compact released-reservation tombstone (A1.5), as returned for an identical reserve retry after release.
function reservationTombstone(value) {
    exact(value, ['reservationId', 'operationId', 'requestDigest', 'workerPrincipal', 'workerGeneration', 'state',
        'releaseEvidenceDigest', 'sourceStoreIdentity'], true);
    id(value.reservationId);
    opId(value.operationId);
    digest(value.requestDigest);
    principal(value.workerPrincipal);
    id(value.workerGeneration);
    need(value.state === 'released');
    digest(value.releaseEvidenceDigest);
    id(value.sourceStoreIdentity);
}

function reserveRequest(value) {
    exact(value, ['operationId', 'reservationId', 'workspaceId', 'boxIdentity', 'boxGeneration', 'workerGeneration', 'robotId',
        'executionId', 'attemptId', 'consumerKind', 'consumerId', 'expectedEpoch', 'resources'], true);
    opId(value.operationId);
    id(value.reservationId);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    id(value.workerGeneration);
    executionPair(value);
    positive(value.expectedEpoch);
    writableResources(value.resources);
}

function reserveResult(value) {
    if (isPlainObject(value) && Object.hasOwn(value, 'resources')) writableReservation(value);
    else reservationTombstone(value);
}

function transitionRequest(value) {
    exact(value, ['operationId', 'workspaceId', 'boxIdentity', 'boxGeneration', 'expectedEpoch', 'selectionDigest', 'closureDigest',
        'sourceAcceptanceIdentity', 'enforcementDigest', 'aliasCoverageDigest'], true);
    opId(value.operationId);
    opaque(value.workspaceId);
    opaque(value.boxIdentity);
    opaque(value.boxGeneration);
    need(isCounter(value.expectedEpoch) && value.expectedEpoch < MAX_SAFE);
    digest(value.selectionDigest);
    digest(value.closureDigest);
    opaque(value.sourceAcceptanceIdentity);
    digest(value.enforcementDigest);
    digest(value.aliasCoverageDigest);
}

function transitionResult(value) {
    exact(value, ['operationId', 'previousEpoch', 'record', 'requestDigest', 'sourceStoreIdentity'], true);
    opId(value.operationId);
    need(isCounter(value.previousEpoch) && value.previousEpoch < MAX_SAFE);
    sourceProtectionRecord(value.record);
    digest(value.requestDigest);
    id(value.sourceStoreIdentity);
    need(value.record.sourceProtectionEpoch === value.previousEpoch + 1);
    need(value.record.protectionStatus === 'protected');
    need(value.record.sourceStoreIdentity === value.sourceStoreIdentity);
}

function releaseRequest(value) {
    exact(value, ['operationId', 'reservationId', 'reservationRequestDigest', 'owningWorkerGeneration', 'resourcesDigest', 'releaseEvidenceDigest'], true);
    opId(value.operationId);
    id(value.reservationId);
    digest(value.reservationRequestDigest);
    id(value.owningWorkerGeneration);
    digest(value.resourcesDigest);
    digest(value.releaseEvidenceDigest);
}

function releaseResult(value) {
    exact(value, ['operationId', 'reservationId', 'state', 'requestDigest', 'releaseEvidenceDigest', 'sourceStoreIdentity'], true);
    opId(value.operationId);
    id(value.reservationId);
    need(value.state === 'released');
    digest(value.requestDigest);
    digest(value.releaseEvidenceDigest);
    id(value.sourceStoreIdentity);
}

function acknowledgeRequest(value) {
    exact(value, ['operationId', 'sourceStoreIdentity', 'workerGeneration', 'priorStoreIdentities', 'settlementAttestationDigest'], true);
    opId(value.operationId);
    id(value.sourceStoreIdentity);
    id(value.workerGeneration);
    list(value.priorStoreIdentities, 0, 64);
    value.priorStoreIdentities.forEach(id);
    sortedUnique(value.priorStoreIdentities, (entry) => entry);
    need(!value.priorStoreIdentities.includes(value.sourceStoreIdentity));
    digest(value.settlementAttestationDigest);
}

function acknowledgeResult(value) {
    exact(value, ['operationId', 'sourceStoreIdentity', 'workerPrincipal', 'state', 'requestDigest'], true);
    opId(value.operationId);
    id(value.sourceStoreIdentity);
    principal(value.workerPrincipal);
    oneOf(value.state, ['awaiting-holder-ack', 'ready']);
    digest(value.requestDigest);
}

function advanceRequest(value) {
    exact(value, ['operationId', 'priorGeneration', 'nextGeneration'], true);
    opId(value.operationId);
    nullOr(value.priorGeneration, id);
    id(value.nextGeneration);
    need(value.priorGeneration !== value.nextGeneration);
}

function advanceResult(value) {
    exact(value, ['operationId', 'workerPrincipal', 'priorGeneration', 'currentGeneration', 'requestDigest'], true);
    opId(value.operationId);
    principal(value.workerPrincipal);
    nullOr(value.priorGeneration, id);
    id(value.currentGeneration);
    need(value.priorGeneration !== value.currentGeneration);
    digest(value.requestDigest);
}

const SOURCE_OPERATION_TYPES = Object.freeze({
    reserveRequest, reserveResult, transitionRequest, transitionResult, releaseRequest, releaseResult,
    acknowledgeRequest, acknowledgeResult, advanceRequest, advanceResult
});

// The key that marks a request of each operation; its absence selects the result form.
const REQUEST_MARKERS = Object.freeze({
    reserve: 'expectedEpoch', transition: 'expectedEpoch', release: 'reservationRequestDigest',
    acknowledge: 'settlementAttestationDigest', advance: 'nextGeneration'
});

const SOURCE_OPERATION_KINDS = Object.freeze([...Object.keys(REQUEST_MARKERS), ...Object.keys(SOURCE_OPERATION_TYPES)]);

// `kind` is an explicit document type (`reserveRequest`, `reserveResult`, ..., `advanceResult`) or an operation name
// (`reserve`, `transition`, `release`, `acknowledge`, `advance`), in which case the request or result form is selected by
// the request's marker key.
export function validateSourceOperation(kind, value) {
    if (typeof kind !== 'string' || !SOURCE_OPERATION_KINDS.includes(kind)) return failure('invalid_request');
    let type = kind;
    if (Object.hasOwn(REQUEST_MARKERS, kind)) {
        if (!isPlainObject(value)) return failure('invalid_request');
        type = `${kind}${Object.hasOwn(value, REQUEST_MARKERS[kind]) ? 'Request' : 'Result'}`;
    }
    return finish(value, SOURCE_OPERATION_TYPES[type]);
}

