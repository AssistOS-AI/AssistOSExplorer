// The supervisor's admission decisions for requests that a provider endpoint relays from ALA (plan sections 5.3, 5.5).
// The schema (providerSchema.mjs) says what a request looks like. This module says whether the admitted specification
// of one execution permits it. A request is refused, never weakened, and the refusal changes nothing.

import { virtualPathProblem } from './providerSchema.mjs';

export const PROCESS_CLASSES = Object.freeze(['run', 'session', 'service']);
export const ROBOT_HOME = '/home/robot';

// Variables the provider owns: HOME, the XDG directories and the native state paths. ALA cannot add them.
const PROVIDER_OWNED = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'PI_CODING_AGENT_DIR']);
// The explicit environment additions that ALA's adapters generate at cf2996dc (audited in coding-agents/provider-request.mjs,
// opencode-server.mjs): Claude Code IS_SANDBOX and DISABLE_AUTOUPDATER, Pi PI_OFFLINE and PI_SKIP_VERSION_CHECK, and OpenCode
// OPENCODE_ENABLE_EXA (0 or 1), OPENCODE_CONFIG_CONTENT (a JSON overlay) and OPENCODE_SERVER_PASSWORD (the random password of the
// loopback `opencode serve` that ALA itself talks to). Nothing inherited crosses the protocol (ALA forwards only additions) and an
// API key or token is not on the list. G5 and the image inventory fix the final set.
export const DEFAULT_ENV_ALLOWLIST = Object.freeze(['IS_SANDBOX', 'DISABLE_AUTOUPDATER', 'PI_OFFLINE',
    'PI_SKIP_VERSION_CHECK', 'OPENCODE_ENABLE_EXA', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT']);
const STREAM_BASENAME = /^[a-z0-9]{8,64}$/u;

const within = (child, parent) => child === parent || child.startsWith(`${parent}/`);
const refuse = (code, message) => ({ code, message });

// The admitted specification of one execution. grants are virtual paths with the access the robot holds.
export function createAdmission({
    grants, inventory, streamDirectory, tempRoots = ['/tmp'], networkModes = ['robot-egress', 'none'],
    envAllowlist = DEFAULT_ENV_ALLOWLIST, maxPathBytes = 1024
}) {
    for (const grant of grants) {
        if (virtualPathProblem(grant.path, maxPathBytes) || grant.path === '/' || !['read', 'write'].includes(grant.access)) {
            throw new TypeError('A grant needs a normalized absolute path other than the root and an access');
        }
    }
    if (virtualPathProblem(streamDirectory, maxPathBytes) || streamDirectory === '/') {
        throw new TypeError('The stream directory must be a normalized absolute path other than the root');
    }
    return Object.freeze({
        home: ROBOT_HOME,
        grants: Object.freeze(grants.map((grant) => Object.freeze({ ...grant }))),
        inventory: Object.freeze(inventory.map((entry) => Object.freeze({ ...entry }))),
        viewRoots: Object.freeze([ROBOT_HOME, ...tempRoots, ...grants.map((grant) => grant.path)]),
        networkModes: Object.freeze([...networkModes]),
        envAllowlist: Object.freeze(new Set(envAllowlist)),
        streamDirectory
    });
}

const inView = (path, admission) => admission.viewRoots.some((root) => within(path, root));

// Returns null when the request is admitted, otherwise { code, message } for the refusal.
export function admitStartRequest(request, admission) {
    if (!PROCESS_CLASSES.includes(request.processClass)) {
        return refuse('unknown_process_class', 'The process class is not known');
    }
    if (!admission.inventory.some((entry) => entry.name === request.executable)) {
        return refuse('executable_not_in_inventory', 'The executable is not a backend of the tool inventory');
    }
    if (request.home !== admission.home) return refuse('home_not_admitted', 'HOME must be the robot HOME');
    if (virtualPathProblem(request.cwd) || !inView(request.cwd, admission)) {
        return refuse('path_outside_view', 'The working directory is outside the admitted view');
    }
    for (const folder of request.folders) {
        if (virtualPathProblem(folder.path) || folder.path === '/') {
            return refuse('folder_not_granted', 'A folder is not a normalized path');
        }
        const grant = admission.grants.find((candidate) => within(folder.path, candidate.path));
        if (!grant) return refuse('folder_not_granted', 'A folder is outside the admitted grants');
        if (folder.access === 'write' && grant.access !== 'write') {
            return refuse('access_wider_than_grant', 'A folder asks for wider access than its grant');
        }
    }
    for (const name of Object.keys(request.env)) {
        if (PROVIDER_OWNED.has(name) || name.startsWith('XDG_')) {
            return refuse('environment_owned_by_provider', 'The provider owns this environment name');
        }
        if (!admission.envAllowlist.has(name)) {
            return refuse('environment_not_allowed', 'This environment name is not on the allowlist');
        }
    }
    for (const path of request.exclusions) {
        if (virtualPathProblem(path) || !inView(path, admission)) {
            return refuse('exclusion_not_enforceable', 'An exclusion lies outside the view and cannot be enforced');
        }
    }
    if (!admission.networkModes.includes(request.network)) {
        return refuse('network_not_admitted', 'The network mode is wider than the connection matrix');
    }
    if (request.requirements.privateProc !== true) {
        return refuse('private_proc_required', 'A private /proc is required and cannot be weakened');
    }
    return null;
}

// The stream paths that the endpoint listens on. The supervisor never connects anything to a path outside the
// endpoint's private stream directory, and asks for exactly the streams the request needs.
export function admitStreamPaths(streams, request, admission) {
    const needed = request.communication.stdin === 'pipe' ? ['stderr', 'stdin', 'stdout'] : ['stderr', 'stdout'];
    const given = Object.keys(streams).sort();
    if (given.join(',') !== needed.join(',')) return refuse('streams_mismatch', 'The streams do not match the request');
    const seen = new Set();
    for (const name of given) {
        const path = streams[name];
        const slash = path.lastIndexOf('/');
        if (path.slice(0, slash) !== admission.streamDirectory || !STREAM_BASENAME.test(path.slice(slash + 1))
            || seen.has(path)) {
            return refuse('stream_path_not_admitted', 'A stream path is outside the endpoint stream directory');
        }
        seen.add(path);
    }
    return null;
}
