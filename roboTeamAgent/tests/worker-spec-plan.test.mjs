import test from 'node:test';
import '../copilot/tests/helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerEngine } from '../copilot/src/lib/execution/workerEngine.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';
import { planAlaExecution } from '../../robo-work/server/runtime/alaPlan.mjs';
import { validateSpecificationV2 } from '../../robo-work/server/stateProtocol.mjs';
import { resolveGrant } from '../../robo-work/server/views/grantResolver.mjs';
import { grantRoleFor } from '../../robo-work/server/runtime/executionFactory.mjs';

// Cross-side check of decision M-20 (base section 4.1): the specification the RoboTeam worker engine
// builds goes through the worker's own validator and ALA plan. The workspace root is never a grant.
const LIMITS = { requestBytes: 1024 * 1024, resultBytes: 1024 * 1024 };
const GRANT = `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`;
const REFERENCE = 'r'.repeat(22);

// Builds one turn's specification with the real engine over fakes for the worker, then returns it with the
// canonical workspace root. `project` is the conversation's folder below the root, or null for the root itself.
async function buildSpecification(t, { project = null, explicit = false, withSkills = false, channels = false, link = null } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-plan-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workingDir = project ? path.join(root, project) : root;
    const overlay = path.join(workingDir, '.roboteam', 'sessions', 's1', 'skills');
    const managed = path.join(root, '.ploinky', 'repos', 'Skills', 'skills', 'docs');
    const channelBase = path.join(root, '.ploinky', 'repos', 'AchillesIDE', 'roboTeamAgent', 'copilot', 'src', 'skills');
    const channelSkills = ['report-task-blocked', 'require-human-input'].map((name) => ({ name, skillDir: path.join(channelBase, name), enabled: true }));
    await Promise.all([workingDir, overlay, managed, path.join(root, 'skills', 'docs'), ...channelSkills.map((skill) => skill.skillDir)].map((directory) => fs.mkdir(directory, { recursive: true })));
    const old = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => { if (old === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = old; });
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    // `link` ({ at, to }, root-relative): after the conversation recorded its folder (`project`, at or below `at`), a writer
    // of the parent project replaces `at` with a symlink to `to`.
    const swap = async () => {
        const moved = path.join(root, link.to, path.relative(link.at, project));
        await fs.mkdir(path.dirname(moved), { recursive: true });
        await fs.rename(workingDir, moved);
        await fs.rm(path.join(root, link.at), { recursive: true, force: true });
        await fs.symlink(path.join(root, link.to), path.join(root, link.at));
    };
    // By default the swap lands before the turn; `link.during` swaps inside the turn's preflight (the first catalog refresh),
    // after RoboTeam checked the cwd and before it binds the session.
    if (link && !link.during) await swap();
    let swapped = false;
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
            if (link?.during && !swapped) { swapped = true; await swap(); }
            // The real snapshot shape: the private session overlay is `skillsDirectory`; each mount names a skill source.
            return { skills: channels ? channelSkills : [], taskRepositories: [], ...(withSkills ? { skillsDirectory: overlay, mounts: [
                { source: path.join(root, 'skills', 'docs'), target: path.join(workingDir, '.agents', 'skills', 'docs') },
                { source: managed, target: path.join(workingDir, '.agents', 'skills', 'managed') },
            ] } : {}) };
        } },
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo', ...(explicit ? { cwdExplicit: true } : {}), ...(channels ? { workflowExecution: true, humanInput: true } : {}) }, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    t.after(() => engine.close());
    const owner = { coordinator, evidence: { ok: true, principal: 'user:alice', grant: GRANT } };
    const outcome = await engine.executeTurn({ sessionId: session.sessionId, prompt: 'Do the work', owner }).then(() => null, (error) => error);
    return { root, workingDir, specification: admitted[0]?.specification ?? null, error: outcome, admitted, engine, sessionId: session.sessionId, store, owner };
}

