import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getDisabledSkills, setDisabledSkills } from '../src/lib/achillesSettings.mjs';
import {
    applyPersistedWorkspaceSkillState,
    createWebchatSkillsEnvelope,
    createWorkspaceSkillsSnapshot,
    setWorkspaceDirectoryEnabled,
    setWorkspaceSkillEnabled,
} from '../src/lib/workspaceSkillsState.mjs';
import { SlashCommandHandler } from '../src/repl/SlashCommandHandler.mjs';
import { createCatalogFixture, writeSkill } from './helpers/anthropicCatalogFixture.mjs';

async function createFixture(t) {
    const fixture = await createCatalogFixture(t);
    const { workingDir, builtIns } = fixture;
    writeSkill(workingDir, 'skills/alpha', 'alpha');
    writeSkill(workingDir, 'packages/tools/beta', 'beta');
    writeSkill(builtIns, 'bash', 'bash');
    const catalog = await fixture.createCatalog([{ path: builtIns, builtIn: true }, path.join(workingDir, 'skills'), path.join(workingDir, 'packages')]);
    return { ...fixture, catalog };
}

test('workspace snapshots include packaged Anthropic skills and persist their enablement', async (t) => {
    const { catalog, workingDir } = await createFixture(t);
    const snapshot = await setWorkspaceSkillEnabled(catalog, workingDir, 'bash', false);
    assert.deepEqual(getDisabledSkills(workingDir), ['bash']);
    assert.deepEqual(snapshot, [
        { name: 'bash', displayName: 'bash', relativePath: '../builtins/bash', type: 'anthropic', enabled: false },
        { name: 'beta', displayName: 'beta', relativePath: 'packages/tools/beta', type: 'anthropic', enabled: true },
        { name: 'alpha', displayName: 'alpha', relativePath: 'skills/alpha', type: 'anthropic', enabled: true },
    ]);
    assert.throws(() => catalog.resolveSelectedSkill('bash'), /disabled/);
    await setWorkspaceSkillEnabled(catalog, workingDir, 'bash', true);
    assert.equal(catalog.resolveSelectedSkill('bash').builtIn, true);
});

test('directory toggles are recursive, confined, and retain unrelated disabled names', async (t) => {
    const { catalog, workingDir } = await createFixture(t);
    await setDisabledSkills(workingDir, ['temporarily-absent']);
    await setWorkspaceDirectoryEnabled(catalog, workingDir, 'packages', false);
    assert.equal(catalog.getSkill('alpha').enabled, true);
    assert.equal(catalog.getSkill('beta').enabled, false);
    assert.deepEqual(getDisabledSkills(workingDir), ['beta', 'temporarily-absent']);
    await assert.rejects(setWorkspaceDirectoryEnabled(catalog, workingDir, '../builtins', false), /inside the working directory/);
    await assert.rejects(setWorkspaceDirectoryEnabled(catalog, workingDir, '/tmp', false), /relative workspace directory/);
    assert.equal(catalog.getSkill('bash').enabled, true);
});

test('concurrent enablement changes retain both canonical disabled names', async (t) => {
    const { catalog, workingDir } = await createFixture(t);
    await Promise.all([
        setWorkspaceSkillEnabled(catalog, workingDir, 'alpha', false),
        setWorkspaceSkillEnabled(catalog, workingDir, 'beta', false),
    ]);
    assert.deepEqual(getDisabledSkills(workingDir), ['alpha', 'beta']);
    await catalog.refresh();
    assert.throws(() => catalog.resolveSelectedSkill('alpha'), /disabled/);
    assert.throws(() => catalog.resolveSelectedSkill('beta'), /disabled/);
    assert.equal(catalog.resolveSelectedSkill('bash').enabled, true);
});

test('reload applies persisted enable and disable transitions without mutating earlier snapshots', async (t) => {
    const { catalog, workingDir } = await createFixture(t);
    await setWorkspaceSkillEnabled(catalog, workingDir, 'beta', false);
    const previous = createWorkspaceSkillsSnapshot(catalog, workingDir);
    await setDisabledSkills(workingDir, ['bash']);
    await applyPersistedWorkspaceSkillState(catalog, workingDir);
    assert.equal(catalog.getSkill('beta').enabled, true);
    assert.equal(catalog.getSkill('bash').enabled, false);
    assert.equal(previous.find((skill) => skill.name === 'beta').enabled, false);
    await assert.rejects(setWorkspaceSkillEnabled(catalog, workingDir, 'missing', false), /not found/);
    assert.deepEqual(getDisabledSkills(workingDir), ['bash']);
});

test('slash commands await persisted skill controls and preserve WebChat envelopes', async (t) => {
    const { catalog, workingDir } = await createFixture(t);
    const handler = new SlashCommandHandler({
        getUserSkills: () => catalog.getSkills(),
        getSkills: () => catalog.getSkills(),
        getSkillState: () => createWorkspaceSkillsSnapshot(catalog, workingDir),
        setSkillEnabled: (name, enabled) => setWorkspaceSkillEnabled(catalog, workingDir, name, enabled),
        setSkillsDirectoryEnabled: (directory, enabled) => setWorkspaceDirectoryEnabled(catalog, workingDir, directory, enabled),
    });
    const one = await handler.executeSlashCommand('skill', 'disable bash');
    assert.equal(one.skillStateEvent, 'changed');
    assert.equal(catalog.getSkill('bash').enabled, false);
    const folder = await handler.executeSlashCommand('skills', 'disable packages');
    assert.equal(folder.skillOperation.scope, 'directory');
    assert.equal(catalog.getSkill('beta').enabled, false);
    const list = await handler.executeSlashCommand('skills', '');
    const envelope = createWebchatSkillsEnvelope(list.skillState);
    assert.equal(envelope.__webchatSkills, 1);
    assert.equal(envelope.version, 1);
    assert.deepEqual(envelope.skills.filter((skill) => !skill.enabled).map((skill) => skill.name), ['bash', 'beta']);
});
