import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// WebChat envelopes minted by the sibling Ploinky checkout's real Router path
// (envelope serializer and MCP invocation minter) inside an isolated Router
// workspace. Router modules bind the workspace and master key at import time,
// so importing this helper configures the whole test process (each test file
// runs in its own process). Call restore() from test.after.
export const PLOINKY_ROOT = fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
export const AUDIENCE = 'agent:AchillesIDE/roboTeamAgent';

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
export const routerRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-router-')));
for (const key of Object.keys(process.env)) if (/^(PLOINKY_|SSO_)/u.test(key) && key !== 'PLOINKY_AGENTLIB_DIR') delete process.env[key];
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
process.env.PLOINKY_WORKSPACE_ROOT = routerRoot;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.chdir(routerRoot);
const load = (relative) => import(pathToFileURL(path.join(PLOINKY_ROOT, relative)).href);
const fixtureAgent = path.join(routerRoot, 'fixture-agent');
await fs.mkdir(fixtureAgent);
await fs.writeFile(path.join(fixtureAgent, 'manifest.json'), JSON.stringify({ webchat: { forwardEnvelope: true } }));
for (const [name, value] of Object.entries({
    'routing.json': { routes: { roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent', container: 'ls-router', hostPath: fixtureAgent, hostPort: 7402 } } },
    'agents.json': { 'ls-router': { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent', instanceId: 'ls-router', enableGeneration: 'ls-router', auth: { mode: 'none' } } },
    'data/edge-routing/desired.json': { hosts: {} },
    'data/router-security/policy-state.json': { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
})) {
    const file = path.join(routerRoot, '.ploinky', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
const { applyEdgeRoutingGeneration } = await load('cli/sandbox/edgeGeneration.js');
applyEdgeRoutingGeneration({ workspaceRoot: routerRoot, reason: 'live-sessions-publisher-test' });
const { serializeWebchatEnvelopeForAgent, buildWebchatInvocationArgs } = await load('cli/server/handlers/webchat/messageEnvelope.js');
const { deriveAgentRequestSecret } = await load('cli/utils/security/masterKey.js');
export { buildWebchatInvocationArgs };

// The Agent runtime environment of the RoboTeam service that verifies claims.
export const AGENT_ENV = Object.freeze({ PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AUDIENCE,
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AUDIENCE, { encoding: 'hex' }) });

// The envelope the Router forwards to the copilot for one WebChat message.
export function mintWebchatEnvelope({ user = { id: 'owner-1', roles: ['user'] }, tabId = 'ls-tab', pageInstanceId = 'ls-page',
    envelope = {}, effectiveConfig = { agentName: 'roboTeamAgent', runtimeScope: 'principal' } } = {}) {
    const req = { headers: { host: 'localhost' }, socket: {}, user, authMode: 'sso' };
    return serializeWebchatEnvelopeForAgent({ req, effectiveConfig, tabId, pageInstanceId,
        envelope: { text: 'Live session owner claim', attachments: [], references: [], presentation: { visible: true }, ...envelope } });
}

export async function restoreRouterEnvironment() {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(routerRoot, { recursive: true, force: true });
}
