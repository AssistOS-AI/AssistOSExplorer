import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLeaseControlFixture, waitForLeaseAcquired } from './helpers/runtime-manager-lease-control.mjs';

// One failing control for the lease control helper: it must be able to fail.
test('missing workspace configuration fails before creating a control fixture', async () => {
    await assert.rejects(createLeaseControlFixture({}), /PLOINKY_WORKSPACE_ROOT is required/);
});

test('a producer that closes before acquisition rejects with a fixed safe code', async () => {
    const child = new EventEmitter();
    const acquisition = waitForLeaseAcquired(child);
    child.emit('close', 1);
    await assert.rejects(acquisition, error => error.code === 'LINUX_LEASE_PRODUCER_CLOSED_BEFORE_ACQUIRED');
});
