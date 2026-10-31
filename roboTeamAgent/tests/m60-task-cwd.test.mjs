// Decision M-60: RoboTeam never resolves symlinks in a path that reaches a worker admission field. The task cwd is
// validated component by component without following links and sent as the lexical path; the worker's anchored
// O_NOFOLLOW resolver is the only resolver.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { registerProject } from '../server/project-storage.mjs';

const toolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex', 'opencode', 'pi']) => ({ root: '/cache', path: '/cache/shell-generations/test',
        binPath: '/cache/shell-generations/test/bin', agents: Object.fromEntries(names.map(name => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodingAgents: async (names = ['codex', 'opencode', 'pi']) => Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin`, versions: {} }])),
};

async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm60-task-cwd-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    const spawned = [];
    const manager = new RuntimeManager({ workerMode: true, dataDir: path.join(root, '.data/roboTeamAgent'), workspaceRoot: root, toolCache,
        spawnImpl: (_command, args) => {
            spawned.push(args);
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            setImmediate(() => child.emit('close', 0, null));
            return child;
        }, ...options });
    t.after(async () => {
        await manager.stopAll();
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const real = path.join(root, 'projects', 'app');
    const other = path.join(root, 'other-project');
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(other);
    return { root, manager, spawned, real, other };
}

test('M-60 task cwd: a plain path and the workspace root come back lexically unchanged', async t => {
    const f = await fixture(t);
    assert.equal(await f.manager.resolveCwd(f.real), f.real);
    assert.equal(await f.manager.resolveCwd(f.root), f.root);
    assert.equal(await f.manager.resolveCwd(`${f.real}/../app/`), f.real, 'normalization is lexical');
});

test('M-60 task cwd: a symlinked component, intermediate or final, is refused with a 400 cwd_symlinked and is never resolved', async t => {
    const f = await fixture(t);
    await fs.symlink(f.other, path.join(f.root, 'projects', 'hop'));
    await fs.symlink(path.join(f.root, 'projects'), path.join(f.root, 'alias'));
    for (const candidate of [path.join(f.root, 'projects', 'hop'), path.join(f.root, 'alias', 'app'), path.join(f.root, 'alias')]) {
        await assert.rejects(f.manager.resolveCwd(candidate), { code: 'cwd_symlinked', statusCode: 400 }, candidate);
    }
    await assert.rejects(f.manager.resolveCwd(path.join(os.tmpdir(), '..', 'etc')), /inside the enabled Ploinky workspace/u);
    await assert.rejects(f.manager.resolveCwd(path.join(f.root, 'missing')), { code: 'ENOENT' });
    await assert.rejects(f.manager.resolveCwd('relative/path'), /absolute workspace path/u);
});

test('M-60 task cwd: the host-to-container remap is lexical and walks the remapped path without following links', async t => {
    const f = await fixture(t, { hostWorkspaceRoot: '/host/workspace-that-does-not-exist-here' });
    const host = '/host/workspace-that-does-not-exist-here';
    assert.equal(await f.manager.resolveCwd(`${host}/projects/app`), f.real);
    await fs.symlink(f.other, path.join(f.root, 'projects', 'hop'));
    await assert.rejects(f.manager.resolveCwd(`${host}/projects/hop`), { code: 'cwd_symlinked', statusCode: 400 });
    await assert.rejects(f.manager.resolveCwd('/host/elsewhere/projects/app'), /inside the enabled Ploinky workspace/u);
});

test('M-60 task cwd: a component swapped for a link before the task starts refuses the task, spawns nothing and registers nothing', async t => {
    const f = await fixture(t);
    const robot = { id: 'robot-m60-abc123', name: 'M60', codingAgents: ['opencode'] };
    // The request was accepted when `projects` was a directory; before the task starts it becomes a link to another project.
    const task = f.manager._newTask(robot, 'simple', { cwd: f.real, task: 'Review' });
    await fs.mkdir(path.join(f.other, 'app'));
    await fs.rename(path.join(f.root, 'projects'), path.join(f.root, 'projects-moved'));
    await fs.symlink(f.other, path.join(f.root, 'projects'));
    await f.manager._runTask(robot, task);
    assert.equal(task.state, 'failed');
    assert.match(task.error, /cwd_symlinked|replaced by a link|symbolic link/iu);
    assert.equal(f.spawned.length, 0, 'no child is spawned');
    await assert.rejects(fs.stat(path.join(f.root, '.data/roboTeamAgent/projects')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.other, '.roboteam')), { code: 'ENOENT' });
});

test('M-60 task cwd: a plain task still runs and registers the lexical project path', async t => {
    const f = await fixture(t);
    const robot = { id: 'robot-m60-abc123', name: 'M60', codingAgents: ['opencode'] };
    const task = f.manager._newTask(robot, 'simple', { cwd: f.real, task: 'Review' });
    await f.manager._runTask(robot, task);
    assert.equal(task.state, 'completed', task.error);
    assert.equal(task.request.cwd, f.real);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0][f.spawned[0].indexOf('--cwd') + 1], f.real);
});

test('M-60 project registration: registerProject keeps the validated lexical path and refuses a link instead of resolving it', async t => {
    const f = await fixture(t);
    const options = { dataDir: path.join(f.root, '.data/roboTeamAgent'), workspaceRoot: f.root };
    assert.equal(registerProject(options, f.real), f.real);
    await fs.symlink(f.other, path.join(f.root, 'link'));
    assert.throws(() => registerProject(options, path.join(f.root, 'link')), { code: 'cwd_symlinked' });
    assert.throws(() => registerProject(options, path.join(f.root, 'link', 'x')), { code: 'cwd_symlinked' });
});

test('M-60 (ii): a task that selects no project runs at the workspace root with --no-project; a project task never gets the flag', async t => {
    const f = await fixture(t);
    const robot = { id: 'robot-m60-abc123', name: 'M60', codingAgents: ['opencode'] };
    const generation = f.manager._newTask(robot, 'simple', { cwd: f.root, task: 'Draft', noProject: true });
    await f.manager._runTask(robot, generation);
    assert.equal(generation.state, 'completed', generation.error);
    const project = f.manager._newTask(robot, 'simple', { cwd: f.real, task: 'Review' });
    await f.manager._runTask(robot, project);
    assert.equal(project.state, 'completed', project.error);
    assert.equal(f.spawned.length, 2);
    assert.ok(f.spawned[0].includes('--no-project'));
    assert.equal(f.spawned[0][f.spawned[0].indexOf('--cwd') + 1], f.root);
    assert.equal(f.spawned[1].includes('--no-project'), false);
});

test('M-60 root alias: a path spelled with the unresolved configured workspace root is rebased onto the resolved root, not refused', async t => {
    const f = await fixture(t);
    // The configured root is a link to the real one (the darwin /tmp case); a link above the root is the operator's, not the workload's.
    const aliasRoot = `${f.root}-alias`;
    await fs.symlink(f.root, aliasRoot);
    t.after(() => fs.rm(aliasRoot, { force: true }));
    const manager = new RuntimeManager({ workerMode: true, dataDir: path.join(f.root, '.data/roboTeamAgent'), workspaceRoot: aliasRoot, toolCache });
    t.after(() => manager.stopAll());
    assert.equal(await manager.resolveCwd(path.join(aliasRoot, 'projects', 'app')), f.real);
    assert.equal(await manager.resolveCwd(aliasRoot), f.root);
    await fs.symlink(f.other, path.join(f.root, 'projects', 'hop'));
    await assert.rejects(manager.resolveCwd(path.join(aliasRoot, 'projects', 'hop')), { code: 'cwd_symlinked' });
    const options = { dataDir: path.join(f.root, '.data/roboTeamAgent'), workspaceRoot: aliasRoot };
    assert.equal(registerProject(options, path.join(aliasRoot, 'projects', 'app')), f.real);
});
