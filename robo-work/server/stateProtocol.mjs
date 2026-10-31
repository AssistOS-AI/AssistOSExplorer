import crypto from 'node:crypto';
import { isSessionKey } from './stateSessions.mjs';

// Worker-state protocol: stable error codes, strict validators, canonical JSON
// and digests, ID generation, limits and the internal verified-context brand.

export const ERROR_CODES = Object.freeze([
    'invalid_request', 'not_found', 'forbidden', 'operation_conflict', 'revision_conflict',
    'robot_busy', 'runtime_unavailable', 'recovery_pending', 'resource_quarantined',
    'resource_present', 'stale_generation', 'capacity_exceeded', 'state_corrupt', 'environment_unavailable', 'terminals_open'
]);

const PUBLIC_MESSAGES = Object.freeze({
    invalid_request: 'The request is not valid.',
    not_found: 'The requested record was not found.',
    forbidden: 'The operation is not authorized.',
    operation_conflict: 'The operation conflicts with a recorded operation.',
    revision_conflict: 'The expected revision does not match.',
    robot_busy: 'The robot is busy.',
    runtime_unavailable: 'The runtime is unavailable.',
    recovery_pending: 'Generation recovery is pending.',
    resource_quarantined: 'A required resource is quarantined.',
    resource_present: 'The resource is still present.',
    stale_generation: 'The writer generation is stale.',
    capacity_exceeded: 'A configured capacity limit is exhausted.',
    state_corrupt: 'The worker state is unusable.',
    environment_unavailable: 'Existing-agent environments are not available.',
    // M-54: configure and delete refuse while robot terminals are open; the error carries `terminals` (the count), never ids.
    terminals_open: 'Robot terminals are open.'
});

// Bounded, enumerated reason details. A reason never carries paths, content or SQLite text.
// `token_replayed` (S1x): a consumed Router token ID presented again within its retention.
// `binding_kind` (S6 source-only subset): background-row admission under a binding that is
// neither a flow nor a generation (a schedule binding only parents derived flows).
// `binding_not_paused` and `binding_cancelled` (S6 Part D): a flow continuation of a binding
// that is active or cancelled (operation_conflict).
// `schema_version_mismatch` (schema 9): a store written by another schema version (for example a version-8 store) is refused at
// open with state_corrupt and this reason, before anything is written (never half-opened; M-51 Q4, R18: a fresh deploy is needed).
export const ERROR_REASONS = Object.freeze([
    'pragma_journal_mode', 'pragma_synchronous', 'pragma_foreign_keys', 'token_replayed', 'binding_kind', 'binding_not_paused', 'binding_cancelled',
    'schema_version_mismatch'
]);

export class WorkerStateError extends Error {
    constructor(code, reason) {
        if (!ERROR_CODES.includes(code)) throw new TypeError('Unknown worker-state error code');
        if (reason !== undefined && !ERROR_REASONS.includes(reason)) throw new TypeError('Unknown worker-state error reason');
        super(PUBLIC_MESSAGES[code]);
        this.name = 'WorkerStateError';
        this.code = code;
        if (reason !== undefined) this.reason = reason;
    }
}

export function fail(code, reason) {
    throw new WorkerStateError(code, reason);
}

