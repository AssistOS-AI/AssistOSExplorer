import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { foldPathName } from '../views/protectedNames.mjs';
import { resolveGrant } from '../views/grantResolver.mjs';
import { ExecutionSetupError } from './setupError.mjs';

// The one place where the worker resolves a production grant (decision M-63, plan section 223: an active source repository is never a
// writable robot grant or working project; explicit read-only skill views stay permitted). This module alone imports the anchored grant
// resolver (views/grantResolver.mjs); the execution factory resolves every project grant and every skill folder through
// `resolveExecutionGrants`.
//
// Active runtime sources are the folders that RoboTeam, the worker or Ploinky run code from in the active routing generation: the
// repository of every enabled agent's code, the Ploinky Agent library, the AchillesAgentLib checkout selected in `local` mode and every
// link-installed repository. Ploinky's Router reports them, workspace-relative, on its private listener (`GET /api/edge/runtime-sources`,
// read with `fetchRuntimeSources` from `<Ploinky Agent dir>/lib/runtimeSources.mjs`). The worker adds its own ALA checkout.
//
// Fail closed for writable work only: when the list cannot be read, a launch that has a writable grant is refused
// `runtime_sources_unavailable` before any grant is opened; a launch with no grant or only read grants never asks for the list.
//
// Residuals (documented in the README): a source that becomes active while a robot already holds a write grant on it is caught by the
// recheck below within one tick (`source_activated`); bytes a robot wrote earlier persist, so an operator reviews a folder robots ever
// wrote before enabling, updating or link-installing an agent from it. A bind-mount alias of a source mounted inside a granted directory
// and a pre-existing file hard link into a source (both human-made) are not detected.

const KINDS = Object.freeze(['agent-repository', 'agent-library', 'agent-runtime-library', 'linked-repository']);
const MAX_SOURCES = 512;
const MAX_PATH_BYTES = 4096;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const RUNTIME_SOURCES_UNAVAILABLE = 'runtime_sources_unavailable';

// The grant role of a plan grant. A read-only folder below `.ploinky/repos/<repo>/` is a skill source (the resolver's only exemption
// for a managed source, never writable); every other grant, and every writable one (the cwd is always writable), is a project.
export function grantRoleFor(entry) {
    const segments = String(entry.relativePath).split('/');
    const managed = segments.length >= 4 && foldPathName(segments[0]) === '.ploinky' && segments[1] === 'repos';
    return managed && entry.access === 'read' ? 'skill-source' : 'project';
}

