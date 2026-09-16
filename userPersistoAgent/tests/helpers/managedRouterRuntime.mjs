import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Managed Ploinky runtime fixture for UserPersisto tests. It uses the real
// Ploinky Agent runtime and production descriptor signer: a signed generated
// Router descriptor, the provenance-marked environment an agent receives, an
// advisory edge topology file, and a private listener under test control.

export const USERPERSISTO_IDENTITY = Object.freeze({
    agentId: 'agent:AssistOSExplorer/userPersistoAgent',
    instanceId: '0b7a3c52-9d44-4c8e-8f11-3a2b1c0d9e8f',
    enableGeneration: '5c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f',
});

const ACTIVE_GENERATION = `sha256:${'c'.repeat(64)}`;
const MANAGED_ENV_PATTERN = /^(?:PLOINKY_|USERPERSISTO_TRUST_ROUTER_ORIGINS$)/;

export function resolvePloinkyRoot() {
    const root = [
        process.env.PLOINKY_ROOT,
        fileURLToPath(new URL('../../../../ploinky', import.meta.url)),
        fileURLToPath(new URL('../../../../../ploinky', import.meta.url)),
    ].filter(Boolean).find((candidate) => (
        existsSync(join(candidate, 'Agent/lib/runtimeRouterOrigins.mjs'))
        && existsSync(join(candidate, 'cli/utils/security/generatedRouterDescriptor.js'))
    ));
    if (!root) {
        throw new Error('Managed Router origin tests require PLOINKY_ROOT pointing to a Ploinky checkout with runtime Router origins.');
    }
    return root;
}

/**
 * Select an isolated Ploinky workspace for this test process. Call before any
 * Ploinky CLI module is imported: its configuration binds the workspace root
 * at import time, and descriptor signing keeps its identity key there.
 */
export function isolatePloinkyWorkspace() {
    const workspace = mkdtempSync(join(tmpdir(), 'userpersisto-managed-ploinky-'));
    mkdirSync(join(workspace, '.ploinky'), { recursive: true });
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_MASTER_KEY ||= '7'.repeat(64);
    return workspace;
}

async function ploinkyModule(root, relativePath) {
    return import(pathToFileURL(join(root, relativePath)).href);
}

export async function createManagedAgentEnvironment({
    workspace,
    internalRouterUrl,
    edgeTopologyFile,
    identity = USERPERSISTO_IDENTITY,
    ploinkyRoot = resolvePloinkyRoot(),
    agentRuntimeRoot = join(ploinkyRoot, 'Agent'),
} = {}) {
    const descriptor = await ploinkyModule(ploinkyRoot, 'cli/utils/security/generatedRouterDescriptor.js');
    const { buildSubjectIdentityKey } = await ploinkyModule(ploinkyRoot, 'cli/utils/security/subjectIdentityKey.js');
    const { derivePrivateAgentRequestSecret } = await ploinkyModule(ploinkyRoot, 'cli/utils/security/masterKey.js');
    const payload = descriptor.createGeneratedRouterDescriptorPayload({
        agentPrincipal: identity.agentId,
        attestationId: `sha256:${'3'.repeat(64)}`,
        edgeTopologyFile,
        generationId: identity.enableGeneration,
        instanceId: identity.instanceId,
        internalRouterUrl,
        issuedAtUnixMs: Date.now(),
        launchId: randomUUID(),
        listenerClass: 'managed',
        networkFingerprint: `sha256:${'1'.repeat(64)}`,
        physicalOrigin: 'http://host.containers.internal:8080',
        publicAuthority: '127.0.0.1:3000',
        requestAuthority: 'host.containers.internal:8080',
        routerHost: 'host.containers.internal',
        routerPort: '8080',
        runtimeProof: { backend: 'netavark', engine: 'podman', remote: false, rootless: true },
        socketLocalAddressClass: 'managed',
        topology: 'native-linux-rootless-managed',
    });
    const signed = descriptor.signGeneratedRouterDescriptorEnvelope(payload);
    const descriptorFile = join(workspace, `router-descriptor-${randomUUID()}.json`);
    descriptor.writeGeneratedRouterDescriptorFile(descriptorFile, signed.bytes);
    return {
        ...descriptor.buildGeneratedRouterDescriptorEnv(payload, { descriptorFile }),
        PLOINKY_AGENT_API_PUBLIC_KEY: signed.publicKey,
        PLOINKY_AGENT_API_KEY: buildSubjectIdentityKey(identity.agentId),
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
            identity.agentId,
            identity.instanceId,
            identity.enableGeneration,
        ),
        PLOINKY_AGENT_RUNTIME_ROOT: agentRuntimeRoot,
    };
}