export const OPERATIONS = Object.freeze([
    'provision', 'configure', 'delete', 'admit', 'lookup', 'read', 'attest', 'adapter_complete', 'administer', 'bind', 'control', 'obligate'
]);
// Operations of a coordinator context (S6 Part D): `decide` (accept, reject) and `reconcile`
// (list, outbox), for the verified coordinator alone.
export const COORDINATOR_OPERATIONS = Object.freeze(['decide', 'reconcile']);
// Operations a service context (no origin row) may carry: workspace robot lifecycle and reads.
export const SERVICE_OPERATIONS = Object.freeze(['provision', 'configure', 'delete', 'read', 'adapter_complete', 'attest']);
export const REFERENCE_VERSION = 1;
export const END_CLASSIFICATIONS = Object.freeze(['completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted']);
// Admission request kinds and the logical kind recorded at admission (S6 source-only subset). These are the kinds a coordinator may
// REQUEST: an admit with any other kind (`terminal` included) is invalid_request before any state access.
export const ADMISSION_KINDS = Object.freeze(['task', 'continuation', 'turn']);
export const LOGICAL_KINDS = Object.freeze(['task', 'session', 'flow']);
// Schema 9 (M-8 robot terminals, plan-review B-1 and delta note 1): the STORED kinds add `terminal`, created only by the worker's own
// terminal path, never by a coordinator admit. A terminal admission has its own logical kind `terminal` (a fresh logical id each time)
// and an internal reference row of kind `terminal`, which no coordinator read lists or reveals (not_found).
export const TERMINAL_KIND = 'terminal';
export const STORED_ADMISSION_KINDS = Object.freeze([...ADMISSION_KINDS, TERMINAL_KIND]);
export const STORED_LOGICAL_KINDS = Object.freeze([...LOGICAL_KINDS, TERMINAL_KIND]);
export const TERMINAL_STATES = END_CLASSIFICATIONS;
export const ACTIVE_STATES = Object.freeze(['queued', 'running']);
export const PROCESS_TREE_KIND = 'process-tree';
export const LIMIT_KEYS = Object.freeze(['requestBytes', 'robots', 'receipts', 'admissions', 'resultBytes']);
// S1x extension limits: accepted only as a complete set on top of LIMIT_KEYS. A method that
// needs an absent extension limit refuses with capacity_exceeded.
export const EXTENSION_LIMIT_KEYS = Object.freeze(['bindings', 'controls', 'tokenReplayEntries']);
// S6 limits (Part D): accepted only as a complete set on top of LIMIT_KEYS and every
// EXTENSION_LIMIT_KEYS entry. `obligationAcceptMs` is the acceptance window (G5 fixes it).
export const S6_LIMIT_KEYS = Object.freeze(['obligations', 'outboxRevisions', 'obligationAcceptMs']);

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 16;
const NAME_MAX = 80;
const AUTHORITY_KEYS = new Set([
    'principal', 'scope', 'owner', 'ownerid', 'role', 'roles', 'grant', 'grants', 'authorization',
    'token', 'tokens', 'workspace', 'workspaceid', 'admin', 'administrator', 'namespace',
    'backingpath', 'path', 'home', 'homedir', 'verifiedcontext', 'context', 'secret', 'password'
]);

export function randomId() {
    return crypto.randomBytes(16).toString('base64url');
}