function validRelativePath(value) {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES
        && !value.startsWith('/') && !value.includes('\0')
        && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// The answer of the injected or default fetch, checked again here (the fetch is replaceable): null when it is not a usable list.
function validAnswer(answer) {
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null;
    const { sources, authorizationGeneration, outsideWorkspace } = answer;
    if (!Array.isArray(sources) || sources.length > MAX_SOURCES) return null;
    if (typeof authorizationGeneration !== 'string' || authorizationGeneration.length === 0 || authorizationGeneration.length > 128) return null;
    if (!Number.isSafeInteger(outsideWorkspace) || outsideWorkspace < 0) return null;
    for (const source of sources) {
        if (source === null || typeof source !== 'object' || !KINDS.includes(source.kind) || !validRelativePath(source.relativePath)) return null;
    }
    return { sources, authorizationGeneration, outsideWorkspace };
}

export function sourceCountsByKind(sources) {
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    for (const { kind } of sources) counts[kind] += 1;
    return counts;
}

// The default fetch: Ploinky's Agent-side reader, loaded lazily from `ROBO_WORK_PLOINKY_AGENT_DIR` (default `/Agent`, where Ploinky mounts
// its Agent library in every agent container). It signs a private agent assertion with the worker's own Ploinky identity.
export function defaultRuntimeSourcesFetch({ env = process.env } = {}) {
    const directory = String(env.ROBO_WORK_PLOINKY_AGENT_DIR || '/Agent').trim() || '/Agent';
    let reader = null;
    return async () => {
        reader ??= import(pathToFileURL(path.join(directory, 'lib', 'runtimeSources.mjs')).href).catch((error) => { reader = null; throw error; });
        const module = await reader;
        if (typeof module.fetchRuntimeSources !== 'function') throw new Error('fetchRuntimeSources is not available');
        return module.fetchRuntimeSources({ env });
    };
}

// createRuntimeSourceProvider({ workspaceRoot, localRoots, fetch, timeoutMs, realpath })
//   localRoots  absolute folders the worker itself runs code from (its ALA checkout), always listed
//   fetch       async () => { schemaVersion, authorizationGeneration, activationId, sources: [{ kind, relativePath }], outsideWorkspace }
// `locations()` asks afresh every time (no cache) and returns
//   { ok: true, locations: [{ label, path }], authorizationGeneration, counts, outsideWorkspace, localRoots }   or   { ok: false, code, cause }
// A throw, a malformed answer, a fetch that does not settle within `timeoutMs` or an unreadable workspace root is `ok: false`.
export function createRuntimeSourceProvider({ workspaceRoot, localRoots = [], fetch = defaultRuntimeSourcesFetch(), timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, realpath = (target) => fs.promises.realpath(target) } = {}) {
    if (typeof fetch !== 'function') throw new TypeError('A runtime sources fetch is required');
    const locals = localRoots.filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => ({ label: 'the worker\'s ALA', path: root }));
    const bounded = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('runtime sources timed out'), { code: 'RUNTIME_SOURCES_TIMEOUT' })), timeoutMs);
        timer.unref?.();
        Promise.resolve().then(() => fetch()).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
    return Object.freeze({
        async locations() {
            let answer;
            let rootReal;
            try {
                rootReal = await realpath(workspaceRoot);
                answer = validAnswer(await bounded());
            } catch (error) {
                return { ok: false, code: RUNTIME_SOURCES_UNAVAILABLE, cause: String(error?.code ?? error?.name ?? 'error').slice(0, 64) };
            }
            if (answer === null) return { ok: false, code: RUNTIME_SOURCES_UNAVAILABLE, cause: 'invalid_answer' };
            const locations = answer.sources.map(({ kind, relativePath }) => ({ label: `active source (${kind})`, path: path.join(rootReal, ...relativePath.split('/')) }));
            return {
                ok: true, locations: [...locations, ...locals], authorizationGeneration: answer.authorizationGeneration,
                counts: sourceCountsByKind(answer.sources), outsideWorkspace: answer.outsideWorkspace, localRoots: locals.length
            };
        }
    });
}

const refusalReason = (code) => `grant_${String(code).replace(/[^a-z_]/gu, '').slice(0, 40)}`;

// resolveExecutionGrants(entries, { workspaceRoot, workerStore, sourceProvider, log, onRefused, resolve })
//   entries     [{ relativePath, access, role? }] in order (role defaults to grantRoleFor)
//   onRefused   (entry, code, index) => reason   optional: the end reason for a resolver refusal (default `grant_<code>`)
// The provider is asked once, only when an entry is writable; `ok: false` throws ExecutionSetupError('runtime_sources_unavailable') before
// any grant is opened. Every entry is resolved with the worker store as a protected location (every mode) and, for a writable entry,
// the active sources. A refusal closes the grants this call opened and throws ExecutionSetupError(reason). Returns the grants in order.
// `resolve` is the anchored resolver itself (tests of this module only; the factory never passes it).
export async function resolveExecutionGrants(entries, { workspaceRoot, workerStore, sourceProvider, log = () => {}, onRefused = null, resolve = resolveGrant } = {}) {
    let sourceLocations = [];
    if (entries.some((entry) => entry.access === 'write')) {
        let answer;
        try {
            answer = sourceProvider ? await sourceProvider.locations() : { ok: false, code: RUNTIME_SOURCES_UNAVAILABLE, cause: 'no_provider' };
        } catch {
            answer = { ok: false, code: RUNTIME_SOURCES_UNAVAILABLE, cause: 'provider_failed' };
        }
        if (!answer?.ok || !Array.isArray(answer.locations)) {
            log('runtime_sources_unavailable', { purpose: 'launch', cause: answer?.cause ?? 'invalid_answer' });
            throw new ExecutionSetupError(RUNTIME_SOURCES_UNAVAILABLE);
        }
        // The live evidence of every launch-time fetch (counts only, never a path).
        log('runtime_sources_fetched', {
            purpose: 'launch', authorizationGeneration: answer.authorizationGeneration ?? null, sources: answer.counts ?? null,
            outsideWorkspace: answer.outsideWorkspace ?? null, localRoots: answer.localRoots ?? null
        });
        sourceLocations = answer.locations;
    }
    const protectedLocations = [{ label: 'the worker store', path: workerStore }];
    const grants = [];
    try {
        for (const [index, entry] of entries.entries()) {
            const result = await resolve({ role: entry.role ?? grantRoleFor(entry), access: entry.access, relativePath: entry.relativePath },
                { workspaceRoot, protectedLocations, sourceLocations: entry.access === 'write' ? sourceLocations : [] });
            if (!result.ok) throw new ExecutionSetupError(onRefused ? onRefused(entry, result.code, index) : refusalReason(result.code));
            grants.push(result.grant);
        }
        return grants;
    } catch (error) {
        for (const grant of grants) { try { await grant.close(); } catch { /* closed */ } }
        throw error;
    }
}

