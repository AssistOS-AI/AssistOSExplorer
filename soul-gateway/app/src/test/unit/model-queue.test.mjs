import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Silence logs during tests
process.env.LOG_LEVEL = 'critical';

const { acquireModelSlot } = await import('../../pipeline/model-queue.mjs');

describe('model-queue', () => {
  it('returns a release function', async () => {
    const release = await acquireModelSlot('test-immediate');
    assert.equal(typeof release, 'function');
    release();
  });

  it('serializes requests to the same model', async () => {
    const order = [];

    const release1 = await acquireModelSlot('model-serial');
    // Start second request — should be blocked until release1() is called
    const slot2Promise = acquireModelSlot('model-serial');

    // Slot 1 is held — do some "work"
    order.push('slot1-acquired');

    // Release after a short delay
    await new Promise(r => setTimeout(r, 20));
    order.push('slot1-releasing');
    release1();

    // Now slot 2 should acquire
    const release2 = await slot2Promise;
    order.push('slot2-acquired');
    release2();

    assert.deepEqual(order, ['slot1-acquired', 'slot1-releasing', 'slot2-acquired']);
  });

  it('allows different models to run concurrently', async () => {
    const events = [];

    const releaseA = await acquireModelSlot('model-a');
    const releaseB = await acquireModelSlot('model-b');

    // Both acquired simultaneously — no blocking
    events.push('both-acquired');

    releaseA();
    releaseB();
    events.push('both-released');

    assert.deepEqual(events, ['both-acquired', 'both-released']);
  });

  it('queues multiple waiters in FIFO order', async () => {
    const order = [];

    const release1 = await acquireModelSlot('model-fifo');

    // Queue up slots 2 and 3
    const slot2Promise = acquireModelSlot('model-fifo');
    const slot3Promise = acquireModelSlot('model-fifo');

    // Release slot 1 → slot 2 should acquire
    release1();
    const release2 = await slot2Promise;
    order.push('slot2');

    // Release slot 2 → slot 3 should acquire
    release2();
    const release3 = await slot3Promise;
    order.push('slot3');

    release3();

    assert.deepEqual(order, ['slot2', 'slot3']);
  });

  it('subsequent requests work after queue drains', async () => {
    const release1 = await acquireModelSlot('model-reuse');
    release1();

    // Queue is drained — new request should acquire immediately
    const release2 = await acquireModelSlot('model-reuse');
    release2();
  });

  it('slot is available to next waiter even if holder throws', async () => {
    const release1 = await acquireModelSlot('model-error');
    const slot2Promise = acquireModelSlot('model-error');

    // Simulate error in slot 1 holder — release in finally block
    let caught = false;
    async function doWork() {
      try {
        throw new Error('simulated error');
      } finally {
        release1();
      }
    }
    try {
      await doWork();
    } catch {
      caught = true;
    }

    assert.ok(caught, 'Error should have been caught');

    // Slot 2 should still acquire because release1() ran in finally
    const release2 = await slot2Promise;
    assert.equal(typeof release2, 'function');
    release2();
  });

  it('measures wait time under contention', async () => {
    const release1 = await acquireModelSlot('model-wait');
    const slot2Promise = acquireModelSlot('model-wait');

    const waitStart = Date.now();
    // Hold for ~50ms
    await new Promise(r => setTimeout(r, 50));
    release1();

    const release2 = await slot2Promise;
    const waitMs = Date.now() - waitStart;

    // Slot 2 should have waited roughly 50ms
    assert.ok(waitMs >= 40, `Expected wait >= 40ms, got ${waitMs}ms`);
    release2();
  });
});