export function isOriginId(value) {
    if (typeof value !== 'string' || value.length !== 22 || !BASE64URL.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 16 && bytes.toString('base64url') === value;
}

export function isPublicReferenceId(value) {
    return typeof value === 'string' && value.length >= 22 && value.length <= 64 && BASE64URL.test(value);
}

export function isInternalId(value) {
    return isOriginId(value);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function canonicalize(value, depth) {
    if (depth > MAX_DEPTH) fail('invalid_request');
    if (value === null) return 'null';
    switch (typeof value) {
        case 'string': return JSON.stringify(value);
        case 'boolean': return value ? 'true' : 'false';
        case 'number':
            if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_request');
            return JSON.stringify(value);
        case 'object': {
            if (Array.isArray(value)) {
                const parts = [];
                for (let index = 0; index < value.length; index += 1) {
                    if (!(index in value)) fail('invalid_request');
                    parts.push(canonicalize(value[index], depth + 1));
                }
                return `[${parts.join(',')}]`;
            }
            if (!isPlainObject(value)) fail('invalid_request');
            const keys = Object.keys(value).sort();
            const parts = keys.map((key) => {
                if (key === '__proto__') fail('invalid_request');
                return `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`;
            });
            return `{${parts.join(',')}}`;
        }
        default:
            return fail('invalid_request');
    }
}

// Canonical JSON: object keys sorted, array order preserved, JSON-only values.
export function canonicalJson(value) {
    return canonicalize(value, 0);
}

export function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function byteLength(value) {
    return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function isSafePositive(value) {
    return Number.isSafeInteger(value) && value > 0;
}

// Exactly LIMIT_KEYS, or LIMIT_KEYS plus every EXTENSION_LIMIT_KEYS entry, or both plus every
// S6_LIMIT_KEYS entry.
export function validateLimits(limits) {
    if (!isPlainObject(limits)) fail('invalid_request');
    const sets = [LIMIT_KEYS, [...LIMIT_KEYS, ...EXTENSION_LIMIT_KEYS], [...LIMIT_KEYS, ...EXTENSION_LIMIT_KEYS, ...S6_LIMIT_KEYS]];
    const keys = Object.keys(limits);
    const required = sets.find((set) => set.length === keys.length);
    if (!required) fail('invalid_request');
    for (const key of required) {
        if (!isSafePositive(limits[key])) fail('invalid_request');
    }
    return Object.freeze({ ...limits });
}

export function assertWithinBytes(value, limit) {
    if (byteLength(value) > limit) fail('invalid_request');
}

export function rejectAuthorityKeys(value, depth = 0) {
    if (depth > MAX_DEPTH) fail('invalid_request');
    if (Array.isArray(value)) {
        for (const item of value) rejectAuthorityKeys(item, depth + 1);
    } else if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            if (AUTHORITY_KEYS.has(key.toLowerCase())) fail('invalid_request');
            rejectAuthorityKeys(value[key], depth + 1);
        }
    }
}

export function exactObject(value, required, optional = []) {
    if (!isPlainObject(value)) fail('invalid_request');
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail('invalid_request');
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail('invalid_request');
    }
    return value;
}

export function validateName(value) {
    if (typeof value !== 'string') fail('invalid_request');
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) fail('invalid_request');
    return trimmed;
}

// Operation IDs are any 22 base64url characters: origin-derived IDs are a truncated digest.
export function isOperationId(value) {
    return typeof value === 'string' && value.length === 22 && BASE64URL.test(value);
}

export function validateOperationId(value) {
    if (!isOperationId(value)) fail('invalid_request');
    return value;
}

export function validateInternalId(value) {
    if (!isInternalId(value)) fail('invalid_request');
    return value;
}

export function validateRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_request');
    return value;
}

const BACKEND = /^[a-z][a-z0-9_-]{0,63}$/;

// Configuration: {backend, settings}; settings is a JSON object without authority keys.
export function validateConfiguration(value, limits) {
    exactObject(value, ['backend'], ['settings']);
    if (typeof value.backend !== 'string' || !BACKEND.test(value.backend)) fail('invalid_request');
    const settings = value.settings === undefined ? {} : value.settings;
    if (!isPlainObject(settings)) fail('invalid_request');
    rejectAuthorityKeys(settings);
    const normalized = { backend: value.backend, settings };
    assertWithinBytes(normalized, limits.requestBytes);
    return normalized;
}

// RoboTeam may carry a terminal phase's Environment selection (`repo/agent`) in the specification; blank or absent selects
// the ordinary worker backend. Existing-agent environments are not available in this version (r10 Q1 = A), so a nonempty
// selection is refused during admission validation: before any state access, persistence or process start. Only the
// admission validators call this (`validateAdmissionRequest`, and the obligation request in workerState.admitObligation).
// It is deliberately NOT part of `validateSpecification`, which also validates recorded outbox data that must stay
// applicable.
export function refuseEnvironmentSelection(specification) {
    if (!isPlainObject(specification) || !Object.hasOwn(specification, 'environment')) return;
    const { environment } = specification;
    if (typeof environment !== 'string') fail('invalid_request');
    if (environment.length > 0) fail('environment_unavailable');
}

export function validateSpecification(value, limits) {
    if (!isPlainObject(value)) fail('invalid_request');
    // Version 2 (execution specification, RoboWork r10 wiring) is validated field by field below.
    if (value.version === SPECIFICATION_VERSION_2) return validateSpecificationV2(value, limits);
    rejectAuthorityKeys(value);
    assertWithinBytes(value, limits.requestBytes);
    return value;
}

