import test from 'node:test';
import '../copilot/tests/helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerEngine } from '../copilot/src/lib/execution/workerEngine.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { PlanError, VIRTUAL_HOME, planAlaExecution } from '../../robo-work/server/runtime/alaPlan.mjs';
import { validateSpecificationV2 } from '../../robo-work/server/stateProtocol.mjs';

// Cross-side check of decision M-20 (base section 4.1): the specification the RoboTeam worker engine
// builds goes through the worker's own validator and ALA plan. The workspace root is never a grant.
const LIMITS = { requestBytes: 1024 * 1024, resultBytes: 1024 * 1024 };
const GRANT = `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`;
const REFERENCE = 'r'.repeat(22);

// Builds one turn's specification with the real engine over fakes for the worker, then returns it with the
// canonical workspace root. `project` is the conversation's folder below the root, or null for the root itself.
async function buildSpecification(t, { project = null, explicit = false, withSkills = false } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-plan-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workingDir = project ? path.join(root, project) : root;
    await fs.mkdir(workingDir, { recursive: true });
    const old = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => { if (old === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = old; });
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const admitted = [];
    const coordinator = { async admitTurn(evidence, request) { admitted.push(request); return { status: 200, body: { taskRef: { id: REFERENCE }, state: 'queued', originRequestId: 'x' } }; } };
    const rows = [{ seq: 1, kind: 'state', state: 'completed' }];
    const client = {
        async subscribe() { return (async function* done() { yield* rows; }()); },
        async read() { return { state: 'completed', result: { status: 'completed', outputText: 'ok' } }; },
        async control() { return {}; },
    };
    const engine = createWorkerEngine({ workingDir, sessionStore: store, client, getRobot: async () => ({ id: 'robo', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }),
        provisioner: { ensureReady: async () => ({ robotId: 'AAAAAAAAAAAAAAAAAAAAAA', configRevision: 1, configuration: { backend: 'codex', settings: { codingAgents: ['codex'] } } }), desiredConfiguration: () => ({}) },
        skillCatalog: { async refresh() {
            return { skills: [], taskRepositories: [], ...(withSkills ? { skillsDirectory: path.join(root, '.roboteam', 'overlay'), mounts: [{ source: path.join(root, 'skills', 'docs'), target: path.join(workingDir, '.agents', 'skills', 'docs') }] } : {}) };
        } },
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo', ...(explicit ? { cwdExplicit: true } : {}) }, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    t.after(() => engine.close());
    const owner = { coordinator, evidence: { ok: true, principal: 'user:alice', grant: GRANT } };
    const outcome = await engine.executeTurn({ sessionId: session.sessionId, prompt: 'Do the work', owner }).then(() => null, (error) => error);
    return { root, workingDir, specification: admitted[0]?.specification ?? null, error: outcome, admitted };
}

test('a project folder below the root is the writable grant and the extras are read-only grants; the root is never granted', async (t) => {
    const built = await buildSpecification(t, { project: 'proj', withSkills: true });
    assert.equal(built.error, null);
    const spec = built.specification;
    assert.equal(spec.cwd, path.join(built.root, 'proj'));
    assert.deepEqual(spec.folders.map((folder) => folder.access), ['read', 'read']);
    // The worker's own validator accepts it ...
    validateSpecificationV2(spec, LIMITS);
    // ... and its plan resolves exactly those grants, none of which is the root.
    const plan = planAlaExecution({ specification: spec, workspaceRoot: built.root });
    assert.ok(plan.grants.every((grant) => grant.hostPath !== built.root && grant.relativePath !== ''));
    const [cwdGrant, ...extras] = plan.grants;
    assert.equal(cwdGrant.hostPath, spec.cwd);
    assert.equal(cwdGrant.access, 'write');
    assert.ok(extras.length === 2 && extras.every((grant) => grant.access === 'read'));
    assert.equal(plan.cwd, '/projects/g0');
    assert.ok(plan.argv.includes('--cwd') && plan.argv[plan.argv.indexOf('--cwd') + 1] === '/projects/g0');
    assert.ok(!plan.argv.includes('write') || plan.argv.indexOf('write') > plan.argv.indexOf('--folder'), 'only read-only extras');
});

test('naming the workspace root as the working folder is refused in RoboTeam before admission, as the worker would', async (t) => {
    const built = await buildSpecification(t, { explicit: true });
    assert.equal(built.admitted.length, 0);
    assert.equal(built.error.code, 'workspace_root_not_granted');
    assert.match(built.error.message, /project folder/);
    // The worker refuses the same grant, so the RoboTeam refusal mirrors the worker's reason.
    const forced = { version: 2, prompt: 'p', displayText: 'p', sessionId: '00000000-0000-4000-8000-000000000001', turnId: 't1', cwd: built.root, permissions: 'full-access' };
    validateSpecificationV2(forced, LIMITS);
    assert.throws(() => planAlaExecution({ specification: forced, workspaceRoot: built.root }), (error) => error instanceof PlanError && error.reason === 'workspace_root_not_granted');
});

test('with no project selected the specification carries no project grant (RoboTeam side)', async (t) => {
    const built = await buildSpecification(t, { withSkills: true });
    assert.equal(built.error, null);
    assert.equal(Object.hasOwn(built.specification, 'cwd'), false);
    assert.equal(Object.hasOwn(built.specification, 'ignore'), false);
    assert.ok((built.specification.folders ?? []).every((folder) => folder.path !== built.root && folder.access === 'read'));
    assert.ok(JSON.stringify(built.specification).includes(`"${built.root}"`) === false, 'the root is not sent as a path');
});

// A specification without `cwd` (no project selected) plans ALA in the robot HOME with no project grant (M-20).
test('the worker admits and plans a specification with no project', async (t) => {
    const built = await buildSpecification(t, { withSkills: true });
    validateSpecificationV2(built.specification, LIMITS);
    const plan = planAlaExecution({ specification: built.specification, workspaceRoot: built.root });
    assert.equal(plan.cwd, VIRTUAL_HOME);
    assert.ok(plan.grants.every((grant) => grant.hostPath !== built.root && grant.access === 'read'));
});