// The grant requests executionFactory.mjs makes (role 'project', the plan's access and workspace-relative path), resolved by the
// worker's own resolver. A managed `.ploinky/repos` skill source is a `skill-source` grant, which the worker infers.
async function resolveLikeTheFactory(root, entries) {
    const outcomes = [];
    for (const entry of entries) {
        const relativePath = path.relative(root, entry.path);
        const role = grantRoleFor({ relativePath, access: entry.access });
        const result = await resolveGrant({ role, access: entry.access, relativePath }, { workspaceRoot: root, protectedLocations: [] });
        if (result.ok) await result.grant.close();
        outcomes.push({ relativePath, ok: result.ok, code: result.ok ? null : result.code });
    }
    return outcomes;
}

const CHANNEL_FOLDERS = (root) => ['report-task-blocked', 'require-human-input'].map((name) => ({ path: path.join(root, '.ploinky', 'repos', 'AchillesIDE', 'roboTeamAgent', 'copilot', 'src', 'skills', name), access: 'read' }));

test('a project folder below the root is the writable grant and the extras are the channel skill sources; skill mounts, the root and the overlay are never granted', async (t) => {
    const built = await buildSpecification(t, { project: 'proj', withSkills: true, channels: true });
    assert.equal(built.error, null);
    const spec = built.specification;
    assert.equal(spec.cwd, path.join(built.root, 'proj'));
    assert.deepEqual(spec.folders, CHANNEL_FOLDERS(built.root));
    assert.equal([spec.cwd, ...spec.folders.map((folder) => folder.path)].some((granted) => granted.includes('.roboteam')), false, 'the private overlay is not granted');
    validateSpecificationV2(spec, LIMITS);
    const plan = planAlaExecution({ specification: spec, workspaceRoot: built.root });
    assert.ok(plan.grants.every((grant) => grant.hostPath !== built.root && grant.relativePath !== ''));
    const [cwdGrant, ...extras] = plan.grants;
    assert.equal(cwdGrant.hostPath, spec.cwd);
    assert.equal(cwdGrant.access, 'write');
    assert.ok(extras.length === 2 && extras.every((grant) => grant.access === 'read'));
    assert.equal(plan.cwd, '/projects/g0');
    // The worker's resolver opens the project, and each channel skill as the skill-source the worker infers for it.
    const outcomes = await resolveLikeTheFactory(built.root, [{ path: spec.cwd, access: 'write' }, ...spec.folders]);
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true, true]);
    assert.deepEqual(spec.folders.map((folder) => grantRoleFor({ relativePath: path.relative(built.root, folder.path), access: 'read' })), ['skill-source', 'skill-source']);
});

test('with no project the channel folders still resolve through the worker\'s grant resolver: no overlay, no protected component, no root', async (t) => {
    const built = await buildSpecification(t, { withSkills: true, channels: true });
    assert.equal(built.error, null);
    const spec = built.specification;
    assert.equal(Object.hasOwn(spec, 'cwd'), false);
    assert.equal(spec.folders.some((folder) => folder.path.includes('.roboteam')), false);
    assert.deepEqual(spec.folders, CHANNEL_FOLDERS(built.root));
    const outcomes = await resolveLikeTheFactory(built.root, spec.folders);
    assert.deepEqual(outcomes.map((outcome) => outcome.code), [null, null]);
    assert.ok(spec.folders.every((folder) => folder.path !== built.root && folder.access === 'read'));
});

test('skill mounts alone grant nothing: no folders in the specification', async (t) => {
    const built = await buildSpecification(t, { project: 'proj', withSkills: true });
    assert.equal(built.error, null);
    assert.equal(Object.hasOwn(built.specification, 'folders'), false);
});

test('negative control: the private overlay sent as a folder is refused by the resolver, as the review probe found', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-overlay-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.roboteam', 'sessions', 's1', 'skills'), { recursive: true });
    const [outcome] = await resolveLikeTheFactory(root, [{ path: path.join(root, '.roboteam', 'sessions', 's1', 'skills'), access: 'read' }]);
    assert.deepEqual(outcome, { relativePath: '.roboteam/sessions/s1/skills', ok: false, code: 'protected_component' });
});

