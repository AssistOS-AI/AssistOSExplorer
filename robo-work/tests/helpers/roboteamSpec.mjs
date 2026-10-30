import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Cross-side helper: the version 2 specification that RoboTeam's worker engine really builds
// (roboTeamAgent/copilot/src/lib/execution/workerEngine.mjs `executeTurn`), captured at the admission call of a fake coordinator hop
// so that robo-work tests can feed it to the validator and to planAlaExecution. The spec builder is inline in `executeTurn` and not
// exported, so the engine is driven with the same fakes as roboTeamAgent/copilot/tests/worker-engine.test.mjs (a scripted worker
// client that completes at once). Extend `options` to cover other RoboTeam inputs: `execution` (permissions, model, mcpServers,
// workflowExecution), `permission`, `skills`, `env` (for example ROBOTEAM_HUMAN_INPUT_DIRECTORY).
//
// The module imports RoboTeam's source: the helper makes ACHILLES_ALA_HOME private and needs ALA_ROOT.
const ROBOTEAM = new URL('../../../roboTeamAgent/', import.meta.url);

export async function roboTeamSpecification({ prompt = 'Summarize the repo', permission = 'full-access', execution = {}, workspaceRoot = null, workingDir = null, resume = false, cwdIsWorkspaceRoot = false } = {}) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'robo-work-ala-home-'));
    process.env.ACHILLES_ALA_HOME ||= home;
    // RoboTeam's engine loads ALA's transcript reader; ALA_ROOT (as for tests/execution) names the checkout.
    if (!process.env.ACHILLES_ALA_COMMAND) {
        if (!process.env.ALA_ROOT) throw new Error('ALA_ROOT is required: the RoboTeam worker engine loads the ALA checkout');
        process.env.ACHILLES_ALA_COMMAND = path.join(process.env.ALA_ROOT, 'bin', 'ala.mjs');
    }
    const engineModule = await import(new URL('copilot/src/lib/execution/workerEngine.mjs', ROBOTEAM).href);
    const { ConversationSessionStore } = await import(new URL('copilot/src/lib/storage/conversationSessionStore.mjs', ROBOTEAM).href);
    const cwd = workingDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'robo-work-spec-'));
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const root = cwdIsWorkspaceRoot ? await fs.realpath(cwd) : (workspaceRoot ?? path.dirname(cwd));
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    const row = (sequence, state, result) => ({ seq: sequence, at: new Date().toISOString(), kind: 'state', state, ...(result ? { result } : {}) });
    const rows = [row(1, 'queued'), row(2, 'running'), row(3, 'completed', { status: 'completed', outputText: 'done' })];
    const done = { state: 'completed', result: { status: 'completed', outputText: 'done' } };
    const configuration = { backend: 'codex', settings: { codingAgents: ['codex'] } };
    const client = {
        async subscribe(_referenceId, { after }) { return (async function* stream() { for (const next of rows.filter((entry) => entry.seq > after)) yield next; }()); },
        async events(_referenceId, { after }) { const page = rows.filter((entry) => entry.seq > after); return { events: page, nextAfter: page.at(-1)?.seq ?? after }; },
        async read() { return done; },
        async control() { return { outcome: 'accepted' }; },
        async admit(body) { return { referenceId: 'r'.repeat(22), state: 'queued', originRequestId: body.originRequestId }; },
        async lookup() { return null; },
        async getRobot() { return { configuration }; }
    };
    const captured = [];
    const coordinator = {
        async admitTurn(evidence, request) {
            captured.push(request);
            return { status: 200, body: { taskRef: { version: 1, provider: 'robo-work', id: 'r'.repeat(22) }, state: 'queued', originRequestId: 'BBBBBBBBBBBBBBBBBBBBBA' } };
        }
    };
    const sessions = new ConversationSessionStore({ workingDir: cwd });
    const session = await sessions.createSession();
    const engine = engineModule.createWorkerEngine({
        workingDir: cwd, sessionStore: sessions, client, getRobot: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }),
        skillCatalog: { async refresh() { return { skills: [{ name: 'bash', skillDir: cwd, enabled: true }], taskRepositories: [] }; } },
        provisioner: { async ensureReady() { return { robotId: 'AAAAAAAAAAAAAAAAAAAAAA', configRevision: 1, configuration }; }, desiredConfiguration: () => configuration },
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => permission },
        interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo', ...execution }, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)), pollMinMs: 1, pollMaxMs: 2, stopWaitMs: 50, evidenceWaitMs: 0
    });
    const grant = `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`;
    try {
        if (resume) {
            await engine.executeTurn({ sessionId: session.sessionId, prompt: 'First', owner: { coordinator, evidence: { ok: true, principal: 'user:alice', grant } } });
            captured.length = 0;
        }
        await engine.executeTurn({ sessionId: session.sessionId, prompt, context: { rawText: prompt }, owner: { coordinator, evidence: { ok: true, principal: 'user:alice', grant } } });
    } finally {
        await engine.close();
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
    }
    const specification = captured.at(-1).specification;
    return { specification, cwd: await fs.realpath(cwd), workspaceRoot: root, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}
