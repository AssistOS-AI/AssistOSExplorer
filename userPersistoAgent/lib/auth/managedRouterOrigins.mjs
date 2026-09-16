import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Workspace Router origins published by a managed Ploinky runtime.
//
// Ploinky reports the direct Router origins of the active workspace generation;
// trusting them for authentication is this agent's decision. The advisory edge
// topology only advertises the capability. Every decision that relies on a
// managed origin performs a fresh authenticated read of the active generation,
// so a rebind, port change, removal or rollback applies to the next decision
// without persisting anything. Loopback and configured origins never need it.

export const TRUST_ROUTER_ORIGINS_ENV = 'USERPERSISTO_TRUST_ROUTER_ORIGINS';
export const MANAGED_ORIGIN_UNAVAILABLE = 'auth_origin_topology_unavailable';
export const MANAGED_ORIGIN_INVALID = 'auth_origin_topology_invalid';

const MANAGED_RUNTIME_VARIABLES = [
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_AGENT_PRIVATE_SECRET',
];
const PUBLIC_MESSAGES = {
    [MANAGED_ORIGIN_UNAVAILABLE]: 'The workspace authentication addresses are temporarily unavailable. Try again after the workspace is ready.',
    [MANAGED_ORIGIN_INVALID]: 'The workspace authentication configuration is invalid. Contact the workspace administrator.',
};
let lastLoggedFailure = '';

function managedOriginError(code, reason) {
    return Object.assign(new Error(PUBLIC_MESSAGES[code]), { code, statusCode: 503, reason });
}

function logFailure(error) {
    // One safe line per distinct failure: no origins, tokens, paths or payloads.
    const key = `${error.code}:${error.reason}`;
    if (key === lastLoggedFailure) return;
    lastLoggedFailure = key;
    console.warn(`[userPersisto] managed Router origins ${error.code === MANAGED_ORIGIN_UNAVAILABLE ? 'unavailable' : 'invalid'} (${error.reason}).`);
}

/**
 * Automatic trust switch. Unset or empty keeps the default (enabled); only
 * `true` or `false` (case-insensitive, surrounding whitespace ignored) are
 * valid. Any other value is a configuration error, never an implicit choice.
 *
 * @returns {{ enabled: boolean, valid: boolean }}
 */
export function readTrustRouterOriginsSetting(env = process.env) {
    const raw = env[TRUST_ROUTER_ORIGINS_ENV];
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (raw === undefined || value === '') return { enabled: true, valid: true };
    if (value === 'true') return { enabled: true, valid: true };
    if (value === 'false') return { enabled: false, valid: true };
    return { enabled: false, valid: false };
}

/**
 * Whether this process runs under a Ploinky-managed runtime. The generated
 * Router descriptor contract and its provenance markers identify it; once any
 * part is present, a missing or broken remainder is an error, not standalone.
 */
