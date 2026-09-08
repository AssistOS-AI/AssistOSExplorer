import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    readAchillesSettings,
    setSelectedModel,
} from '../src/lib/achillesSettings.mjs';
import {
    resolveAchillesPrivateDataRoot,
    resolveAchillesWorkspaceRoot,
} from '../src/lib/privateDataRoot.mjs';

test('Ploinky launch from a workspace subdirectory anchors private state once at workspace .data', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-workspace-'));
    const selectedDirectory = path.join(workspaceRoot, 'projects', 'nested');
    await fsp.mkdir(selectedDirectory, { recursive: true });
    const env = { PLOINKY_WORKSPACE_ROOT: workspaceRoot };

    assert.equal(resolveAchillesWorkspaceRoot(selectedDirectory, env), fs.realpathSync(workspaceRoot));
    assert.equal(
        resolveAchillesPrivateDataRoot(selectedDirectory, { env }),
        path.join(fs.realpathSync(workspaceRoot), '.data', 'achilles-cli'),
    );

    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    try {
        await setSelectedModel(selectedDirectory, 'test/model');
    } finally {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
    }

    assert.equal(fs.existsSync(path.join(workspaceRoot, '.data', 'achilles-cli', 'settings.json')), true);
    assert.equal(fs.existsSync(path.join(selectedDirectory, '.data')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.achilles-cli')), false);
});

test('AchillesCLI rejects a symlinked workspace .data root', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-symlink-workspace-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-symlink-outside-'));
    await fsp.symlink(outside, path.join(workspaceRoot, '.data'));

    assert.throws(
        () => resolveAchillesPrivateDataRoot(workspaceRoot, { env: {} }),
        /Workspace \.data root must be a real directory/,
    );
    assert.equal(fs.existsSync(path.join(outside, 'achilles-cli')), false);
});

test('AchillesCLI rejects a symlinked private data root', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-private-symlink-workspace-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-private-symlink-outside-'));
    await fsp.mkdir(path.join(workspaceRoot, '.data'));
    await fsp.symlink(outside, path.join(workspaceRoot, '.data', 'achilles-cli'));

    assert.throws(
        () => resolveAchillesPrivateDataRoot(workspaceRoot, { env: {} }),
        /AchillesCLI private data root must be a real directory/,
    );
    assert.deepEqual(await fsp.readdir(outside), []);
});

test('settings do not read, migrate, or delete the former storage root', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-hard-cut-workspace-'));
    const formerRoot = path.join(workspaceRoot, '.achilles-cli');
    await fsp.mkdir(formerRoot);
    await fsp.writeFile(path.join(formerRoot, 'settings.json'), '{"model":"former/model"}\n');

    assert.deepEqual(readAchillesSettings(workspaceRoot), {});
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.data')), false);

    await setSelectedModel(workspaceRoot, 'current/model');
    assert.equal(
        JSON.parse(await fsp.readFile(path.join(workspaceRoot, '.data', 'achilles-cli', 'settings.json'), 'utf8')).model,
        'current/model',
    );
    assert.equal(
        JSON.parse(await fsp.readFile(path.join(formerRoot, 'settings.json'), 'utf8')).model,
        'former/model',
    );
});

test('settings reject a symlinked owned settings file before reading or writing', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-settings-link-workspace-'));
    const outside = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'achilles-settings-link-outside-')), 'settings.json');
    await fsp.writeFile(outside, '{"model":"outside/model"}\n');
    await fsp.mkdir(path.join(workspaceRoot, '.data', 'achilles-cli'), { recursive: true });
    await fsp.symlink(outside, path.join(workspaceRoot, '.data', 'achilles-cli', 'settings.json'));

    assert.throws(() => readAchillesSettings(workspaceRoot), /settings file must not be a symbolic link/);
    await assert.rejects(setSelectedModel(workspaceRoot, 'blocked/model'), /settings file must not be a symbolic link/);
    assert.equal(JSON.parse(await fsp.readFile(outside, 'utf8')).model, 'outside/model');
});
