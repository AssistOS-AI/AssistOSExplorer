import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createExecutionFactory, hasRegularSkillFile } from '../../server/runtime/executionFactory.mjs';
import { PlanError, VIRTUAL_SKILLS, planAlaExecution } from '../../server/runtime/alaPlan.mjs';
import { skillsSelectionDigest } from '../../server/stateProtocol.mjs';

// S1 (T2, M-22): the worker's skills, through the REAL anchored grant resolver and the real SKILL.md check on a real directory tree.
// Only the supervisor, ledger and endpoint are fakes: nothing starts. Every refusal fails before the supervisor exists, and closes every
// descriptor it opened.

const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-skills-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dirs = ['.ploinky/repos/Skills/skills/search', '.ploinky/repos/Skills/skills/marker', '.ploinky/repos/Skills/skills/empty', '.ploinky/repos/Skills/skills/linked-file',
        '.ploinky/data/skill', 'proj/.agents/skills/local', 'proj/.roboteam/skills/x', 'other/secret', 'team/skills/writer'];
    for (const directory of dirs) fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const skill of ['.ploinky/repos/Skills/skills/search', '.ploinky/repos/Skills/skills/marker', '.ploinky/data/skill', 'proj/.roboteam/skills/x', 'team/skills/writer', 'other/secret']) {
        fs.writeFileSync(path.join(root, skill, 'SKILL.md'), '---\nname: x\n---\n');
    }
    // M9: the repository root holds a SKILL.md, so its refusal is really exercised.
    fs.writeFileSync(path.join(root, '.ploinky/repos/Skills/SKILL.md'), 'repo root skill');
    fs.writeFileSync(path.join(root, 'other/SKILL.md'), 'other project');
    fs.symlinkSync(path.join(root, 'other'), path.join(root, '.ploinky/repos/Skills/skills/escape'));
    fs.symlinkSync(path.join(root, 'other/SKILL.md'), path.join(root, '.ploinky/repos/Skills/skills/linked-file/SKILL.md'));
    return root;
}

function rig(root) {
    let supervisorOptions = null;
    const closedGrants = [];
    let nextFd = 1000;
    const deps = {
        openDirectory: () => nextFd++,
        closeFd: () => {},
        // The real resolver, wrapped only to count the descriptors it hands out and their release.
        resolveGrant: async (request, context) => {
            const { resolveGrant } = await import('../../server/views/grantResolver.mjs');
            const result = await resolveGrant(request, context);
            if (!result.ok) return result;
            const close = result.grant.close.bind(result.grant);
            return { ok: true, grant: { ...result.grant, fd: result.grant.fd, close: async () => { closedGrants.push(request.relativePath); await close(); } } };
        },
        createExecutionSupervisor: (options) => {
            supervisorOptions = options;
            return { endpointSocket: {}, controlStreams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }, providerSandbox: () => ({}), exit: async () => {} };
        },
        createExecutionLedger: () => ({ startKeeper: async () => {}, publish: async () => ({ handle: null }), endExecution: async () => ({}) }),
        createSupervisorEndpointServer: () => ({ end: () => {} }),
        imageBinds: () => ({ roBinds: [], symlinks: [] }),
        readManagedConfig: () => ({})
    };
    const logs = [];
    const factory = createExecutionFactory({
        store: {}, robots: { root: '/store', paths: (id) => ({ home: `/store/${id}/home`, sessions: `/store/${id}/sessions`, configDir: `/store/${id}/config` }) },
        launcher: {}, view: {}, walker: {}, clock: {}, workspaceRoot: root, runtimeDir: '/store/runtime', serverDir: '/code/server', alaRoot: '/ala', nodePath: '/usr/local/bin/node',
        deps, log: (event, data) => logs.push([event, data])
    });
    return { factory, closedGrants, logs, supervisor: () => supervisorOptions };
}

function specWith(root, skills) {
    const list = skills.map(([name, rel, required]) => ({ name, path: path.join(root, rel), ...(required ? { required: true } : {}) }));
    return { version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't', permissions: 'full-access', skills: list, skillsDigest: skillsSelectionDigest(list) };
}

async function openWith(root, skills) {
    const { factory, closedGrants, logs, supervisor } = rig(root);
    const specification = specWith(root, skills);
    const plan = planAlaExecution({ specification, workspaceRoot: root });
    try {
        await factory.open({ item: { robotId: 'R', executionId: 'E', attemptId: 'A', specification }, plan, context: {} });
        return { ok: true, skills: supervisor().skills, closedGrants, plan };
    } catch (error) {
        return { ok: false, reason: error.reason, supervisorCreated: supervisor() !== null, closedGrants, logs };
    }
}

