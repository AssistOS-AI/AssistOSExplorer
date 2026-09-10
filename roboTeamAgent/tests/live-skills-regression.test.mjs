import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets } from '../server/robot-skillsets.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { skillCatalogRequest } from '../server/skill-catalog-api.mjs';
import { createRobotSkillCatalog } from '../copilot/src/lib/robotSkillCatalog.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const names = (catalog) => catalog.entries.map((entry) => entry.name).sort();
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
async function skill(root, relative, name = path.basename(relative), body = 'Instruction original') {
    const dir = path.join(root, relative);
    await write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\n${body}\n`);
    await write(path.join(dir, 'helper.txt'), 'helper-one');
    return dir;
}
async function fixture(t, { name = 'default', narrow = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-skills-'));
    const workspaceRoot = path.join(root, 'workspace');
    const scopeRoot = narrow ? path.join(workspaceRoot, 'launch') : workspaceRoot;
    await fs.mkdir(scopeRoot, { recursive: true });
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const robot = name === 'default' ? await store.ensureDefaultRobot() : await store.create({ name });
    const service = new RobotSkillsets({ robotStore: store, workspaceRoot, scopeRoot,
        ...(process.env.LIVE_SKILLS_ALA_ROOT ? { alaCommand: path.join(process.env.LIVE_SKILLS_ALA_ROOT, 'bin/ala.mjs') } : {}) });
    const releases = [];
    t.after(async () => { for (const release of releases) await release(); await fs.rm(root, { recursive: true, force: true }); });
    const policy = async (input = { skillSets: ['workspace'] }, legacy) => {
        const id = crypto.randomUUID();
        await service.policies.ensure(await store.get(robot.id), id, { input, legacy });
        return id;
    };
    const capture = async (id, cwd = scopeRoot) => {
        const result = await service.live.capture(await store.get(robot.id), id, cwd);
        releases.push(result.release);
        return result;
    };
    const inventory = async (id, cwd = scopeRoot) => service.inventory(await store.get(robot.id), { policyId: id, cwd });
    return { root, workspaceRoot, scopeRoot, store, robot, service, releases, policy, capture, inventory };
}

function conversation(f, id) {
    const session = { sessionId: id, skillPolicyRef: id, cwd: f.scopeRoot };
    const sessionStore = { loadSession: () => structuredClone(session),
        updateSession: async (_id, update) => { update(session); return structuredClone(session); } };
    return createRobotSkillCatalog({ context: { store: f.store, robot: f.robot, skillsets: f.service },
        sessionStore, workingDir: f.scopeRoot, initialSessionId: id });
}

test('submission retains intent and the actual execution boundary captures edits made during queue wait', async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const reference = await f.service.start(f.robot, { skillSets: ['workspace'] }, (_robot, selection) => selection);
    assert.equal(reference.catalogId, undefined);
    await fs.writeFile(path.join(source, 'helper.txt'), 'edited-after-submission');
    const catalog = conversation(f, reference.policyId);
    await catalog.refresh(reference.policyId);
    await assert.rejects(fs.readdir(f.service.live.root(f.robot.id)), { code: 'ENOENT' }, 'inventory must not create an execution snapshot');
    const active = await catalog.refresh(reference.policyId, { execution: true });
    f.releases.push(active.release);
    assert.equal(await fs.readFile(path.join(active.catalogPath, 'local/helper.txt'), 'utf8'), 'edited-after-submission');
    await fs.writeFile(path.join(source, 'helper.txt'), 'edited-while-running');
    assert.equal(await fs.readFile(path.join(active.catalogPath, 'local/helper.txt'), 'utf8'), 'edited-after-submission');
    await active.release();
    const next = await catalog.refresh(reference.policyId, { execution: true });
    f.releases.push(next.release);
    assert.equal(await fs.readFile(path.join(next.catalogPath, 'local/helper.txt'), 'utf8'), 'edited-while-running');
});

test('live capture hashes helper bytes despite equal size/restored mtime, assets, descriptors, and executable modes', async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const first = await f.capture(id);
    const helper = path.join(source, 'helper.txt');
    const before = await fs.stat(helper);
    await fs.writeFile(helper, 'helper-two');
    await fs.utimes(helper, before.atime, before.mtime);
    const second = await f.capture(id);
    assert.notEqual(first.revision, second.revision);
    assert.equal(await fs.readFile(path.join(first.catalogPath, 'local/helper.txt'), 'utf8'), 'helper-one');
    assert.equal(await fs.readFile(path.join(second.catalogPath, 'local/helper.txt'), 'utf8'), 'helper-two');
    await write(path.join(source, 'assets/context.txt'), 'asset-only');
    const third = await f.capture(id);
    assert.notEqual(second.revision, third.revision);
    await fs.chmod(helper, 0o755);
    const fourth = await f.capture(id);
    assert.notEqual(third.revision, fourth.revision);
    assert.equal((await fs.stat(path.join(fourth.catalogPath, 'local/helper.txt'))).mode & 0o111, 0o111);
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: local\ndescription: New descriptor\n---\nnew instructions\n');
    const fifth = await f.capture(id);
    assert.notEqual(fourth.revision, fifth.revision);
    assert.equal(fifth.entries[0].description, 'New descriptor');
    const reused = await f.capture(id);
    assert.equal(reused.catalogPath, fifth.catalogPath);
});

test('fresh descendants with .git files and agent packages appear, then final deletion produces explicit empty catalog', async (t) => {
    const f = await fixture(t);
    const id = await f.policy();
    assert.deepEqual(names(await f.capture(id)), []);
    await write(path.join(f.scopeRoot, 'new-repo/.git'), 'gitdir: /unused/fixture-worktree');
    const repoSkill = await skill(f.scopeRoot, 'new-repo/skills/repo-local');
    await write(path.join(f.scopeRoot, 'package/manifest.json'), '{}');
    const packageSkill = await skill(f.scopeRoot, 'package/skills/package-local');
    assert.deepEqual(names(await f.capture(id)), ['package-local', 'repo-local']);
    await fs.rm(repoSkill, { recursive: true });
    await fs.rm(packageSkill, { recursive: true });
    const empty = await f.capture(id);
    assert.deepEqual(names(empty), []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(empty.catalogPath, '.catalog.json'))).entries, []);
});

test('discovery respects launch scope, conventional roots, aliases and pruned directories', async (t) => {
    const f = await fixture(t, { narrow: true });
    await skill(f.workspaceRoot, '.agents/skills/outside-launch');
    await skill(f.scopeRoot, '.agents/skills/root-local');
    await fs.symlink('.agents', path.join(f.scopeRoot, '.claude'));
    await skill(f.scopeRoot, 'ordinary/nested/.agents/skills/intentional');
    await skill(f.scopeRoot, 'arbitrary/example');
    await skill(f.scopeRoot, 'ordinary/skills/not-a-boundary');
    for (const dir of ['node_modules', 'output', 'dist', 'build', '.ploinky', '.cache', '.worktrees', 'vendor']) {
        await skill(f.scopeRoot, `${dir}/.agents/skills/pruned`);
    }
    const id = await f.policy();
    const entries = (await f.inventory(id)).skills.filter((entry) => entry.source === 'workspace');
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['intentional', 'root-local']);
    assert.equal(entries.filter((entry) => entry.name === 'root-local').length, 1);
});

test('saved launch scope cannot be redirected through a later symlink to another workspace subtree', async (t) => {
    const f = await fixture(t, { narrow: true });
    await skill(f.scopeRoot, '.agents/skills/allowed');
    const id = await f.policy();
    await skill(f.workspaceRoot, 'sibling/.agents/skills/outside-launch');
    await fs.rename(f.scopeRoot, `${f.scopeRoot}-original`);
    await fs.symlink(path.join(f.workspaceRoot, 'sibling'), f.scopeRoot);
    await assert.rejects(f.capture(id, path.join(f.workspaceRoot, 'sibling')), /scope|changed|redirect/);
});

test('malformed automatic candidates and nested descriptors degrade individually without stale catalog reuse', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/good');
    const id = await f.policy();
    const first = await f.capture(id);
    await write(path.join(f.scopeRoot, '.agents/skills/bad/SKILL.md'), 'malformed');
    await skill(f.scopeRoot, '.agents/skills/nested');
    await skill(f.scopeRoot, '.agents/skills/nested/child', 'inner');
    const next = await f.capture(id);
    assert.deepEqual(names(next), ['good']);
    assert.ok(next.diagnostics.some((item) => item.identity?.endsWith('/bad')));
    assert.ok(next.diagnostics.some((item) => item.identity?.endsWith('/nested')));
    assert.notEqual(next.revision, first.revision);
    await assert.rejects(f.policy({ skills: ['workspace:.agents/skills/bad'] }).then((explicit) => f.capture(explicit)), /explicitly selected|invalid|valid/);
    await assert.rejects(f.policy({ skillSets: ['workspace:.agents/skills'] }).then((explicit) => f.capture(explicit)), /invalid|valid/);
});

test('same-name siblings conflict, qualified selection resolves and identity exclusions persist through new additions', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, 'left/.agents/skills/shared');
    await skill(f.scopeRoot, 'right/.agents/skills/shared');
    const id = await f.policy();
    const conflicted = await f.inventory(id);
    assert.equal(conflicted.skills.filter((entry) => entry.state === 'conflict').length, 2);
    assert.deepEqual(names(await f.capture(id)), []);
    const left = 'workspace:left/.agents/skills/shared';
    const chosen = await f.service.setEnabled(await f.store.get(f.robot.id), id, conflicted.policyVersion, left, true, f.scopeRoot);
    assert.equal(chosen.skills.filter((entry) => entry.enabled).length, 1);
    assert.equal(chosen.skills.find((entry) => entry.enabled).identity, left);
    const disabled = await f.service.setEnabled(await f.store.get(f.robot.id), id, chosen.policyVersion, left, false, f.scopeRoot);
    assert.equal(disabled.skills.find((entry) => entry.identity === left).enabled, false);
    await skill(f.scopeRoot, '.agents/skills/new-local');
    const next = await f.inventory(id);
    assert.equal(next.skills.find((entry) => entry.name === 'new-local').enabled, true);
    assert.equal(next.skills.find((entry) => entry.identity === left).enabled, false);
    await assert.rejects(f.service.setEnabled(await f.store.get(f.robot.id), id, conflicted.policyVersion, left, true), /policy changed/);
});

test('saved cwd wins locality without changing scope and policy inputs change the revision', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/shared');
    await skill(f.scopeRoot, 'nested/.agents/skills/shared');
    await fs.mkdir(path.join(f.scopeRoot, 'nested/work'), { recursive: true });
    const id = await f.policy();
    const root = await f.capture(id);
    const nested = await f.capture(id, path.join(f.scopeRoot, 'nested/work'));
    assert.equal(root.entries[0].identity, 'workspace:.agents/skills/shared');
    assert.equal(nested.entries[0].identity, 'workspace:nested/.agents/skills/shared');
    assert.notEqual(root.revision, nested.revision);
});

test('a rejected second native-name winner leaves policy and version unchanged and can be corrected', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, 'left/.agents/skills/shared');
    await skill(f.scopeRoot, 'right/.agents/skills/shared');
    const id = await f.policy();
    const left = 'workspace:left/.agents/skills/shared';
    const right = 'workspace:right/.agents/skills/shared';
    const first = await f.service.setEnabled(f.robot, id, 1, left, true, f.scopeRoot);
    const saved = await f.service.policies.read(f.robot.id, id);
    await assert.rejects(f.service.setEnabled(f.robot, id, first.policyVersion, right, true, f.scopeRoot), /duplicate native name/);
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), saved);
    assert.equal((await f.capture(id)).entries[0].identity, left);
    const disabled = await f.service.setEnabled(f.robot, id, first.policyVersion, left, false, f.scopeRoot);
    const replacement = await f.service.setEnabled(f.robot, id, disabled.policyVersion, right, true, f.scopeRoot);
    assert.equal(replacement.skills.find((entry) => entry.enabled).identity, right);
    assert.equal((await f.capture(id)).entries[0].identity, right);
});

test('toggle validation stays outside the registry lock and a concurrent policy update wins', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const entered = deferred(), proceed = deferred();
    const inventory = f.service.inventory.bind(f.service);
    f.service.inventory = async (robot, options) => {
        const result = await inventory(robot, options);
        if (options.policy) { entered.resolve(); await proceed.promise; }
        return result;
    };
    const pending = f.service.setEnabled(f.robot, id, 1, 'workspace:.agents/skills/local', false, f.scopeRoot);
    await entered.promise;
    let current;
    try {
        current = await f.service.policies.update(f.robot.id, id, 1, (policy) => ({ ...policy, selectors: { skillSets: [], skills: [] } }));
    } finally { proceed.resolve(); }
    await assert.rejects(pending, (error) => error.statusCode === 409 && /policy changed/.test(error.message));
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), current);
    assert.deepEqual(names(await f.capture(id)), []);
});

for (const change of ['deleted', 'malformed']) {
    test(`an individually disabled skill stays optional when ${change} and disabled when it returns`, async (t) => {
        const f = await fixture(t);
        const relative = '.agents/skills/folder-name';
        const dir = await skill(f.scopeRoot, relative, 'native-name');
        const id = await f.policy({ skillSets: [], skills: [] });
        const identity = `workspace:${relative}`;
        const selected = await f.service.setEnabled(f.robot, id, 1, identity, true, f.scopeRoot);
        const disabled = await f.service.setEnabled(f.robot, id, selected.policyVersion, identity, false, f.scopeRoot);
        if (change === 'deleted') await fs.rm(dir, { recursive: true });
        else await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
        assert.ok((await f.inventory(id)).skills.every((entry) => !entry.enabled));
        assert.deepEqual(names(await f.capture(id)), []);
        if (change === 'malformed') {
            const previous = await f.service.policies.read(f.robot.id, id);
            await assert.rejects(f.service.setEnabled(f.robot, id, disabled.policyVersion, identity, true, f.scopeRoot), /selected skill|descriptor/);
            assert.deepEqual(await f.service.policies.read(f.robot.id, id), previous);
        }
        await skill(f.scopeRoot, relative, 'native-name');
        assert.equal((await f.inventory(id)).skills.find((entry) => entry.identity === identity).state, 'disabled');
        assert.deepEqual(names(await f.capture(id)), []);
        await f.service.setEnabled(f.robot, id, disabled.policyVersion, identity, true, f.scopeRoot);
        assert.deepEqual(names(await f.capture(id)), ['native-name']);
    });
}

test('an excluded workspace source may disappear without invalidating its qualified selectors', async (t) => {
    const f = await fixture(t);
    const dir = await skill(f.scopeRoot, '.agents/skills/local');
    const source = 'workspace:.agents/skills';
    const id = await f.policy({ skillSets: [source], skills: ['workspace:.agents/skills/local'] });
    await f.service.policies.update(f.robot.id, id, 1, (policy) => ({ ...policy, excludedSources: [source] }));
    await fs.rm(path.dirname(dir), { recursive: true });
    assert.deepEqual(names(await f.capture(id)), []);
    await skill(f.scopeRoot, '.agents/skills/local');
    assert.equal((await f.inventory(id)).skills[0].state, 'disabled');
});

test('an excluded imported identity does not require a removed or replacement source generation', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: [], skills: ['documents/native-name'] });
    const disabled = await f.service.setEnabled(await f.store.get(f.robot.id), id, 1, 'documents/native-name', false, f.scopeRoot);
    await f.service.remove(f.robot.id, 'documents');
    assert.deepEqual(names(await f.capture(id)), []);
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    assert.deepEqual(names(await f.capture(id)), []);
    await f.service.setEnabled(await f.store.get(f.robot.id), id, disabled.policyVersion, 'documents/native-name', true, f.scopeRoot);
    assert.deepEqual(names(await f.capture(id)), ['native-name']);
});

test('a logical name exclusion suppresses a missing qualified imported identity without dropping its intent', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: [], skills: ['documents/native-name'] });
    await conversation(f, id).command(id, 'deny-name native-name');
    await fs.rm(dir, { recursive: true });
    assert.deepEqual(names(await f.capture(id)), []);
    await conversation(f, id).command(id, 'allow-name native-name');
    await assert.rejects(f.capture(id), /explicitly selected skill is unavailable/);
});

for (const change of ['deleted', 'malformed']) {
    test(`a proven workspace logical-name exclusion survives a ${change} descriptor and allow-name reverses it`, async (t) => {
        const f = await fixture(t);
        const relative = '.agents/skills/folder-name';
        const identity = `workspace:${relative}`;
        const dir = await skill(f.scopeRoot, relative, 'native-name');
        const id = await f.policy({ skills: [identity] });
        const catalog = conversation(f, id);
        await catalog.command(id, 'deny-name native-name');
        const saved = await f.service.policies.read(f.robot.id, id);
        assert.deepEqual(saved.excludedNameIdentities, { [identity]: 'native-name' });
        if (change === 'deleted') await fs.rm(dir, { recursive: true });
        else await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
        assert.ok((await f.inventory(id)).skills.every(entry => !entry.enabled));
        assert.deepEqual(names(await f.capture(id)), []);
        assert.deepEqual(await f.service.policies.read(f.robot.id, id), saved, 'Inventory and capture must not mutate exclusion provenance.');
        await catalog.command(id, 'allow-name native-name');
        assert.equal((await f.service.policies.read(f.robot.id, id)).excludedNameIdentities, undefined);
        await assert.rejects(f.capture(id), /explicitly selected skill/);
        await skill(f.scopeRoot, relative, 'native-name');
        assert.deepEqual(names(await f.capture(id)), ['native-name']);
    });
}

test('a valid workspace descriptor rename outranks historical excluded-name provenance', async (t) => {
    const f = await fixture(t);
    const relative = '.agents/skills/folder-name';
    const identity = `workspace:${relative}`;
    await skill(f.scopeRoot, relative, 'native-name');
    const id = await f.policy({ skills: [identity] });
    const catalog = conversation(f, id);
    await catalog.command(id, 'deny-name native-name');
    await skill(f.scopeRoot, relative, 'replacement-name');
    assert.deepEqual(names(await f.capture(id)), ['replacement-name']);
    await catalog.command(id, `use ${identity}`);
    assert.equal((await f.service.policies.read(f.robot.id, id)).excludedNameIdentities, undefined,
        'A mutation that observes the valid new name must discard the old association.');
    await fs.writeFile(path.join(f.scopeRoot, relative, 'SKILL.md'), 'malformed');
    await assert.rejects(f.capture(id), /explicitly selected skill/);
});

test('Settings toggles discard a workspace name exclusion after observing a valid renamed descriptor', async (t) => {
    const f = await fixture(t);
    const relative = '.agents/skills/folder-name', identity = `workspace:${relative}`;
    const dir = await skill(f.scopeRoot, relative, 'native-name');
    const id = await f.policy({ skillSets: [], skills: [identity] });
    await conversation(f, id).command(id, 'deny-name native-name');
    await skill(f.scopeRoot, relative, 'replacement-name');
    let policy = await f.service.policies.read(f.robot.id, id);
    const disabled = await f.service.setEnabled(f.robot, id, policy.policyVersion, identity, false, f.scopeRoot);
    const enabled = await f.service.setEnabled(f.robot, id, disabled.policyVersion, identity, true, f.scopeRoot);
    assert.equal(enabled.policy.excludedNameIdentities, undefined);
    assert.deepEqual(names(await f.capture(id)), ['replacement-name']);
    policy = await f.service.policies.read(f.robot.id, id);
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
    await assert.rejects(f.capture(id), /explicitly selected skill/);
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), policy);
});

for (const origin of ['registered', 'added-live', 'renamed-live']) {
    test(`disabled imported ${origin} skill retains its proven identity through malformed, deleted and restored descriptors`, async (t) => {
        const f = await fixture(t, { name: 'Analyst' });
        const initial = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
        await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(initial) });
        const relative = origin === 'added-live' ? 'import-only/new-folder' : 'import-only/folder-name';
        const nativeName = origin === 'registered' ? 'native-name' : 'replacement-name';
        const dir = await skill(f.scopeRoot, relative, nativeName);
        if (origin === 'added-live') await fs.rm(initial, { recursive: true });
        const id = await f.policy({ skillSets: ['documents'] });
        const identity = `documents/${nativeName}`, robot = await f.store.get(f.robot.id);
        const disabled = await f.service.setEnabled(robot, id, 1, identity, false, f.scopeRoot);
        const proof = disabled.policy.importedSkillNames.documents;
        assert.deepEqual(proof, { source: robot.skillsets[0].source, generation: robot.skillsets[0].generation,
            names: { [path.basename(relative)]: nativeName } });
        await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
        assert.equal((await f.inventory(id)).skills.find(entry => entry.identity === identity).state, 'disabled');
        assert.deepEqual(names(await f.capture(id)), []);
        assert.deepEqual(await f.service.policies.read(f.robot.id, id), disabled.policy, 'Reads must not rewrite imported name evidence.');
        await fs.rm(dir, { recursive: true });
        assert.deepEqual(names(await f.capture(id)), []);
        await skill(f.scopeRoot, relative, nativeName);
        assert.equal((await f.inventory(id)).skills.find(entry => entry.identity === identity).state, 'disabled');
        await f.service.setEnabled(robot, id, disabled.policyVersion, identity, true, f.scopeRoot);
        assert.deepEqual(names(await f.capture(id)), [nativeName]);
    });
}

test('registered imported names remain provable when a descriptor is already malformed during a logical exclusion', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: ['documents'] });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
    await conversation(f, id).command(id, 'deny-name native-name');
    assert.equal((await f.inventory(id)).skills.find(entry => entry.identity === 'documents/native-name').state, 'disabled');
    assert.deepEqual(names(await f.capture(id)), []);
    await conversation(f, id).command(id, 'allow-name native-name');
    await assert.rejects(f.capture(id), /selected skill documents\/native-name/);
});

test('an explicitly observed imported rename supersedes registration and old exclusion evidence after a malformed edit', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const relative = 'import-only/folder-name';
    const dir = await skill(f.scopeRoot, relative, 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: ['documents'] });
    await conversation(f, id).command(id, 'deny-name native-name');
    await skill(f.scopeRoot, relative, 'replacement-name');
    assert.deepEqual(names(await f.capture(id)), ['replacement-name']);
    const current = await f.service.policies.read(f.robot.id, id);
    const selected = await f.service.setEnabled(await f.store.get(f.robot.id), id, current.policyVersion, 'documents/replacement-name', true, f.scopeRoot);
    assert.equal(selected.policy.importedSkillNames.documents.names['folder-name'], 'replacement-name');
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
    await assert.rejects(f.capture(id), /selected skill documents\/replacement-name/);
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), selected.policy);
});

test('replacing /skills selection preserves imported live-name evidence through a malformed edit', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: ['documents'] });
    await conversation(f, id).command(id, 'deny-name native-name');
    await skill(f.scopeRoot, 'import-only/folder-name', 'replacement-name');
    await conversation(f, id).command(id, 'use documents/replacement-name');
    const proof = (await f.service.policies.read(f.robot.id, id)).importedSkillNames;
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
    await conversation(f, id).command(id, 'use none');
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).importedSkillNames, proof);
    await assert.rejects(conversation(f, id).command(id, 'use documents/replacement-name'), /explicitly selected skill/);
    assert.deepEqual(names(await f.capture(id)), []);
});

test('an imported source-root descriptor retains name evidence at an empty relative directory', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: dir });
    const id = await f.policy({ skillSets: ['documents'] });
    const disabled = await f.service.setEnabled(await f.store.get(f.robot.id), id, 1, 'documents/native-name', false, f.scopeRoot);
    assert.equal(disabled.policy.importedSkillNames.documents.names[''], 'native-name');
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).importedSkillNames, disabled.policy.importedSkillNames);
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
    assert.deepEqual(names(await f.capture(id)), []);
});

test('unproven malformed imported folders cannot inherit exclusions from a matching folder name', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: ['documents'] });
    await f.service.setEnabled(await f.store.get(f.robot.id), id, 1, 'documents/native-name', false, f.scopeRoot);
    await fs.rm(dir, { recursive: true });
    await write(path.join(f.scopeRoot, 'import-only/native-name/SKILL.md'), 'malformed');
    await assert.rejects(f.capture(id), /selected skill documents\/native-name/);
    await conversation(f, id).command(id, 'deny-name native-name');
    await assert.rejects(f.capture(id), /selected skill documents\/native-name/);
});

test('imported name evidence is tied to the exact registered source generation and path', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: ['documents'] });
    await conversation(f, id).command(id, 'deny-name native-name');
    const policy = await f.service.policies.read(f.robot.id, id);
    await f.service.remove(f.robot.id, 'documents');
    const replacement = await skill(f.scopeRoot, 'other-source/folder-name', 'replacement-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(replacement) });
    const robot = await f.store.get(f.robot.id), set = robot.skillsets[0];
    for (const stale of [policy.importedSkillNames.documents, { ...policy.importedSkillNames.documents, source: set.source },
        { ...policy.importedSkillNames.documents, generation: set.generation }]) {
        const proposed = { ...policy, bindings: { documents: { source: set.source, generation: set.generation } },
            importedSkillNames: { documents: stale } };
        await fs.writeFile(path.join(replacement, 'SKILL.md'), 'malformed');
        await assert.rejects(f.service.inventory(robot, { policy: proposed, cwd: f.scopeRoot }), /selected skill documents\/replacement-name/);
    }
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), policy);
});

test('imported name evidence is optional, bounded, and schema-validated when stored', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const id = await f.policy({ skillSets: [], skills: [] });
    const policy = await f.service.policies.read(f.robot.id, id), file = f.service.policies.file(f.robot.id, id);
    const valid = { source: f.scopeRoot, generation: crypto.randomUUID(), names: { 'folder-name': 'native-name' } };
    for (const value of [null, [], { documents: null }, { documents: { ...valid, extra: true } },
        { documents: { ...valid, source: '../outside' } }, { documents: { ...valid, source: `${f.scopeRoot}/../other` } },
        { documents: { ...valid, generation: 'not-a-generation' } }, { workspace: valid },
        { documents: { ...valid, names: [] } }, { documents: { ...valid, names: { '../escape': 'native-name' } } },
        { documents: { ...valid, names: { '/absolute': 'native-name' } } }, { documents: { ...valid, names: { folder: 'OtherName' } } },
        { documents: { ...valid, names: { ['a'.repeat(2049)]: 'native-name' } } },
        { documents: { ...valid, names: Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`folder-${n}`, 'native-name'])) } },
        Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`source-${n}`, valid]))]) {
        await fs.writeFile(file, JSON.stringify({ ...policy, importedSkillNames: value }));
        await assert.rejects(f.service.policies.read(f.robot.id, id), /invalid stored imported skill name provenance/);
    }
    await fs.writeFile(file, JSON.stringify({ ...policy, importedSkillNames: { documents: valid } }));
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).importedSkillNames, { documents: valid });
    await fs.writeFile(file, JSON.stringify(policy));
    assert.equal((await f.service.policies.read(f.robot.id, id)).importedSkillNames, undefined);
});

test('explicit workspace selection learns an existing name exclusion from a newly added valid descriptor', async (t) => {
    const f = await fixture(t);
    const id = await f.policy({ skillSets: [], skills: [] });
    const catalog = conversation(f, id);
    await catalog.command(id, 'deny-name native-name');
    const relative = '.agents/skills/folder-name';
    const identity = `workspace:${relative}`;
    const dir = await skill(f.scopeRoot, relative, 'native-name');
    await catalog.command(id, `use ${identity}`);
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).excludedNameIdentities, { [identity]: 'native-name' });
    await catalog.command(id, 'use none');
    await fs.rm(dir, { recursive: true });
    assert.deepEqual(names(await f.capture(id)), []);
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).excludedNameIdentities, { [identity]: 'native-name' },
        'Replacing selection preserves independent logical exclusion intent.');
});

test('legacy name exclusions remember only workspace names proven by valid descriptors', async (t) => {
    const f = await fixture(t);
    const relative = '.agents/skills/folder-name';
    const identity = `workspace:${relative}`;
    const dir = await skill(f.scopeRoot, relative, 'native-name');
    await write(path.join(f.store.robotPath(f.robot.id), 'copilot/settings.json'), JSON.stringify({ disabledSkills: ['native-name'] }));
    const legacy = { skillSets: [], skills: [identity] };
    const id = await f.policy(undefined, legacy);
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).excludedNameIdentities, { [identity]: 'native-name' });
    await fs.rm(dir, { recursive: true });
    assert.deepEqual(names(await f.capture(id)), []);
    const unprovenId = await f.policy(undefined, legacy);
    assert.equal((await f.service.policies.read(f.robot.id, unprovenId)).excludedNameIdentities, undefined);
    await assert.rejects(f.capture(unprovenId), /explicitly selected skill is unavailable/,
        'A missing descriptor with an unprovable native name must not be guessed from its folder.');
});

test('name-exclusion provenance is optional for old policies and strictly validated when present', async (t) => {
    const f = await fixture(t);
    const id = await f.policy({ skillSets: [], skills: [] });
    const saved = await f.service.policies.read(f.robot.id, id);
    assert.equal(saved.excludedNameIdentities, undefined);
    const file = f.service.policies.file(f.robot.id, id);
    for (const value of [null, [], { 'documents/native-name': 'native-name' },
        { 'workspace:../escape': 'native-name' }, { 'workspace:.agents/skills/local': ['native-name'] },
        { 'workspace:.agents/skills/local': 'OtherName' }, { 'workspace:.agents/skills/local': 'not-excluded' }]) {
        await fs.writeFile(file, JSON.stringify({ ...saved, excludedNames: ['native-name'], excludedNameIdentities: value }));
        await assert.rejects(f.service.policies.read(f.robot.id, id), /invalid stored name-exclusion identity provenance/);
    }
    await fs.writeFile(file, JSON.stringify(saved));
    assert.deepEqual(await f.service.policies.read(f.robot.id, id), saved);
});

test('an imported source whose name begins with workspace can be individually enabled', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const dir = await skill(f.scopeRoot, 'import-only/folder-name', 'native-name');
    await f.service.add(f.robot.id, { name: 'workspace-tools', source: path.dirname(dir) });
    const id = await f.policy({ skillSets: [], skills: [] });
    const current = await f.store.get(f.robot.id);
    const result = await f.service.setEnabled(current, id, 1, 'workspace-tools/native-name', true, f.scopeRoot);
    const source = current.skillsets.find(set => set.name === 'workspace-tools');
    assert.deepEqual(result.policy.bindings['workspace-tools'], { source: source.source, generation: source.generation });
    assert.deepEqual(names(await f.capture(id)), ['native-name']);
});

test('logical name exclusions cover future identities while a single identity exclusion does not disable its alias', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/shared');
    await write(path.join(f.store.robotPath(f.robot.id), 'copilot/settings.json'), JSON.stringify({ disabledSkills: ['shared'] }));
    const id = await f.policy();
    assert.deepEqual(names(await f.capture(id)), []);
    await skill(f.scopeRoot, 'new-repo/.agents/skills/shared');
    assert.ok((await f.inventory(id)).skills.filter((entry) => entry.name === 'shared').every((entry) => !entry.enabled));
    const catalog = conversation(f, id);
    await catalog.command(id, 'allow-name shared');
    let inventory = await f.inventory(id);
    assert.equal(inventory.skills.find((entry) => entry.enabled).identity, 'workspace:.agents/skills/shared');
    await f.service.setEnabled(await f.store.get(f.robot.id), id, inventory.policyVersion, 'workspace:.agents/skills/shared', false, f.scopeRoot);
    inventory = await f.inventory(id);
    assert.equal(inventory.skills.find((entry) => entry.enabled).identity, 'workspace:new-repo/.agents/skills/shared');
    await catalog.command(id, 'deny-name shared');
    assert.deepEqual(names(await f.capture(id)), []);
});

test('declared local replacement remains a tombstone after deletion and cannot silently revive a remote distribution', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const remote = path.join(f.root, 'remote-fixture');
    await skill(remote, 'shared', 'shared', 'Remote distribution');
    f.service.execImpl = async (_command, args) => {
        if (args.includes('clone')) await fs.cp(remote, args.at(-1), { recursive: true });
        return { stdout: 'fixture-commit\n' };
    };
    await f.service.add(f.robot.id, { name: 'distribution', source: 'https://example.test/skills.git' });
    const local = await skill(f.scopeRoot, '.agents/skills/shared', 'shared', 'Local replacement');
    const id = await f.policy({ skillSets: ['distribution'] });
    assert.equal((await f.capture(id)).entries[0].identity, 'distribution/shared');
    const catalog = conversation(f, id);
    await catalog.command(id, 'override distribution workspace:.agents/skills');
    const replaced = await f.capture(id);
    assert.equal(replaced.entries[0].identity, 'workspace:.agents/skills/shared');
    await fs.rm(local, { recursive: true });
    const removed = await f.capture(id);
    assert.deepEqual(names(removed), []);
    const inventory = await f.inventory(id);
    assert.equal(inventory.skills.find((entry) => entry.identity === 'distribution/shared').state, 'shadowed');
    await assert.rejects(f.service.setEnabled(await f.store.get(f.robot.id), id, inventory.policyVersion, 'distribution/shared', true, f.scopeRoot), /overrid|shadowed/);
    await fs.rm(path.dirname(local), { recursive: true });
    await assert.rejects(f.capture(id), /unavailable/);
    assert.equal((await f.service.policies.read(f.robot.id, id)).overrides.distribution, 'workspace:.agents/skills');
});

test('live imported local sources refresh from working files and pinned captures survive source removal', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const source = await skill(f.scopeRoot, 'import-only/local');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(source) });
    const id = await f.policy({ skillSets: ['documents'] });
    const first = await f.capture(id);
    await fs.writeFile(path.join(source, 'helper.txt'), 'edited-local');
    const fresh = await f.capture(id);
    assert.equal(await fs.readFile(path.join(fresh.catalogPath, 'local/helper.txt'), 'utf8'), 'edited-local');
    const { release, ...pinnedCatalog } = first;
    const policy = await f.service.policies.read(f.robot.id, id);
    await f.service.policies.update(f.robot.id, id, policy.policyVersion, (value) => ({ ...value, mode: 'pinned', pinnedCatalog }));
    await f.service.remove(f.robot.id, 'documents');
    await fs.rm(source, { recursive: true });
    const pinned = await f.capture(id);
    assert.equal(pinned.catalogPath, first.catalogPath);
    assert.equal(await fs.readFile(path.join(pinned.catalogPath, 'local/helper.txt'), 'utf8'), 'helper-one');
});

test('imported source-qualified identity follows the descriptor name when its directory uses another name', async (t) => {
    const f = await fixture(t, { name: 'Analyst' });
    const source = await skill(f.scopeRoot, 'import-only/folder-name', 'descriptor-name');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(source) });
    const id = await f.policy({ skillSets: [], skills: ['documents/descriptor-name'] });
    const inventory = await f.inventory(id);
    assert.equal(inventory.skills.find((entry) => entry.enabled).identity, 'documents/descriptor-name');
    assert.deepEqual(names(await f.capture(id)), ['descriptor-name']);
});

test('an explicit empty catalog can be pinned and later returned to live selection', async (t) => {
    const f = await fixture(t);
    const id = await f.policy({ skillSets: [], skills: [] });
    const catalog = conversation(f, id);
    const empty = await catalog.refresh(id, { execution: true });
    f.releases.push(empty.release);
    await empty.release();
    await catalog.command(id, 'pin');
    await skill(f.scopeRoot, '.agents/skills/new-local');
    assert.deepEqual((await catalog.refresh(id)).skills, []);
    const pinned = await catalog.refresh(id, { execution: true });
    f.releases.push(pinned.release);
    assert.deepEqual(names(pinned), []);
    assert.equal(pinned.catalogPath, empty.catalogPath);
    await pinned.release();
    await catalog.command(id, 'live');
    await catalog.command(id, 'use workspace');
    const live = await catalog.refresh(id, { execution: true });
    f.releases.push(live.release);
    assert.deepEqual(names(live), ['new-local']);
});

test('legacy explicit empties remain empty, only nonempty bundled-only defaults migrate with opt-out diagnostics', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/local');
    for (const legacy of [{ skillSets: [], skills: [] }, { skillSets: [], skills: ['copilot/bash'] }]) {
        const id = await f.policy(undefined, legacy);
        const migrated = await f.service.policies.read(f.robot.id, id);
        assert.deepEqual(migrated.selectors, { skillSets: legacy.skillSets, skills: legacy.skills });
        assert.equal(migrated.selectors.skillSets.includes('workspace'), false);
    }
    const id = await f.policy(undefined, { skillSets: ['copilot'], skills: [] });
    const migrated = await f.service.policies.read(f.robot.id, id);
    assert.deepEqual(migrated.selectors.skillSets, ['copilot', 'workspace']);
    assert.match(JSON.stringify(migrated.diagnostics), /historically identical|historically indistinguishable/);
    assert.match(JSON.stringify(migrated.diagnostics), /use copilot/);
    const restricted = await f.policy({ skillSets: ['copilot'], skills: [] });
    assert.deepEqual((await f.service.policies.read(f.robot.id, restricted)).selectors.skillSets, ['copilot']);
});

test('legacy missing or reimported sources fail visibly instead of silently picking a new source', async (t) => {
    const f = await fixture(t);
    const id = await f.policy(undefined, { skillSets: ['missing'], skills: [], revisions: { missing: 'unproved' } });
    const policy = await f.service.policies.read(f.robot.id, id);
    assert.ok(policy.diagnostics.some((item) => item.state === 'migration-required'));
    await assert.rejects(f.capture(id), /not available|unavailable/);
    const source = await skill(f.scopeRoot, 'import-only/local');
    const original = await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(source) });
    await f.service.remove(f.robot.id, 'documents');
    await fs.writeFile(path.join(source, 'helper.txt'), 'replacement-source');
    await f.service.add(f.robot.id, { name: 'documents', source: path.dirname(source) });
    for (const legacy of [{ skillSets: ['documents'], skills: [], revisions: { documents: original.digest } },
        { skillSets: ['documents'], skills: [] }]) {
        const replacedId = await f.policy(undefined, legacy);
        assert.ok((await f.service.policies.read(f.robot.id, replacedId)).diagnostics.some((item) => item.state === 'migration-required'));
        await assert.rejects(f.capture(replacedId), /unavailable|reselection/);
    }
});

test('terminal task continuation uses the latest conversation policy and preserves native session identity', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const initial = await f.capture(id);
    const manager = new RuntimeManager({ dataDir: f.store.dataDir, toolCache: {}, skillsets: f.service });
    manager.shuttingDown = true;
    const started = manager.startTask(f.robot, 'simple', { cwd: f.scopeRoot, task: 'Original', skillPolicyRef: id, alaSessionId: id,
        skillSelection: { skillSets: ['copilot'], skills: [] } });
    const old = manager.tasks.get(started.taskId);
    old.state = 'completed';
    await manager._saveTask(old);
    await f.service.policies.update(f.robot.id, id, initial.policyVersion, (value) => ({ ...value, selectors: { skillSets: [], skills: [] } }));
    const resumed = await manager.resumeTask(f.robot, started.taskId, 'Continue');
    const current = manager.tasks.get(resumed.taskId);
    assert.equal(current.alaSessionId, id);
    assert.equal(current.request.skillPolicyRef, id);
    assert.equal(current.request.skillSelection, undefined);
    assert.deepEqual(names(await f.capture(id)), []);
    assert.deepEqual((await f.service.policies.read(f.robot.id, id)).selectors, { skillSets: [], skills: [] });
});

test('saved session selection outranks stale legacy task request during first migration', async (t) => {
    const f = await fixture(t);
    const id = crypto.randomUUID();
    await write(path.join(f.store.robotPath(f.robot.id), 'copilot/sessions', `${id}.json`), JSON.stringify({ sessionId: id, skillSelection: { skillSets: [], skills: [] } }));
    const policy = await f.service.policies.ensure(f.robot, id, { legacy: { skillSets: ['copilot'], skills: [] } });
    assert.deepEqual(policy.selectors, { skillSets: [], skills: [] });
});

test('catalog API agrees on conversation saved cwd, empty selection, active revision and optimistic mutation', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const active = await f.capture(id);
    await write(path.join(f.store.robotPath(f.robot.id), 'copilot/sessions', `${id}.json`), JSON.stringify({ sessionId: id, skillPolicyRef: id,
        engine: { cwd: f.scopeRoot }, skillExecution: { active: true, catalogId: active.catalogId, revision: active.revision, policyVersion: active.policyVersion } }));
    const input = { sessionId: id, dir: '/this-browser-cwd-is-ignored' };
    const before = await skillCatalogRequest({ skillsets: f.service, robot: f.robot, input });
    assert.equal(before.scope, 'conversation');
    assert.equal(before.cwd, f.scopeRoot);
    assert.equal(before.activeRevision.revision, active.revision);
    const after = await skillCatalogRequest({ skillsets: f.service, robot: f.robot, input: { ...input, identity: 'workspace:.agents/skills/local', enabled: false, policyVersion: before.policyVersion }, mutate: true });
    assert.equal(after.skills.find((entry) => entry.name === 'local').enabled, false);
    assert.equal(after.policyVersion, before.policyVersion + 1);
    assert.equal(after.activeRevision.revision, active.revision);
    await assert.rejects(skillCatalogRequest({ skillsets: f.service, robot: f.robot, input: { ...input, identity: 'workspace:.agents/skills/local', enabled: true, policyVersion: before.policyVersion }, mutate: true }), /policy changed/);
    await active.release();
    const idle = await skillCatalogRequest({ skillsets: f.service, robot: f.robot, input });
    assert.equal(idle.activeRevision, null, 'a stale session flag cannot fabricate an active execution');
    assert.equal(idle.lastRevision, active.revision);
});

test('robot defaults remain bounded to their launch scope and new conversations inherit the accepted defaults', async (t) => {
    const f = await fixture(t, { narrow: true });
    await skill(f.scopeRoot, '.agents/skills/local');
    const before = await skillCatalogRequest({ skillsets: f.service, robot: f.robot });
    assert.equal(before.scope, 'defaults');
    assert.equal(before.sessionId, null);
    assert.equal(before.activeRevision, null);
    const disabled = await skillCatalogRequest({ skillsets: f.service, robot: f.robot, mutate: true,
        input: { identity: 'workspace:.agents/skills/local', enabled: false, policyVersion: before.policyVersion } });
    assert.equal(disabled.skills.find((entry) => entry.name === 'local').enabled, false);
    const queued = await f.service.start(f.robot, {}, (_robot, reference) => reference);
    assert.equal((await f.inventory(queued.policyId)).skills.find((entry) => entry.name === 'local').enabled, false);
    const sibling = path.join(f.workspaceRoot, 'sibling');
    await skill(sibling, '.agents/skills/local');
    const otherScope = new RobotSkillsets({ robotStore: f.store, workspaceRoot: f.workspaceRoot, scopeRoot: sibling,
        alaCommand: f.service.alaCommand });
    const independent = await skillCatalogRequest({ skillsets: otherScope, robot: f.robot });
    assert.equal(independent.scopeRoot, sibling);
    assert.equal(independent.skills.find((entry) => entry.name === 'local').enabled, true);
    assert.equal(independent.policyVersion, 1);
});

test('active and pinned catalog leases survive collection; released unreferenced revisions are reclaimed', async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const active = await f.capture(id);
    await fs.writeFile(path.join(source, 'helper.txt'), 'second');
    const newer = await f.capture(id);
    await newer.release();
    await f.service.live.collect(f.robot.id, { maxAgeMs: -1, keep: 0 });
    assert.ok(await fs.stat(active.catalogPath));
    await assert.rejects(fs.stat(newer.catalogPath), { code: 'ENOENT' });
    const { release, ...pinnedCatalog } = active;
    await f.service.policies.update(f.robot.id, id, active.policyVersion, (value) => ({ ...value, mode: 'pinned', pinnedCatalog }));
    await active.release();
    await f.service.live.collect(f.robot.id, { maxAgeMs: -1, keep: 0 });
    assert.ok(await fs.stat(active.catalogPath));
});

test('preparing capture protects published catalogs while hashing outside the registry lock', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const old = await f.capture(id);
    await old.release();
    await fs.writeFile(path.join(source, 'helper.txt'), 'second');
    const entered = deferred(), proceed = deferred();
    const original = f.service.discover.bind(f.service);
    let blocked = false;
    f.service.discover = async (directory) => {
        if (!blocked && directory.includes('/.prepare-')) { blocked = true; entered.resolve(); await proceed.promise; }
        return original(directory);
    };
    const pending = f.capture(id);
    await entered.promise;
    try {
        await f.service.live.collect(f.robot.id, { maxAgeMs: -1, keep: 0 });
        assert.ok(await fs.stat(old.catalogPath), 'preparing lease prevents collection');
        await f.store.withRobot(f.robot.id, async () => true);
    } finally { proceed.resolve(); }
    const next = await pending;
    assert.notEqual(old.revision, next.revision);
});

test('concurrent source edits during copy retry before publication and leave active bytes stable', async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const first = await f.capture(id);
    const original = f.service.discover.bind(f.service);
    let changed = false;
    f.service.discover = async (directory) => {
        if (!changed && directory.includes('/.prepare-')) { changed = true; await fs.writeFile(path.join(source, 'helper.txt'), 'changed-during-copy'); }
        return original(directory);
    };
    const second = await f.capture(id);
    assert.equal(await fs.readFile(path.join(second.catalogPath, 'local/helper.txt'), 'utf8'), 'changed-during-copy');
    assert.equal(await fs.readFile(path.join(first.catalogPath, 'local/helper.txt'), 'utf8'), 'helper-one');
    assert.equal((await fs.readdir(f.service.live.root(f.robot.id))).some((name) => name.startsWith('.prepare-')), false);
});

test('continuously changing source fails after bounded retries and releases unpublished staging and leases', async (t) => {
    const f = await fixture(t);
    const source = await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const original = f.service.discover.bind(f.service);
    let changes = 0;
    f.service.discover = async (directory) => {
        if (directory.includes('/.prepare-')) await fs.writeFile(path.join(source, 'helper.txt'), `capture-edit-${++changes}`);
        return original(directory);
    };
    await assert.rejects(f.capture(id), /changed during capture/);
    assert.ok(changes > 0 && changes <= 3, 'capture attempts are bounded');
    assert.deepEqual(await fs.readdir(f.service.live.root(f.robot.id)), []);
});

test('dead preparing owners permit cleanup of their staging and unreferenced catalogs', async (t) => {
    const f = await fixture(t);
    await skill(f.scopeRoot, '.agents/skills/local');
    const id = await f.policy();
    const captured = await f.capture(id);
    await captured.release();
    const root = f.service.live.root(f.robot.id);
    const orphan = crypto.randomUUID();
    await write(path.join(root, `.prepare-${orphan}/partial.txt`), 'orphaned copy');
    await write(path.join(root, `.lease-${orphan}.json`), JSON.stringify({ policyId: id, catalogId: null, stage: `.prepare-${orphan}`,
        owner: { pid: 1, start: '0', boot: crypto.randomUUID() } }));
    await f.service.live.collect(f.robot.id, { maxAgeMs: -1, keep: 0 });
    assert.deepEqual(await fs.readdir(root), []);
});
