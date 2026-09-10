import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets } from '../server/robot-skillsets.mjs';
import { recoverPathCatalog } from '../server/legacy-skill-catalog.mjs';
import { createRobotSkillCatalog } from '../copilot/src/lib/robotSkillCatalog.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/alaInstallation.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-skill-recovery-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const robot = await store.create({ name: 'Analyst' });
    const workspaceRoot = path.join(root, 'workspace');
    const source = path.join(workspaceRoot, 'skills');
    for (const name of ['read-report', 'write-report']) {
        await fs.mkdir(path.join(source, name), { recursive: true });
        await fs.writeFile(path.join(source, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} procedure\n---\nRead helper.txt.\n`);
        await fs.writeFile(path.join(source, name, 'helper.txt'), 'original');
    }
    const { discoverTaskSkills } = await resolveAlaInstallation();
    const service = new RobotSkillsets({ robotStore: store, workspaceRoot, discoverSkills: discoverTaskSkills });
    const repo = await service.add(robot.id, { source });
    const paths = repo.skills.map(skill => path.join(store.robotPath(robot.id), 'skillsets', repo.generation, skill.directory));
    for (const directory of paths) {
        await fs.chmod(path.join(directory, 'SKILL.md'), 0o600);
        await fs.chmod(path.join(directory, 'helper.txt'), 0o600);
    }
    const selection = { catalogId: crypto.randomUUID(), paths, resolvedSkills: repo.skills.map(skill => `${repo.name}/${skill.name}`),
        skillSets: [], skills: [`${repo.name}/read-report`], revisions: { [repo.name]: repo.revision || repo.digest } };
    const manifest = path.join(store.robotPath(robot.id), 'runtime', 'tasks', selection.catalogId, 'skill-catalog.json');
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, JSON.stringify(paths));
    return { root, store, robot: await store.get(robot.id), source, service, selection, paths, manifest };
}

test('explicit pin recovers a saved path manifest without rewriting its sources or selection', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.manifest, JSON.stringify([f.paths[0]]));
    await fs.writeFile(path.join(f.paths[0], 'helper.txt'), 'before pin');
    const original = await fs.readFile(f.manifest, 'utf8');
    const id = crypto.randomUUID();
    const session = { skillSelection: f.selection };
    const sessionStore = { loadSession: () => session, updateSession: async (_id, update) => update(session) };
    const catalog = createRobotSkillCatalog({ context: { robot: f.robot, store: f.store, skillsets: f.service }, sessionStore, workingDir: f.source });
    const initial = await catalog.refresh(id);
    assert.ok(initial.diagnostics.some(entry => /unavailable|cannot be proven/.test(entry.message)));
    await catalog.command(id, 'pin');
    const policy = await f.service.policies.read(f.robot.id, id);
    assert.equal(policy.mode, 'pinned');
    const directory = await f.service.catalogPath(f.robot.id, policy.pinnedCatalog);
    assert.deepEqual(policy.pinnedCatalog.resolvedSkills, [f.selection.resolvedSkills[0]]);
    await fs.writeFile(path.join(f.paths[0], 'helper.txt'), 'after pin');
    assert.equal(await fs.readFile(path.join(directory, 'read-report', 'helper.txt'), 'utf8'), 'before pin');
    assert.equal(await fs.readFile(f.manifest, 'utf8'), original);
    assert.deepEqual(session.legacySkillSelection, f.selection);
    const captured = await f.service.live.capture(f.robot, id, f.source);
    try { assert.equal(captured.catalogPath, directory); } finally { await captured.release(); }
});

test('empty path manifests recover as immutable empty selections', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.manifest, '[]');
    const recovered = await recoverPathCatalog(f.service, f.robot.id, f.selection);
    assert.deepEqual(recovered.entries, []);
    assert.deepEqual(await fs.readdir(await f.service.catalogPath(f.robot.id, recovered)), ['.catalog.json']);
    assert.equal(await fs.readFile(f.manifest, 'utf8'), '[]');
});

test('recovery rejects modified allowlists, symbolic links, and mismatched descriptors', async t => {
    const f = await fixture(t);
    const recover = () => recoverPathCatalog(f.service, f.robot.id, f.selection);
    for (const paths of [[f.paths[0], f.paths[0]], [f.source], ['/etc']]) {
        await fs.writeFile(f.manifest, JSON.stringify(paths));
        await assert.rejects(recover(), /changed/);
    }
    await fs.writeFile(f.manifest, JSON.stringify(f.paths));
    const outside = path.join(f.root, 'outside.json');
    await fs.rename(f.manifest, outside);
    await fs.symlink(outside, f.manifest);
    await assert.rejects(recover(), { code: 'ELOOP' });
    await fs.unlink(f.manifest);
    await fs.rename(outside, f.manifest);
    await fs.writeFile(path.join(f.paths[0], 'SKILL.md'), '---\nname: wrong-name\ndescription: changed\n---\n');
    await assert.rejects(recover(), /identity changed/);
    await fs.rm(f.paths[0], { recursive: true });
    await assert.rejects(recover(), { code: 'ENOENT' });
});

test('recovery detects a manifest change during source capture', async t => {
    const f = await fixture(t);
    const discover = f.service.discover.bind(f.service);
    let changed = false;
    f.service.discover = async directory => {
        const records = await discover(directory);
        if (!changed) { changed = true; await fs.writeFile(f.manifest, '[]'); }
        return records;
    };
    await assert.rejects(recoverPathCatalog(f.service, f.robot.id, f.selection), /changed during recovery/);
});