// Verified context: internal precondition, never deserialized from the network.
const VERIFIED = new WeakSet();

// Origin rows (interface note 2.3): mcp / user:<id>|agent:<principal>;
// coordinator:<principal> / owner:user:<id>|binding:<id>.
function validOriginRow(namespace, key) {
    if (namespace === 'mcp') return /^(user|agent):.+$/.test(key);
    if (/^coordinator:.+$/.test(namespace)) return /^(owner:user|binding):.+$/.test(key);
    return false;
}

function boundedString(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

// `robotOwnerId` (S1x, optional): the owner recorded on and compared against robot rows,
// for example `workspace:<id>` for workspace robots. Absent, robot rows use `ownerId`.
// `coordinator` (S6, optional): the verified coordinator principal of the hop that carried the
// request; obligation admission on the MCP row records it as the admitting coordinator.
export function createVerifiedContext(fields) {
    exactObject(fields, ['workspaceId', 'scope', 'ownerId', 'operations', 'originNamespace', 'originKey'], ['administrator', 'robotOwnerId', 'coordinator']);
    for (const key of ['workspaceId', 'scope', 'ownerId', 'originNamespace', 'originKey']) {
        if (!boundedString(fields[key])) fail('invalid_request');
    }
    if (!validOriginRow(fields.originNamespace, fields.originKey)) fail('invalid_request');
    if (!Array.isArray(fields.operations) || !fields.operations.every((op) => OPERATIONS.includes(op))) fail('invalid_request');
    if (fields.administrator !== undefined && typeof fields.administrator !== 'boolean') fail('invalid_request');
    if (fields.robotOwnerId !== undefined && !boundedString(fields.robotOwnerId)) fail('invalid_request');
    if (fields.coordinator !== undefined && !boundedString(fields.coordinator)) fail('invalid_request');
    const context = Object.freeze({
        workspaceId: fields.workspaceId,
        scope: fields.scope,
        ownerId: fields.ownerId,
        operations: Object.freeze([...fields.operations]),
        originNamespace: fields.originNamespace,
        originKey: fields.originKey,
        administrator: fields.administrator === true,
        robotOwnerId: fields.robotOwnerId === undefined ? null : fields.robotOwnerId,
        coordinator: fields.coordinator === undefined ? null : fields.coordinator
    });
    VERIFIED.add(context);
    return context;
}

// S1x service context: no origin row (originNamespace and originKey are null), for
// workspace robot lifecycle, readiness and robot reads. Admission, origin lookup, binding,
// control and reference observation refuse it.
export function createVerifiedServiceContext(fields) {
    exactObject(fields, ['workspaceId', 'scope', 'ownerId', 'robotOwnerId', 'operations'], ['administrator']);
    for (const key of ['workspaceId', 'scope', 'ownerId', 'robotOwnerId']) {
        if (!boundedString(fields[key])) fail('invalid_request');
    }
    if (!Array.isArray(fields.operations) || !fields.operations.every((op) => SERVICE_OPERATIONS.includes(op))) fail('invalid_request');
    if (fields.administrator !== undefined && typeof fields.administrator !== 'boolean') fail('invalid_request');
    const context = Object.freeze({
        workspaceId: fields.workspaceId,
        scope: fields.scope,
        ownerId: fields.ownerId,
        operations: Object.freeze([...fields.operations]),
        originNamespace: null,
        originKey: null,
        administrator: fields.administrator === true,
        robotOwnerId: fields.robotOwnerId
    });
    VERIFIED.add(context);
    return context;
}

// S6 coordinator context: the verified coordinator principal alone (no origin row, no user),
// for obligation accept, reject, list and outbox. Its scope holds the decision receipts.
export function createVerifiedCoordinatorContext(fields) {
    exactObject(fields, ['workspaceId', 'scope', 'coordinator', 'operations']);
    for (const key of ['workspaceId', 'scope', 'coordinator']) {
        if (!boundedString(fields[key])) fail('invalid_request');
    }
    if (!Array.isArray(fields.operations) || !fields.operations.every((op) => COORDINATOR_OPERATIONS.includes(op))) fail('invalid_request');
    const context = Object.freeze({
        workspaceId: fields.workspaceId,
        scope: fields.scope,
        ownerId: `coordinator:${fields.coordinator}`,
        operations: Object.freeze([...fields.operations]),
        originNamespace: null,
        originKey: null,
        administrator: false,
        robotOwnerId: null,
        coordinator: fields.coordinator
    });
    VERIFIED.add(context);
    return context;
}

export function hasOriginRow(context) {
    return context.originNamespace !== null && context.originKey !== null;
}

// The owner compared against and recorded on robot rows.
export function robotOwnerOf(context) {
    return context.robotOwnerId ?? context.ownerId;
}

export function requireContext(context, workspaceId, operation) {
    if (!VERIFIED.has(context)) fail('forbidden');
    if (context.workspaceId !== workspaceId) fail('forbidden');
    if (!context.operations.includes(operation)) fail('forbidden');
    return context;
}

// The operation ID of an admission is the first 22 base64url characters of SHA-256 over
// canonical {originNamespace, originKey, originRequestId} taken from the verified context.
export function deriveOperationId(context, originRequestId) {
    const hash = crypto.createHash('sha256')
        .update(canonicalJson({ originNamespace: context.originNamespace, originKey: context.originKey, originRequestId }))
        .digest('base64url');
    return hash.slice(0, 22);
}

// The internal logical ID of flow work admitted through the background row: the first 22
// base64url characters of SHA-256 over canonical {coordinator, bindingId}, in the style of
// deriveOperationId. Every phase under one binding shares it, and the same flow ID under
// another coordinator derives another one. It is never published: the wire `logical.id` of
// flow work is the binding ID itself.
export function deriveFlowLogicalId(coordinator, bindingId) {
    const hash = crypto.createHash('sha256').update(canonicalJson({ coordinator, bindingId })).digest('base64url');
    return hash.slice(0, 22);
}

// Lengths are counted in Unicode code points.
function codePoints(value) {
    return [...value].length;
}

function boundedText(value, min, max) {
    return typeof value === 'string' && codePoints(value) >= min && codePoints(value) <= max;
}

// A relative working directory: 1-4096 characters, no leading `/`, no `..` segment.
function isRelativeCwd(value) {
    return boundedText(value, 1, 4096) && !value.startsWith('/') && !value.split('/').includes('..');
}

export const TURN_PROMPT_MAX = 32768;

// Execution specification version 2 (task, continuation and turn kinds; wiring contract). Opaque to the S1 state
// except for this validation. Every path is an absolute workspace path; the worker re-resolves each one through the
// grant resolver, which refuses protected and out-of-workspace paths. The generic authority-key rejection is not
// applied (`folders[].path` is a legitimate key); every key is instead fixed by the exact schema below.
export const SPECIFICATION_VERSION_2 = 2;
export const SPEC_V2_PROMPT_MAX_BYTES = 1024 * 1024;
export const SPEC_V2_DISPLAY_MAX_BYTES = 256 * 1024;
export const SPEC_V2_MAX_FOLDERS = 32;
export const SPEC_V2_MAX_IGNORE = 64;
// M-22 skills view (T2): at most 64 skills, each {name, path, required?}, names unique. `path` is an absolute workspace path the worker
// resolves itself through the anchored grant resolver (never a RoboTeam resolution of it); `name` is the folder name the skill gets in the
// read-only view at /run/robo-work/skills/<name>. `skillsDigest` (present exactly when `skills` is) is the selection digest recorded with the
// admission: the SHA-256 hex of the canonical JSON of the `skills` array as sent, checked here so a mismatch is refused.
export const SPEC_V2_MAX_SKILLS = 64;
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// sessionId and turnId are safe opaque strings (ALA validates what it needs; a UUID is one such string).
const SPEC_OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SPEC_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SPEC_EFFORT = /^[A-Za-z0-9_-]{1,64}$/u;
const CODING_AGENTS = Object.freeze(['codex', 'claude', 'opencode', 'pi']);

function isSpecAbsolutePath(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || !value.startsWith('/')) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\') || value.includes('//')) return false;
    if (value.length > 1 && value.endsWith('/')) return false;
    return !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function specBytesBetween(value, min, max) {
    return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') >= min && Buffer.byteLength(value, 'utf8') <= max;
}

export function validateSpecificationV2(value, limits) {
    exactObject(value, ['version', 'prompt', 'displayText', 'sessionId', 'turnId', 'permissions'],
        ['cwd', 'model', 'effort', 'codingAgent', 'resume', 'folders', 'ignore', 'mcpServers', 'workflowExecution', 'humanInput', 'environment', 'skills', 'skillsDigest']);
    if (value.version !== SPECIFICATION_VERSION_2) fail('invalid_request');
    if (!specBytesBetween(value.prompt, 1, SPEC_V2_PROMPT_MAX_BYTES)) fail('invalid_request');
    if (!specBytesBetween(value.displayText, 0, SPEC_V2_DISPLAY_MAX_BYTES)) fail('invalid_request');
    for (const key of ['sessionId', 'turnId']) {
        if (typeof value[key] !== 'string' || !SPEC_OPAQUE_ID.test(value[key])) fail('invalid_request');
    }
    // No `cwd` means no project is selected (M-20): ALA starts in the robot HOME and has no project grant.
    if (value.cwd !== undefined && !isSpecAbsolutePath(value.cwd)) fail('invalid_request');
    if (value.permissions !== 'full-access' && value.permissions !== 'ask-for-approval') fail('invalid_request');
    if (value.model !== undefined && !boundedText(value.model, 1, 128)) fail('invalid_request');
    if (value.effort !== undefined && (typeof value.effort !== 'string' || !SPEC_EFFORT.test(value.effort))) fail('invalid_request');
    if (value.codingAgent !== undefined && !CODING_AGENTS.includes(value.codingAgent)) fail('invalid_request');
    for (const key of ['resume', 'workflowExecution', 'humanInput']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('invalid_request');
    }
    if (value.folders !== undefined) {
        if (!Array.isArray(value.folders) || value.folders.length > SPEC_V2_MAX_FOLDERS) fail('invalid_request');
        const aliases = new Set();
        for (const folder of value.folders) {
            // ALA folder syntax: `<path> [write] [as <alias> | at <absolute-path>] [expose]`. `expose` is a read-only mount with an
            // explicit destination, and `as` and `at` are alternatives.
            exactObject(folder, ['path', 'access'], ['as', 'at', 'expose']);
            if (!isSpecAbsolutePath(folder.path) || (folder.access !== 'read' && folder.access !== 'write')) fail('invalid_request');
            if (folder.at !== undefined && (!isSpecAbsolutePath(folder.at) || folder.as !== undefined)) fail('invalid_request');
            if (folder.expose !== undefined && (folder.expose !== true || folder.access !== 'read' || (folder.as === undefined && folder.at === undefined))) fail('invalid_request');
            if (folder.as !== undefined) {
                if (typeof folder.as !== 'string' || !SPEC_ALIAS.test(folder.as) || aliases.has(folder.as)) fail('invalid_request');
                aliases.add(folder.as);
            }
        }
    }
    if (value.ignore !== undefined) {
        if (!Array.isArray(value.ignore) || value.ignore.length > SPEC_V2_MAX_IGNORE || !value.ignore.every(isSpecAbsolutePath)) fail('invalid_request');
    }
    validateSpecSkills(value);
    // eslint-disable-next-line no-control-regex
    if (value.mcpServers !== undefined && (typeof value.mcpServers !== 'string' || value.mcpServers.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.mcpServers))) fail('invalid_request');
    assertWithinBytes(value, limits.requestBytes);
    return value;
}

