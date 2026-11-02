import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAchillesWorkspaceRoot } from '../copilot/src/lib/storage/privateDataRoot.mjs';
import { createLeaseControlFixture, removeLeaseControlFixture, waitForLeaseAcquired } from './helpers/runtime-manager-lease-control.mjs';

test('lease control scratch stays inside the configured workspace and cleanup requires both closed producers', async t => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lease-control-workspace-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const env = { PLOINKY_WORKSPACE_ROOT: workspace };
    const fixture = await createLeaseControlFixture(env);
    assert.equal(path.dirname(fixture.root), workspace);
    assert.equal(resolveAchillesWorkspaceRoot(fixture.root, env), workspace);
    assert.throws(() => resolveAchillesWorkspaceRoot(os.tmpdir(), env), /outside PLOINKY_WORKSPACE_ROOT/);
    await assert.rejects(removeLeaseControlFixture(fixture, [{ closed: true }], env), /both control producers/);
    await assert.rejects(removeLeaseControlFixture(fixture, [{ closed: true }, { closed: false }], env), /must close/);
    await fs.access(fixture.root);
    const changedIdentity = { ...fixture, identity: { ...fixture.identity, ino: fixture.identity.ino + 1 } };
    await assert.rejects(removeLeaseControlFixture(changedIdentity, [{ closed: true }, { closed: true }], env));
    await fs.access(fixture.root);
    await removeLeaseControlFixture(fixture, [{ closed: true }, { closed: true }], env);
    await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
});

test('missing workspace configuration fails before creating a control fixture', async () => {
    await assert.rejects(createLeaseControlFixture({}), /PLOINKY_WORKSPACE_ROOT is required/);
});

for (const [event, payload, code] of [
    ['close', 1, 'LINUX_LEASE_PRODUCER_CLOSED_BEFORE_ACQUIRED'],
    ['error', new Error('private startup diagnostic'), 'LINUX_LEASE_PRODUCER_STARTUP_ERROR'],
    ['message', { type: 'startup-failed', detail: 'private startup diagnostic' }, 'LINUX_LEASE_PRODUCER_STARTUP_FAILED'],
]) {
    test(`producer ${event} before acquisition rejects promptly with a fixed safe code`, async () => {
        const child = new EventEmitter();
        const acquisition = waitForLeaseAcquired(child);
        child.emit(event, payload);
        await assert.rejects(acquisition, error => error.code === code && error.message === code);
        assert.equal(child.listenerCount('message'), 0);
        assert.equal(child.listenerCount('error'), 0);
        assert.equal(child.listenerCount('close'), 0);
    });
}

test('acquired producer resolves once and removes startup listeners', async () => {
    const child = new EventEmitter();
    const acquisition = waitForLeaseAcquired(child);
    child.emit('message', { type: 'acquired' });
    assert.equal(await acquisition, child);
    assert.equal(child.listenerCount('message'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});