test('S1: an admitted managed skill (depth >= 4) and a project skill folder are resolved read-only and passed to every workload', async (t) => {
    const root = workspace(t);
    const opened = await openWith(root, [['search', '.ploinky/repos/Skills/skills/search'], ['writer', 'team/skills/writer']]);
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.skills.map(({ name, stageName, path: hostPath }) => [name, stageName, hostPath]),
        [['search', 's0', path.join(root, '.ploinky/repos/Skills/skills/search')], ['writer', 's1', path.join(root, 'team/skills/writer')]]);
    assert.ok(opened.skills.every((skill) => Number.isInteger(skill.fd) && skill.fd >= 0));
    // Skills are never ALA folders and never project grants.
    assert.equal(opened.plan.argv.includes('--folder'), false);
    assert.deepEqual(opened.plan.grants, []);
    assert.deepEqual(opened.plan.skills.map((skill) => skill.path), [`${VIRTUAL_SKILLS}/search`, `${VIRTUAL_SKILLS}/writer`]);
});

test('S1: M-22 refusals: .ploinky, .ploinky/data, .ploinky/repos, a repository root (with SKILL.md), an escaping link, no SKILL.md, a linked SKILL.md, .roboteam', async (t) => {
    const root = workspace(t);
    const cases = [
        ['.ploinky', 'grant_protected_component'],
        ['.ploinky/data/skill', 'grant_protected_component'],
        ['.ploinky/repos', 'grant_managed_source_not_project'],
        ['.ploinky/repos/Skills', 'grant_managed_source_not_project'],
        ['.ploinky/repos/Skills/skills/escape', 'grant_symlink_in_path'],
        ['.ploinky/repos/Skills/skills/escape/secret', 'grant_symlink_in_path'],
        ['.ploinky/repos/Skills/skills/empty', 'skill_not_a_skill'],
        ['.ploinky/repos/Skills/skills/linked-file', 'skill_not_a_skill'],
        ['proj/.roboteam/skills/x', 'grant_protected_component']
    ];
    for (const [rel, reason] of cases) {
        const outcome = await openWith(root, [['search', '.ploinky/repos/Skills/skills/search'], ['bad', rel]]);
        assert.deepEqual([outcome.ok, outcome.reason, outcome.supervisorCreated], [false, reason, false], rel);
        // The descriptor of the skill resolved before the refusal is released.
        assert.ok(outcome.closedGrants.includes('.ploinky/repos/Skills/skills/search'), `${rel}: released`);
        // The same skill marked required refuses with skill_required_unavailable.
        const required = await openWith(root, [['bad', rel, true]]);
        assert.deepEqual([required.ok, required.reason, required.supervisorCreated], [false, 'skill_required_unavailable', false], `${rel} (required)`);
    }
});

test('S1: plan refusals: the workspace root, a path outside it, and a required skill outside it', (t) => {
    const root = workspace(t);
    const rootSpec = { version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't', permissions: 'full-access', skills: [{ name: 'all', path: root }] };
    assert.throws(() => planAlaExecution({ specification: rootSpec, workspaceRoot: root }), (error) => error.reason === 'skill_workspace_root_not_granted');
    const outside = { ...rootSpec, skills: [{ name: 'etc', path: '/etc' }] };
    assert.throws(() => planAlaExecution({ specification: outside, workspaceRoot: root }), (error) => error.reason === 'skill_path_outside_workspace');
    assert.throws(() => planAlaExecution({ specification: { ...outside, skills: [{ name: 'etc', path: '/etc', required: true }] }, workspaceRoot: root }), (error) => error.reason === 'skill_required_unavailable');
    assert.throws(() => planAlaExecution({ specification: { ...rootSpec, skills: [{ name: '.hidden', path: path.join(root, 'team') }] }, workspaceRoot: root }), (error) => error instanceof PlanError && error.reason === 'skill_name_invalid');
});

test('S1: zero skills plan an empty view; 64 skills plan 64 views', (t) => {
    const root = workspace(t);
    assert.deepEqual(planAlaExecution({ specification: specWith(root, []), workspaceRoot: root }).skills, []);
    const many = Array.from({ length: 64 }, (_, i) => [`skill-${i}`, 'team/skills/writer']);
    assert.equal(planAlaExecution({ specification: specWith(root, many), workspaceRoot: root }).skills.length, 64);
});