// The digest of a skills selection: SHA-256 hex over its canonical JSON (keys sorted, order kept).
export function skillsSelectionDigest(skills) {
    return crypto.createHash('sha256').update(canonicalJson(skills)).digest('hex');
}

function validateSpecSkills(value) {
    if (value.skills === undefined) {
        if (value.skillsDigest !== undefined) fail('invalid_request');
        return;
    }
    if (!Array.isArray(value.skills) || value.skills.length > SPEC_V2_MAX_SKILLS) fail('invalid_request');
    const names = new Set();
    for (const skill of value.skills) {
        exactObject(skill, ['name', 'path'], ['required']);
        if (typeof skill.name !== 'string' || !SKILL_NAME.test(skill.name) || names.has(skill.name)) fail('invalid_request');
        names.add(skill.name);
        // Absolute, normalized, never the filesystem root; the worker also refuses the workspace root and anything outside it.
        if (!isSpecAbsolutePath(skill.path) || skill.path === '/') fail('invalid_request');
        if (skill.required !== undefined && typeof skill.required !== 'boolean') fail('invalid_request');
    }
    if (typeof value.skillsDigest !== 'string' || value.skillsDigest !== skillsSelectionDigest(value.skills)) fail('invalid_request');
}

// Turn specification version 1 (provisional; interface note 2.3 (9)): exactly
// {version: 1, prompt, model?, effort?, cwd?}. Attachments, references and live skills are
// deferred to the cutover. No authority-named key may appear at any depth.
export function validateTurnSpecification(value, limits) {
    if (isPlainObject(value) && value.version === SPECIFICATION_VERSION_2) return validateSpecificationV2(value, limits);
    exactObject(value, ['version', 'prompt'], ['model', 'effort', 'cwd']);
    if (value.version !== 1) fail('invalid_request');
    if (!boundedText(value.prompt, 1, TURN_PROMPT_MAX)) fail('invalid_request');
    for (const key of ['model', 'effort']) {
        if (value[key] !== undefined && !boundedText(value[key], 1, 128)) fail('invalid_request');
    }
    if (value.cwd !== undefined && !isRelativeCwd(value.cwd)) fail('invalid_request');
    return validateSpecification(value, limits);
}