// The factory infers the `skill-source` role for a read-only folder below `.ploinky/repos/<repo>` (grantRoleFor, M-22),
// and never for a repository root (B1(b)).
test('the worker resolves a managed skill source requested with the factory\'s request shape; a repository root is refused even with a SKILL.md', async (t) => {
    const built = await buildSpecification(t, { project: 'proj', withSkills: true, channels: true });
    const outcomes = await resolveLikeTheFactory(built.root, built.specification.folders);
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
    await fs.writeFile(path.join(built.root, '.ploinky', 'repos', 'AchillesIDE', 'SKILL.md'), 'root skill');
    const [root] = await resolveLikeTheFactory(built.root, [{ path: path.join(built.root, '.ploinky', 'repos', 'AchillesIDE'), access: 'read' }]);
    assert.deepEqual(root, { relativePath: '.ploinky/repos/AchillesIDE', ok: false, code: 'managed_source_not_project' });
});

test('a stored cwd whose intermediate component became a symlink is refused before the binding and admission, on every turn (M-58)', async (t) => {
    const { root, workingDir, admitted, error, engine, sessionId, store, owner } = await buildSpecification(t, { project: 'proj/sub/deeper', link: { at: 'proj/sub', to: 'victim' } });
    assert.equal(admitted.length, 0);
    assert.match(String(error?.message), /^cwd_symlinked/);
    // The binding was not written with the resolved victim path, so a second turn is refused the same way.
    assert.notEqual(store.loadSession(sessionId).engine?.cwd, path.join(root, 'victim', 'deeper'));
    const second = await engine.executeTurn({ sessionId, prompt: 'again', owner }).then(() => null, (failure) => failure);
    assert.equal(admitted.length, 0);
    assert.match(String(second?.message), /^cwd_symlinked/);
    // Had the lexical path reached the worker, its resolver would refuse it as well.
    const [outcome] = await resolveLikeTheFactory(root, [{ path: workingDir, access: 'write' }]);
    assert.equal(outcome.code, 'symlink_in_path');
});

test('a stored cwd that is itself a symlink is refused before admission (M-58)', async (t) => {
    const { admitted, error } = await buildSpecification(t, { project: 'proj/sub', link: { at: 'proj/sub', to: 'victim' } });
    assert.equal(admitted.length, 0);
    assert.ok(error);
});

test('a plain stored cwd is unchanged and resolves as the writable project grant (M-58)', async (t) => {
    const { root, workingDir, specification } = await buildSpecification(t, { project: 'proj' });
    assert.equal(specification.cwd, workingDir);
    const [outcome] = await resolveLikeTheFactory(root, [{ path: specification.cwd, access: 'write' }]);
    assert.equal(outcome.ok, true);
});

test('a stored cwd through a symlink to the workspace root is refused before admission (M-58)', async (t) => {
    const { admitted, error } = await buildSpecification(t, { project: 'proj/up', link: { at: 'proj', to: '.' } });
    assert.equal(admitted.length, 0);
    assert.match(String(error?.message), /^cwd_symlinked/);
});

test('a swap inside the turn, after the cwd check and before the session binding, is refused and never stored (M-58)', async (t) => {
    const { root, admitted, error, engine, sessionId, store, owner } = await buildSpecification(t, { project: 'proj/sub/deeper', link: { at: 'proj/sub', to: 'victim', during: true } });
    assert.equal(admitted.length, 0);
    assert.match(String(error?.message), /cwd_symlinked/);
    assert.equal(store.loadSession(sessionId).engine?.cwd, undefined);
    const second = await engine.executeTurn({ sessionId, prompt: 'again', owner }).then(() => null, (failure) => failure);
    assert.equal(admitted.length, 0, 'the next turn is not handed the victim path');
    assert.match(String(second?.message), /cwd_symlinked/);
    assert.equal(Object.hasOwn(store.loadSession(sessionId).engine || {}, 'cwd'), false);
    assert.ok(root);
});