test('hasRegularSkillFile: a regular SKILL.md only, opened below the descriptor without following a link', (t) => {
    const root = workspace(t);
    const open = (rel) => fs.openSync(path.join(root, rel), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    for (const [rel, expected] of [['.ploinky/repos/Skills/skills/search', true], ['.ploinky/repos/Skills/skills/empty', false], ['.ploinky/repos/Skills/skills/linked-file', false]]) {
        const fd = open(rel);
        try { assert.equal(hasRegularSkillFile(fd), expected, rel); } finally { fs.closeSync(fd); }
    }
    fs.mkdirSync(path.join(root, 'team/skills/dirfile/SKILL.md'), { recursive: true });
    const fd = open('team/skills/dirfile');
    try { assert.equal(hasRegularSkillFile(fd), false, 'a directory named SKILL.md'); } finally { fs.closeSync(fd); }
});

test('T2: ask-for-approval is planned with its permission flag; flow work cannot ask', () => {
    const specification = { version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't', permissions: 'ask-for-approval' };
    const plan = planAlaExecution({ specification, workspaceRoot: '/ws' });
    assert.deepEqual(plan.argv.slice(plan.argv.indexOf('--permissions'), plan.argv.indexOf('--permissions') + 2), ['--permissions', 'ask-for-approval']);
    assert.ok(plan.argv.includes('--control-stdin'));
    planAlaExecution({ specification, workspaceRoot: '/ws', logicalKind: 'task' });
    planAlaExecution({ specification, workspaceRoot: '/ws', logicalKind: 'session' });
    assert.throws(() => planAlaExecution({ specification, workspaceRoot: '/ws', logicalKind: 'flow' }), (error) => error.reason === 'approval_unsupported');
    planAlaExecution({ specification: { ...specification, permissions: 'full-access' }, workspaceRoot: '/ws', logicalKind: 'flow' });
});

// ---- M-22 / M-70: specification ignore paths inside a skill reach the skills view ----------------------------------------------------

test('M-70 reviewer repros: an ignore path inside a skill becomes that skill\'s exclusion, whether the skill is outside every grant (A) or inside the cwd grant (B)', () => {
    const base = { version: 2, prompt: 'p', displayText: '', sessionId: 's1', turnId: 't1', permissions: 'full-access', cwd: '/ws/proj' };
    const a = planAlaExecution({ workspaceRoot: '/ws', specification: { ...base, skills: [{ name: 'sk', path: '/ws/lib/skills/sk' }], ignore: ['/ws/lib/skills/sk/secret.txt', '/ws/lib/skills/sk/docs/private'] } });
    assert.deepEqual(a.skills[0].exclusions, ['secret.txt', 'docs/private'], 'A: not dropped');
    assert.deepEqual(a.argv.filter((_, i) => a.argv[i - 1] === '--ignore'), [], 'A: nothing for ALA, which sees no grant holding it');
    const b = planAlaExecution({ workspaceRoot: '/ws', specification: { ...base, skills: [{ name: 'sk', path: '/ws/proj/tools/sk' }], ignore: ['/ws/proj/tools/sk/secret.txt'] } });
    assert.deepEqual(b.skills[0].exclusions, ['secret.txt'], 'B: masked in the view too');
    assert.deepEqual(b.argv.filter((_, i) => b.argv[i - 1] === '--ignore'), ['/projects/g0/tools/sk/secret.txt'], 'B: still masked in the project grant');
    // An ignore elsewhere, or a sibling with a common prefix, is not this skill's.
    const c = planAlaExecution({ workspaceRoot: '/ws', specification: { ...base, skills: [{ name: 'sk', path: '/ws/lib/sk' }], ignore: ['/ws/lib/sk2/x', '/ws/proj/.roboteam'] } });
    assert.deepEqual(c.skills[0].exclusions, []);
});

test('M-70: only an exclusion that cannot be a mask inside the folder refuses: the skill folder itself or an ancestor of it is ignored', () => {
    const base = { version: 2, prompt: 'p', displayText: '', sessionId: 's1', turnId: 't1', permissions: 'full-access' };
    for (const ignore of ['/ws/lib/skills/sk', '/ws/lib/skills', '/ws/lib']) {
        assert.throws(() => planAlaExecution({ workspaceRoot: '/ws', specification: { ...base, skills: [{ name: 'sk', path: '/ws/lib/skills/sk' }], ignore: [ignore] } }),
            (error) => error.reason === 'skill_folder_ignored', ignore);
        assert.throws(() => planAlaExecution({ workspaceRoot: '/ws', specification: { ...base, skills: [{ name: 'sk', path: '/ws/lib/skills/sk', required: true }], ignore: [ignore] } }),
            (error) => error.reason === 'skill_required_unavailable', `${ignore} (required)`);
    }
});

test('M-70: the factory hands each skill\'s exclusions to the supervisor', async (t) => {
    const root = workspace(t);
    const { factory, supervisor } = rig(root);
    const list = [{ name: 'search', path: path.join(root, '.ploinky/repos/Skills/skills/search') }];
    const specification = { version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't', permissions: 'full-access', skills: list, skillsDigest: skillsSelectionDigest(list),
        ignore: [path.join(root, '.ploinky/repos/Skills/skills/search/notes/private.md')] };
    const plan = planAlaExecution({ specification, workspaceRoot: root });
    await factory.open({ item: { robotId: 'R', executionId: 'E', attemptId: 'A', specification }, plan, context: {} });
    assert.deepEqual(supervisor().skills.map((skill) => [skill.name, skill.exclusions]), [['search', ['notes/private.md']]]);
});