export function validateAttemptOutcome(outcome, limits) {
    exactObject(outcome, ['classification'], ['outputText', 'data']);
    if (!END_CLASSIFICATIONS.includes(outcome.classification)) fail('invalid_request');
    const outputText = outcome.outputText === undefined ? '' : outcome.outputText;
    if (typeof outputText !== 'string') fail('invalid_request');
    const data = outcome.data === undefined ? null : outcome.data;
    const payload = { outputText, data };
    if (byteLength(payload) > limits.resultBytes) fail('invalid_request');
    return { classification: outcome.classification, payload };
}

export function validateAdmissionRequest(request, limits) {
    exactObject(request, ['operationId', 'originRequestId', 'robotId', 'configRevision', 'kind', 'logical', 'specification']);
    validateOperationId(request.operationId);
    if (!isOriginId(request.originRequestId)) fail('invalid_request');
    validateInternalId(request.robotId);
    if (!Number.isSafeInteger(request.configRevision) || request.configRevision < 1) fail('invalid_request');
    if (!ADMISSION_KINDS.includes(request.kind)) fail('invalid_request');
    // Every row (owner, MCP, background) and every kind (task, continuation, turn) reaches this validator before any state access.
    refuseEnvironmentSelection(request.specification);
    if (request.kind === 'turn') {
        exactObject(request.logical, ['sessionKey']);
        if (!isSessionKey(request.logical.sessionKey)) fail('invalid_request');
        validateTurnSpecification(request.specification, limits);
        return request;
    }
    exactObject(request.logical, [], ['logicalId']);
    if (request.kind === 'task' && request.logical.logicalId !== undefined) fail('invalid_request');
    if (request.kind === 'continuation') validateInternalId(request.logical.logicalId);
    validateSpecification(request.specification, limits);
    return request;
}