export function isManagedRuntime(env = process.env) {
    return MANAGED_RUNTIME_VARIABLES.some((name) => typeof env[name] === 'string' && env[name] !== '')
        || Object.keys(env).some((name) => name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_'));
}

function runtimeModuleUrl(env, fileName) {
    const root = String(env.PLOINKY_AGENT_RUNTIME_ROOT || env.PLOINKY_AGENT_LIB_DIR || '/Agent').trim();
    return pathToFileURL(join(root, 'lib', fileName)).href;
}

async function importRuntime(env, fileName, exportName) {
    let module;
    try {
        module = await import(runtimeModuleUrl(env, fileName));
    } catch {
        throw managedOriginError(MANAGED_ORIGIN_INVALID, 'runtime-helper-unavailable');
    }
    if (typeof module[exportName] !== 'function') throw managedOriginError(MANAGED_ORIGIN_INVALID, 'runtime-helper-unsupported');
    return module[exportName];
}

async function readManagedTopology(env) {
    const file = String(env.PLOINKY_EDGE_TOPOLOGY_FILE || '').trim();
    if (!file) throw managedOriginError(MANAGED_ORIGIN_INVALID, 'topology-location-missing');
    const readEdgeTopology = await importRuntime(env, 'edgeTopology.mjs', 'readEdgeTopology');
    try {
        await access(file, constants.R_OK);
    } catch {
        throw managedOriginError(MANAGED_ORIGIN_UNAVAILABLE, 'topology-unreadable');
    }
    try {
        return readEdgeTopology({ file, env });
    } catch {
        throw managedOriginError(MANAGED_ORIGIN_INVALID, 'topology-invalid');
    }
}

async function fetchActiveOrigins(env) {
    const fetchRuntimeRouterOrigins = await importRuntime(env, 'runtimeRouterOrigins.mjs', 'fetchRuntimeRouterOrigins');
    try {
        const result = await fetchRuntimeRouterOrigins({ env });
        if (!Array.isArray(result?.routerOrigins) || typeof result.authorizationGeneration !== 'string') {
            throw new Error('unexpected Router origin result');
        }
        return result;
    } catch (error) {
        if (error?.code === 'RUNTIME_ROUTER_ORIGINS_UNAVAILABLE') {
            throw managedOriginError(MANAGED_ORIGIN_UNAVAILABLE, 'router-metadata-unavailable');
        }
        throw managedOriginError(MANAGED_ORIGIN_INVALID, 'router-metadata-invalid');
    }
}

/**
 * Resolve the managed origins for one decision. Never cached across calls.
 *
 * Resolves `{ state, origins, generation }` where state is `disabled`,
 * `standalone`, `unsupported` (a runtime without the capability) or `verified`.
 * Rejects with a typed 503 when a managed runtime that needs checking is
 * unavailable (`auth_origin_topology_unavailable`) or broken
 * (`auth_origin_topology_invalid`).
 */
export async function resolveManagedRouterOrigins({ env = process.env } = {}) {
    try {
        const setting = readTrustRouterOriginsSetting(env);
        if (!setting.valid) throw managedOriginError(MANAGED_ORIGIN_INVALID, 'trust-setting-invalid');
        if (!setting.enabled) return { state: 'disabled', origins: [], generation: '' };
        if (!isManagedRuntime(env)) return { state: 'standalone', origins: [], generation: '' };
        const topology = await readManagedTopology(env);
        // The generic reader validated the envelope. An absent field identifies
        // a runtime without this capability; a present one requires the
        // authoritative operation and never grants trust by itself.
        if (!Object.hasOwn(topology, 'routerOrigins')) return { state: 'unsupported', origins: [], generation: '' };
        if (!Array.isArray(topology.routerOrigins)) throw managedOriginError(MANAGED_ORIGIN_INVALID, 'topology-invalid');
        const active = await fetchActiveOrigins(env);
        return {
            state: 'verified',
            origins: [...active.routerOrigins],
            generation: active.authorizationGeneration,
        };
    } catch (error) {
        if (error?.code === MANAGED_ORIGIN_UNAVAILABLE || error?.code === MANAGED_ORIGIN_INVALID) {
            logFailure(error);
            throw error;
        }
        const unexpected = managedOriginError(MANAGED_ORIGIN_INVALID, 'resolver-failed');
        logFailure(unexpected);
        throw unexpected;
    }
}

/**
 * Administrator status for display: the same fresh resolution, reported as
 * data instead of an authorization failure.
 */
export async function describeManagedRouterOrigins({ env = process.env } = {}) {
    const setting = readTrustRouterOriginsSetting(env);
    try {
        const resolved = await resolveManagedRouterOrigins({ env });
        return { enabled: setting.enabled, status: resolved.state, origins: resolved.origins, generation: resolved.generation };
    } catch (error) {
        const status = error.reason === 'trust-setting-invalid' ? 'invalid-setting'
            : error.code === MANAGED_ORIGIN_UNAVAILABLE ? 'unavailable' : 'invalid';
        return { enabled: setting.enabled, status, origins: [], generation: '' };
    }
}

export function resetManagedRouterOriginLogForTests() {
    lastLoggedFailure = '';
}
