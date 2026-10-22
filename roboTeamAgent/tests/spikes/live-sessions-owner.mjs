import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Revision of the exact repository root whose modules the probe imports. Dirty
// means tracked changes; ignored dependencies and untracked files are excluded.
export function sourceRevision(root) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    assert.equal(git('rev-parse', '--show-toplevel'), root, 'Ploinky source must be a repository root');
    const revision = git('rev-parse', 'HEAD');
    assert.match(revision, /^[a-f0-9]{40}$/);
    return { revision, dirty: git('status', '--porcelain', '--untracked-files=no') !== '' };
}

// Standalone process only: Router modules bind the workspace at import time.
// Never run against a deployed Router or use its credentials.
export async function runOwnerProbe(ploinkyRoot) {
    const ploinky = sourceRevision(ploinkyRoot);
    const harnessSha256 = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p3-owner-')));
    const originalCwd = process.cwd();
    const saved = { ...process.env };
    const load = relative => import(pathToFileURL(path.join(ploinkyRoot, relative)).href);
    try {
        for (const key of Object.keys(process.env)) {
            if (/^(PLOINKY_|SSO_)/.test(key) && key !== 'PLOINKY_AGENTLIB_DIR') delete process.env[key];
        }
        process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
        process.env.PLOINKY_WORKSPACE_ROOT = root;
        process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
        process.chdir(root);
        const marker = await load('ploinky-box/lib/boxMarker.mjs');
        assert.equal(marker.isInsideBox(), false, 'Owner fixture must run outside a managed Box credential context');
        const fixtureAgent = path.join(root, 'fixture-agent');
        await fs.mkdir(fixtureAgent);
        await fs.writeFile(path.join(fixtureAgent, 'manifest.json'), JSON.stringify({ webchat: { forwardEnvelope: true } }));
        const files = {
            'routing.json': { routes: { roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent',
                container: 'p3-fixture', hostPath: fixtureAgent, hostPort: 7402 } } },
            'agents.json': { 'p3-fixture': { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent',
                instanceId: 'p3-fixture', enableGeneration: 'p3-fixture', auth: { mode: 'none' } } },
            'data/edge-routing/desired.json': { hosts: {} },
            'data/router-security/policy-state.json': { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
        };
        for (const [name, value] of Object.entries(files)) {
            const file = path.join(root, '.ploinky', name);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
        }
        const { applyEdgeRoutingGeneration } = await load('cli/sandbox/edgeGeneration.js');
        applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'isolated-owner-spike' });
        const { serializeWebchatEnvelopeForAgent } = await load('cli/server/handlers/webchat/messageEnvelope.js');
        const { deriveAgentRequestSecret } = await load('cli/utils/security/masterKey.js');
        const { verifyRouterRequestFromHeaders } = await load('Agent/lib/invocationAuth.mjs');
        const { computeRchTool } = await load('Agent/lib/requestHash.mjs');
        const { createMemoryReplayCache, DEFAULT_CLOCK_SKEW_SECONDS } = await load('Agent/lib/jwtVerify.mjs');
        const { createWebchatDispatcher } = await import('../../copilot/src/lib/webchat/webchatRuntime.mjs');
        const audience = 'agent:AchillesIDE/roboTeamAgent';
        const env = { PLOINKY_AGENT_ID: audience, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(audience, { encoding: 'hex' }) };
        const mint = tabId => JSON.parse(serializeWebchatEnvelopeForAgent({
            req: { headers: { host: 'localhost' }, socket: {}, user: { id: 'p3-user', roles: ['user'] }, authMode: 'sso' },
            effectiveConfig: { agentName: 'roboTeamAgent' }, tabId, pageInstanceId: 'p3-page',
            envelope: { text: 'Diagnostic message', attachments: [], references: [], presentation: { visible: true } },
        }));
        const argsOf = raw => ({ surface: 'webchat', tabId: raw.sourceTabId, pageInstanceId: raw.sourcePageInstanceId,
            text: raw.text, attachments: raw.attachments, references: raw.references || [], presentation: raw.presentation });
        const verify = (raw, options = {}) => verifyRouterRequestFromHeaders({ authorization: `Bearer ${raw.invocation?.token}` }, {
            env, method: 'POST', path: '/mcp', tool: '__webchat_message__',
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: argsOf(raw) }),
            ...options,
        });
        const first = mint('first');
        assert.ok(first.invocation?.token, 'real Router serializer must mint a token');
        const replayCache = createMemoryReplayCache({ maxSize: 64 });
        const admitted = verify(first, { replayCache });
        assert.equal(admitted.ok, true);
        assert.equal(admitted.payload.aud, audience);
        assert.equal(admitted.payload.actor.id, admitted.payload.sub);
        assert.equal(admitted.payload.actor.kind, 'user');
        assert.equal(admitted.payload.exp - admitted.payload.iat, 30);
        assert.ok(admitted.payload.jti);
        assert.equal(verify(first, { replayCache }).ok, false, 'jti replay');
        const tupleControl = mint('wrong-tuple');
        const fullTuple = verify(tupleControl, { replayCache: createMemoryReplayCache({ maxSize: 64 }) });
        assert.equal(fullTuple.ok, true, 'fresh real Router token accepts the full request tuple');
        const innerArgsHash = computeRchTool(argsOf(tupleControl));
        assert.notEqual(innerArgsHash, fullTuple.payload.rch);
        const wrongTuple = verify(tupleControl, {
            rch: innerArgsHash,
            replayCache: createMemoryReplayCache({ maxSize: 64 }),
        });
        assert.equal(wrongTuple.ok, false, 'hashing only inner arguments must be refused');
        assert.equal(wrongTuple.reason, 'jwtVerify: request hash mismatch', 'replay or another failure must not mask the wrong tuple');
        for (const change of [raw => { raw.text += 'changed'; }, raw => { raw.presentation.visible = false; },
            raw => { raw.sourceTabId = 'other'; }, raw => { raw.sourcePageInstanceId = 'other'; },
            raw => { raw.attachments = [{ filename: 'changed' }]; }, raw => { raw.references = [{ kind: 'workspace-path', path: 'changed' }]; }]) {
            const raw = mint('tamper'); change(raw); assert.equal(verify(raw).ok, false);
        }
        assert.equal(verify(mint('tool'), { tool: 'wrong-tool' }).ok, false);
        assert.equal(verify(mint('audience'), { env: { ...env, PLOINKY_AGENT_ID: 'agent:other/other' } }).ok, false);
        assert.equal(verify(mint('method'), { method: 'GET' }).ok, false);
        assert.equal(verify(mint('path'), { path: '/other' }).ok, false);

        // Admission wraps the real receive boundary in this diagnostic harness.
        // The real dispatcher's asynchronous session/model selection holds the
        // second message while an independent first conversation executes.
        const claims = new Map();
        const started = [];
        let releasePreparation, releaseFirst, signalFirst;
        const preparation = new Promise(resolve => { releasePreparation = resolve; });
        const firstRunning = new Promise(resolve => { signalFirst = resolve; });
        const firstFinish = new Promise(resolve => { releaseFirst = resolve; });
        let sessions = 0;
        const dispatcher = createWebchatDispatcher({ workingDir: root,
            sessionStore: { async ensureCurrentSession() { return { sessionId: `session-${++sessions}`, messages: [] }; } },
            historyManager: { async add() {} },
            engine: {
                async getModel({ sessionId }) { if (sessionId === 'session-2') await preparation; return { backend: 'claude', model: null }; },
                async executeTurn({ context }) {
                    const owner = claims.get(context.invocationToken);
                    assert.equal(owner?.state, 'verified');
                    started.push({ tab: context.sourceTabId, startedAt: Date.now(), admittedAt: owner.admittedAt, expiresAt: owner.expiresAt });
                    if (context.sourceTabId === 'running') { signalFirst(); await firstFinish; }
                    return { outputText: 'diagnostic complete' };
                },
            },
        }, { write() {} });
        const receive = raw => {
            const result = verify(raw, { replayCache });
            assert.equal(result.ok, true);
            claims.set(raw.invocation.token, Object.freeze({ state: 'verified', principal: result.payload.sub,
                admittedAt: Date.now(), expiresAt: result.payload.exp * 1000 }));
            dispatcher.receive(JSON.stringify(raw));
        };
        receive(mint('running'));
        await firstRunning;
        const waiting = mint('preparing');
        receive(waiting);
        const expiresAt = claims.get(waiting.invocation.token).expiresAt;
        await delay(Math.max(0, expiresAt + (DEFAULT_CLOCK_SKEW_SECONDS + 2) * 1000 - Date.now()));
        assert.equal(verify(waiting).ok, false, 'expired token rejected without relying on replay cache');
        assert.equal(started.length, 1, 'second run still held at real selection boundary');
        releasePreparation();
        releaseFirst();
        await dispatcher.drain();
        assert.equal(started.length, 2);
        assert.ok(started[1].startedAt > started[1].expiresAt);
        const ploinkyAfter = sourceRevision(ploinkyRoot);
        assert.deepEqual(ploinkyAfter, ploinky, 'Ploinky source changed during the probe');
        return { kind: 'owner-spike', status: 'passed', ploinky, ploinkyAfter, harnessSha256, audience, ttlSeconds: 30,
            rch: admitted.payload.rch, jtiDigest: createHash('sha256').update(admitted.payload.jti).digest('hex'),
            checks: ['real-router-serializer-minter', 'raw-hash', 'wrong-tuple', 'jti-replay', 'text', 'presentation', 'tab', 'page',
                'attachments', 'references', 'tool', 'audience', 'method', 'path', 'expiry', 'receive-preparation-delay'], started,
            limitation: 'Diagnostic admission adapter; production owner admission remains unimplemented. Same-session lease rejection uses existing Linux engine regression.' };
    } finally {
        process.chdir(originalCwd);
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        await fs.rm(root, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        assert.ok(process.argv[2], 'Usage: node live-sessions-owner.mjs /absolute/ploinky-source');
        console.log(JSON.stringify(await runOwnerProbe(await fs.realpath(process.argv[2]))));
    } catch (error) {
        console.error(JSON.stringify({ kind: 'owner-spike', status: 'failed', code: error.code || error.name,
            frames: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)) }));
        process.exitCode = 1;
    }
}