// The recheck of decision M-67 Q2: ONE shared timer per worker, running only while at least one attempt holds a writable grant. Each tick
// asks the provider once (a tick is skipped while the previous fetch is pending) and ends every registered attempt whose writable grant
// now lies inside, contains or aliases a source, through its `onOverlap(reason)` (the dispatcher's normal stop path, end reason
// `source_activated`). A fetch that fails does nothing; it is logged once per state change, as is a change of the generation or counts.
export const SOURCE_ACTIVATED = 'source_activated';

export function createSourceWatch({ provider, tickMs, timers = { setInterval, clearInterval }, log = () => {} }) {
    const watched = new Set();
    let timer = null;
    let inFlight = null; // the running tick: a tick that comes while it runs shares it (no second fetch)
    let lastState = null; // 'ok:<generation>:<counts>' | 'unavailable'

    const stopTimer = () => { if (timer !== null) { timers.clearInterval(timer); timer = null; } };

    async function check() {
        let answer;
        try { answer = await provider.locations(); } catch { answer = { ok: false, cause: 'provider_failed' }; }
        if (!answer?.ok || !Array.isArray(answer.locations)) {
            if (lastState !== 'unavailable') log('runtime_sources_recheck_unavailable', { cause: answer?.cause ?? 'invalid_answer' });
            lastState = 'unavailable';
            return;
        }
        const state = `ok:${answer.authorizationGeneration}:${JSON.stringify(answer.counts ?? null)}`;
        if (state !== lastState) {
            log('runtime_sources_fetched', { purpose: 'recheck', authorizationGeneration: answer.authorizationGeneration ?? null, sources: answer.counts ?? null, outsideWorkspace: answer.outsideWorkspace ?? null });
        }
        lastState = state;
        for (const entry of [...watched]) {
            let overlap = null;
            for (const grant of entry.grants) {
                try { overlap = await grant.sourceOverlap(answer.locations); } catch { overlap = null; }
                if (overlap) break;
            }
            // Revoked at most once, and only while the attempt is still registered (it may have ended during the fetch).
            if (overlap && watched.delete(entry)) {
                log('source_activated', { executionId: entry.executionId, code: overlap.code });
                try { entry.onOverlap(SOURCE_ACTIVATED); } catch { /* the owner logs its own failures */ }
            }
        }
        if (watched.size === 0) stopTimer();
    }

    function tick() {
        if (inFlight !== null) return inFlight;
        if (watched.size === 0 || !provider) return Promise.resolve();
        inFlight = check().finally(() => { inFlight = null; });
        return inFlight;
    }

    return Object.freeze({
        // Registers a running attempt with its writable grants; returns the unregister function. Read-only attempts are never registered.
        register({ executionId, grants, onOverlap }) {
            const writable = grants.filter((grant) => grant?.access === 'write' && typeof grant.sourceOverlap === 'function');
            if (writable.length === 0 || !provider) return () => {};
            const entry = { executionId, grants: writable, onOverlap };
            watched.add(entry);
            if (timer === null) {
                timer = timers.setInterval(() => { tick().catch(() => {}); }, tickMs);
                timer.unref?.();
            }
            return () => {
                watched.delete(entry);
                if (watched.size === 0) stopTimer();
            };
        },
        tick,
        get size() { return watched.size; },
        get running() { return timer !== null; }
    });
}
