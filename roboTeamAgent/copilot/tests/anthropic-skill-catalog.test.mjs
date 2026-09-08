import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { setDisabledSkills } from '../src/lib/achillesSettings.mjs';
import { createCatalogFixture, writeSkill } from './helpers/anthropicCatalogFixture.mjs';

 test('later roots override packaged skills while turn snapshots retain their selection', async (t) => {
    const { workingDir, builtIns, createCatalog } = await createCatalogFixture(t);
    writeSkill(builtIns, 'bash', 'bash', 'Packaged command execution.');
    const externalRoot = path.join(workingDir, 'skills');
    const selected = writeSkill(externalRoot, 'custom-bash', 'bash', 'Workspace command execution.');
    writeSkill(externalRoot, 'research', 'research');
    const catalog = await createCatalog([{ path: builtIns, builtIn: true }, externalRoot]);
    const turn = await catalog.refresh();
    assert.equal(catalog.getSkill('bash').skillDir, selected);
    assert.equal(catalog.getSkill('bash').builtIn, false);
    assert.equal(catalog.getSkill('bash').description, 'Workspace command execution.');
    assert.equal(catalog.resolveSelectedSkill('bash').type, 'anthropic');
    assert.deepEqual(turn.taskRepositories, [selected, path.join(externalRoot, 'research')]);

    await setDisabledSkills(workingDir, ['bash']);
    const nextTurn = await catalog.refresh();
    assert.deepEqual(nextTurn.taskRepositories, [path.join(externalRoot, 'research')]);
    assert.equal(turn.skills.find((skill) => skill.name === 'bash').enabled, true);
    assert.throws(() => catalog.resolveSelectedSkill('bash'), /disabled/);
    assert.throws(() => catalog.resolveSelectedSkill('missing'), /not found/);
    assert.match(await catalog.readSkill('bash'), /Workspace command execution/);
    assert.equal(fs.existsSync(path.join(selected, 'SKILL.md')), true);
});

test('ALA rejects duplicate names within a root, reserved names and malformed descriptors', async (t) => {
    const { workingDir, createCatalog } = await createCatalogFixture(t);
    const duplicateRoot = path.join(workingDir, 'duplicates');
    writeSkill(duplicateRoot, 'one', 'same-name');
    writeSkill(duplicateRoot, 'two', 'same-name');
    await assert.rejects(createCatalog([duplicateRoot]), /Duplicate task-skill name/);
    const reservedRoot = path.join(workingDir, 'reserved');
    writeSkill(reservedRoot, 'coding-agent', 'coding-agent');
    await assert.rejects(createCatalog([reservedRoot]), /reserved.*coding-agent/);
    const malformedRoot = path.join(workingDir, 'malformed');
    writeSkill(malformedRoot, 'bad', 'bad', '');
    await assert.rejects(createCatalog([malformedRoot]), /descriptor must define/);
});

test('removing an external override reveals the protected packaged definition on refresh', async (t) => {
    const { workingDir, builtIns, createCatalog } = await createCatalogFixture(t);
    const packaged = writeSkill(builtIns, 'bash', 'bash');
    const externalRoot = path.join(workingDir, 'skills');
    const external = writeSkill(externalRoot, 'bash', 'bash');
    writeSkill(externalRoot, 'other', 'other');
    const catalog = await createCatalog([{ path: builtIns, builtIn: true }, externalRoot]);
    await catalog.removeSkill('bash');
    assert.equal(fs.existsSync(external), false);
    await catalog.refresh();
    assert.equal(catalog.getSkill('bash').skillDir, packaged);
    await assert.rejects(catalog.removeSkill('bash'), /Built-in.*disable it instead/);
    assert.equal(fs.existsSync(path.join(packaged, 'SKILL.md')), true);
    await assert.rejects(catalog.removeSkill('../other'), /not found/);
    assert.equal(fs.existsSync(path.join(externalRoot, 'other', 'SKILL.md')), true);
});

test('symlinked roots and post-discovery path escapes cannot read or delete outside content', async (t) => {
    const { workingDir, directory, createCatalog } = await createCatalogFixture(t);
    const outside = writeSkill(directory, 'outside', 'outside');
    const linkedRoot = path.join(workingDir, 'linked');
    fs.symlinkSync(outside, linkedRoot, 'dir');
    await assert.rejects(createCatalog([linkedRoot]), /symbolic links/);
    const root = path.join(workingDir, 'skills');
    const skillDir = writeSkill(root, 'safe', 'safe');
    const catalog = await createCatalog([root]);
    fs.rmSync(skillDir, { recursive: true });
    fs.symlinkSync(outside, skillDir, 'dir');
    await assert.rejects(catalog.readSkill('safe'), /symbolic links/);
    await assert.rejects(catalog.removeSkill('safe'), /symbolic links/);
    assert.throws(() => catalog.resolveSelectedSkill('safe'), /symbolic links/);
    assert.match(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), /name: outside/);
});

test('descriptor replacement by a symlink and managed repository escapes are refused', async (t) => {
    const { workingDir, directory, createCatalog } = await createCatalogFixture(t);
    const outside = writeSkill(directory, 'outside', 'outside');
    const root = path.join(workingDir, 'skills');
    const skillDir = writeSkill(root, 'safe', 'safe');
    const catalog = await createCatalog([root]);
    fs.unlinkSync(path.join(skillDir, 'SKILL.md'));
    fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
    await assert.rejects(catalog.readSkill('safe'), /symbolic links/);
    const privateRoot = path.join(workingDir, '.data', 'achilles-cli');
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(privateRoot, 'repos'), 'dir');
    await assert.rejects(createCatalog([path.join(privateRoot, 'repos')]), /symbolic link/);
});

test('skill removal refuses a descriptor whose directory owns the workspace', async (t) => {
    const { workingDir, createCatalog } = await createCatalogFixture(t);
    writeSkill(workingDir, '.', 'workspace-task');
    fs.writeFileSync(path.join(workingDir, 'project.txt'), 'Keep project data.');
    const catalog = await createCatalog([workingDir]);
    await assert.rejects(catalog.removeSkill('workspace-task'), /contains workspace data/);
    assert.equal(fs.readFileSync(path.join(workingDir, 'project.txt'), 'utf8'), 'Keep project data.');
});

test('enabled parents cannot expose nested disabled or overridden skill descriptors', async (t) => {
    const { workingDir, createCatalog } = await createCatalogFixture(t);
    const root = path.join(workingDir, 'skills');
    writeSkill(root, 'parent', 'parent');
    const child = writeSkill(root, 'parent/nested', 'child');
    await setDisabledSkills(workingDir, ['child']);
    await assert.rejects(createCatalog([root]), /Enabled skill "parent".*nested descriptor.*sibling folders/);

    await setDisabledSkills(workingDir, ['parent']);
    const catalog = await createCatalog([root]);
    assert.deepEqual(catalog.getEnabledSkillDirectories(), [child]);
    assert.equal(catalog.resolveSelectedSkill('child').filePath, path.join(child, 'SKILL.md'));
    assert.throws(() => catalog.resolveSelectedSkill('parent'), /disabled/);

    const overrideRoot = path.join(workingDir, 'overrides');
    writeSkill(overrideRoot, 'child', 'child');
    await setDisabledSkills(workingDir, []);
    await assert.rejects(createCatalog([root, overrideRoot]), /Enabled skill "parent".*nested descriptor/);
    assert.equal(fs.existsSync(path.join(child, 'SKILL.md')), true);
});