export function writeTopology(file, { routerOrigins, omitRouterOrigins = false, raw } = {}) {
    mkdirSync(join(file, '..'), { recursive: true });
    if (raw !== undefined) {
        writeFileSync(file, raw);
        return;
    }
    writeFileSync(file, JSON.stringify({
        configurationGeneration: `sha256:${'d'.repeat(64)}`,
        authorizationGeneration: ACTIVE_GENERATION,
        publicationGeneration: 1,
        state: 'ready',
        ...(omitRouterOrigins ? {} : { routerOrigins: routerOrigins || [] }),
    }));
}

const PRESERVED_ENV = new Set(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY', 'PLOINKY_AGENTLIB_DIR',
    'PLOINKY_AGENTLIB_MODE', 'PLOINKY_AGENTLIB_FINGERPRINT', 'PLOINKY_AGENTLIB_COMMIT', 'PLOINKY_AGENTLIB_SOURCE_ID',
    'PLOINKY_TEST_AGENTLIB_DIR', 'PLOINKY_ROOT', 'PLOINKY_AGENT_SECRET']);
const RESTORED_TESTS = new WeakSet();

function agentOwnedNames() {
    return Object.keys(process.env).filter((name) => MANAGED_ENV_PATTERN.test(name) && !PRESERVED_ENV.has(name));
}

/**
 * Replace the Ploinky-owned part of process.env for one test. The baseline is
 * captured once per test and restored after it, however often the test swaps
 * runtimes. Unrelated variables (persistence, settings, AgentLib) stay put.
 */
export function applyAgentEnvironment(t, env) {
    if (!RESTORED_TESTS.has(t)) {
        RESTORED_TESTS.add(t);
        const baseline = Object.fromEntries(agentOwnedNames().map((name) => [name, process.env[name]]));
        t.after(() => {
            for (const name of agentOwnedNames()) delete process.env[name];
            Object.assign(process.env, baseline);
        });
    }
    for (const name of agentOwnedNames()) delete process.env[name];
    Object.assign(process.env, env);
}

/** A private Router listener whose runtime-origins answer the test controls. */
export async function startRuntimeOriginsListener(t, { origins = [] } = {}) {
    const state = { origins: [...origins], failure: null, requests: [], activationId: randomUUID() };
    const server = http.createServer((req, res) => {
        state.requests.push({ method: req.method, url: req.url, assertion: req.headers['ploinky-agent-assertion'] || '' });
        const [status, body] = state.failure
            ? [state.failure.status, { ok: false, error: state.failure.code }]
            : [200, {
                schemaVersion: 1,
                authorizationGeneration: ACTIVE_GENERATION,
                activationId: state.activationId,
                routerOrigins: [...state.origins].sort(),
            }];
        const payload = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        setOrigins(next) {
            state.origins = [...next];
            state.failure = null;
            state.activationId = randomUUID();
        },
        fail(status, code) {
            state.failure = { status, code };
        },
    };
}

/**
 * One complete managed agent runtime: topology file, private listener, and
 * signed descriptor environment applied to process.env for the test.
 */
export async function useManagedRuntime(t, {
    workspace,
    origins = [],
    omitRouterOrigins = false,
    agentRuntimeRoot,
} = {}) {
    const directory = mkdtempSync(join(workspace, 'agent-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const topologyFile = join(directory, 'edge-topology', 'current.json');
    writeTopology(topologyFile, { routerOrigins: origins, omitRouterOrigins });
    const listener = await startRuntimeOriginsListener(t, { origins });
    const env = await createManagedAgentEnvironment({
        workspace: directory,
        internalRouterUrl: listener.url,
        edgeTopologyFile: topologyFile,
        ...(agentRuntimeRoot ? { agentRuntimeRoot } : {}),
    });
    applyAgentEnvironment(t, env);
    return { env, listener, topologyFile, directory };
}
