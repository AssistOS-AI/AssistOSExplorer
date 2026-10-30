import crypto from 'node:crypto';
import path from 'node:path';

// Maps an admitted version-2 execution specification (wiring contract) to everything the dispatcher needs to run ALA in
// the orchestration domain: the grants to resolve, the virtual (in-sandbox) paths, ALA's argv and environment and the
// first control record. Pure and synchronous. The grant resolver, not this module, refuses protected and out-of-workspace
// paths (anchored, no-follow); this module only turns absolute workspace paths into workspace-relative requests and
// refuses a path outside the workspace or equal to its root.
//
// Virtual layout (the orchestration domain never sees a host path): grant i is `/projects/g<i>`; the robot HOME is
// /home/robot; the managed configuration is /config/ala.json; ALA's session storage is /session.

export const VIRTUAL_HOME = '/home/robot';
export const VIRTUAL_CONFIG = '/config/ala.json';
export const VIRTUAL_SESSIONS = '/session';
export const VIRTUAL_PROJECTS = '/projects';

export class PlanError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'PlanError';
        this.reason = reason;
    }
}

// ALA at cf2996dc (controlled-execution.mjs): a prompt or displayText of at most 1 Mi characters, in a first record of at most 2 Mi
// characters. An oversize first record is dropped and ALA then waits for a prompt until stdin closes, with no stall deadline, so the
// plan refuses it up front instead.
export const ALA_MAX_PROMPT_CHARS = 1024 * 1024;
export const ALA_MAX_RECORD_CHARS = 2 * ALA_MAX_PROMPT_CHARS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ALA persists a conversation under a UUID, while the specification carries a safe opaque id. A UUID is used as it is; any
// other id maps to a stable name-based UUID, so a resumed conversation finds its transcript again.
export function alaSessionId(sessionId) {
    if (UUID.test(sessionId)) return sessionId.toLowerCase();
    const bytes = crypto.createHash('sha256').update(`robo-work-session:${sessionId}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ALA accepts only letters, digits, dashes and underscores in a turn id.
export const alaTurnId = (turnId) => turnId.replace(/[^A-Za-z0-9_-]/gu, '_');

const within = (child, parent) => child.startsWith(`${parent}/`);

function relativeToWorkspace(workspaceRoot, absolute) {
    if (absolute === workspaceRoot) throw new PlanError('workspace_root_not_granted');
    if (!within(absolute, workspaceRoot)) throw new PlanError('path_outside_workspace');
    return absolute.slice(workspaceRoot.length + 1);
}

// `workspaceRoot`: the canonical absolute workspace path (no trailing slash). Throws PlanError with a bounded reason.
export function planAlaExecution({ specification, workspaceRoot }) {
    if (specification?.version !== 2) throw new PlanError('unsupported_specification');
    if (specification.permissions !== 'full-access') throw new PlanError('approval_unsupported');
    if (typeof workspaceRoot !== 'string' || !path.posix.isAbsolute(workspaceRoot) || workspaceRoot === '/') throw new PlanError('workspace_unavailable');
    const root = workspaceRoot.replace(/\/+$/u, '');

    const grants = [];
    const byHostPath = new Map();
    const grantFor = (hostPath, access) => {
        const existing = byHostPath.get(hostPath);
        if (existing) {
            if (access === 'write') existing.access = 'write';
            return existing;
        }
        const index = grants.length;
        const grant = { name: `g${index}`, path: `${VIRTUAL_PROJECTS}/g${index}`, access, hostPath, relativePath: relativeToWorkspace(root, hostPath) };
        grants.push(grant);
        byHostPath.set(hostPath, grant);
        return grant;
    };

    // Protocol-mode ALA refuses `--folder … as|at|expose` ("not available when an execution provider owns the mounts",
    // virtual-paths.mjs:52-53): the provider mounts fixed workload paths. The specification may carry the modifiers, but they cannot run.
    if ((specification.folders ?? []).some((folder) => folder.as !== undefined || folder.at !== undefined || folder.expose !== undefined)) {
        throw new PlanError('folder_modifier_unsupported');
    }
    const prompt = Object.freeze({ type: 'prompt', prompt: specification.prompt, displayText: specification.displayText });
    if (specification.prompt.length > ALA_MAX_PROMPT_CHARS || specification.displayText.length > ALA_MAX_PROMPT_CHARS
        || JSON.stringify(prompt).length > ALA_MAX_RECORD_CHARS) {
        throw new PlanError('prompt_too_large');
    }

    // M-20: a specification without `cwd` selects no project. ALA starts in the robot HOME and the plan has no project grant (R05);
    // `cwd` (or a folder) equal to the workspace root, or any whole-workspace grant, stays refused.
    const cwd = specification.cwd === undefined ? null : grantFor(specification.cwd, 'write');
    const folders = (specification.folders ?? []).map((folder) => grantFor(folder.path, folder.access));

    // A host path inside a grant, as the sandbox sees it.
    const virtualOf = (absolute) => {
        const owner = grants.filter((grant) => absolute === grant.hostPath || within(absolute, grant.hostPath))
            .sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
        return owner ? (absolute === owner.hostPath ? owner.path : `${owner.path}${absolute.slice(owner.hostPath.length)}`) : null;
    };

    const ignore = [];
    for (const absolute of specification.ignore ?? []) {
        // A path outside every grant is not in the view, so there is nothing to mask.
        const virtual = virtualOf(absolute);
        if (virtual !== null) ignore.push(virtual);
    }

    const argv = ['--execution-provider', 'protocol', '--home', VIRTUAL_HOME, '--config', VIRTUAL_CONFIG, '--cwd', cwd === null ? VIRTUAL_HOME : cwd.path,
        '--session-id', alaSessionId(specification.sessionId), '--turn-id', alaTurnId(specification.turnId), '--control-stdin', '--permissions', specification.permissions];
    if (specification.model !== undefined) argv.push('--model', specification.model, '--effort', specification.effort ?? 'default');
    else if (specification.effort !== undefined) argv.push('--effort', specification.effort);
    if (specification.codingAgent !== undefined) argv.push('--ca', specification.codingAgent);
    const emitted = new Set(cwd === null ? [] : [cwd]);
    for (const grant of folders) {
        // The cwd grant is already mounted writable, and ALA refuses a folder that duplicates the working directory.
        if (emitted.has(grant)) continue;
        argv.push('--folder', grant.path);
        if (grant.access === 'write') argv.push('write');
        emitted.add(grant);
    }
    for (const virtual of ignore) argv.push('--ignore', virtual);
    if (specification.resume === true) argv.push('--resume-session');
    if (specification.mcpServers !== undefined) argv.push('--MCPServers', specification.mcpServers);

    return Object.freeze({
        grants: Object.freeze(grants.map((grant) => Object.freeze({ ...grant }))),
        cwd: cwd === null ? VIRTUAL_HOME : cwd.path,
        argv: Object.freeze(argv),
        env: Object.freeze({ ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: VIRTUAL_SESSIONS }),
        prompt
    });
}
