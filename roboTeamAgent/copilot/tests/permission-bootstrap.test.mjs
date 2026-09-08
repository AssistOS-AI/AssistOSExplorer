import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCliOptions, isWebchatRuntime } from '../src/lib/cliOptions.mjs';
import { getPermissionMode, setPermissionMode } from '../src/lib/achillesSettings.mjs';

async function workspace(t) {
    const directory = await mkdtemp(join(tmpdir(), 'achilles-permission-bootstrap-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('CLI restores workspace native permission selection without changing disk during parsing', async (t) => {
    const workingDir = await workspace(t);
    await setPermissionMode(workingDir, 'full-access');
    assert.equal(parseCliOptions(['--dir', workingDir]).permissionMode, 'full-access');
    const overridden = parseCliOptions(['--permissions', 'ask-for-approval', '--dir', workingDir]);
    assert.equal(overridden.permissionMode, 'ask-for-approval');
    assert.equal(overridden.workingDir, workingDir);
    assert.equal(getPermissionMode(workingDir), 'full-access');
});

test('UI option values are not mistaken for single-shot prompts', async (t) => {
    const workingDir = await workspace(t);
    assert.equal(parseCliOptions(['--dir', workingDir, '--ui', 'minimal']).singleShot, false);
    const selected = parseCliOptions(['--dir', workingDir, '--ui=minimal', '/exec', 'bash', 'pwd']);
    assert.equal(selected.prompt, '/exec bash pwd');
    assert.equal(selected.singleShot, true);
});

test('removed tier flags and invalid explicit permission modes fail rather than changing execution', () => {
    assert.throws(() => parseCliOptions(['--fast']), /Unknown option/);
    assert.throws(() => parseCliOptions(['--deep']), /Unknown option/);
    assert.throws(() => parseCliOptions(['--permissions=automatic']), /ask-for-approval/);
    assert.throws(() => parseCliOptions(['--skill-root']), /requires a value/);
});

test('Ploinky WebChat launch metadata does not become a prompt or native session', async (t) => {
    const workingDir = await workspace(t);
    for (const metadata of [
        ['--pageInstanceId=7ed201ae-f4d3-4023-ad21-0e0bfec70f14', '--forward-envelope=1'],
        ['--pageInstanceId', '7ed201ae-f4d3-4023-ad21-0e0bfec70f14', '--forward-envelope', 'true'],
        ['--forward-envelope'],
    ]) {
        const args = [...metadata, `--dir=${workingDir}`, '--sso-user=guest', '--sso-user-id=guest', '--sso-roles=guest'];
        const options = parseCliOptions(args);
        assert.equal(options.workingDir, workingDir);
        assert.equal(options.prompt, null);
        assert.equal(options.singleShot, false);
        assert.equal(options.pageInstanceId, undefined);
        assert.equal(isWebchatRuntime(args, {}), true);
        assert.equal(isWebchatRuntime([...metadata, `--dir=${workingDir}`], { SSO_USER_ID: 'guest' }), true);
    }
});

test('transport metadata remains bounded and does not disable unknown-option validation', () => {
    for (const args of [['--pageInstanceId='], ['--pageInstanceId'], ['--forward-envelope=invalid']]) {
        assert.throws(() => parseCliOptions(args), /requires/);
    }
    assert.throws(() => parseCliOptions(['--pageInstanceId=x', '--unknown']), /Unknown option/);
    assert.equal(parseCliOptions(['--', '--pageInstanceId=x']).prompt, '--pageInstanceId=x');
});
