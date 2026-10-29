import assert from 'node:assert/strict';
import test from 'node:test';

import { CAP_REFUSAL, createDescriptorLedger, descriptorCapProblem } from '../../server/views/descriptorLedger.mjs';
import { resolveViewLimits, VIEW_LIMIT_DEFAULTS } from '../../server/views/viewLimits.mjs';

test('the ledger counts, refuses explicitly at the cap, and a refusal changes nothing', () => {
    const ledger = createDescriptorLedger({ cap: 2 });
    const first = ledger.acquire('node');
    const second = ledger.acquire('file-handle');
    assert.equal(first.ok && second.ok, true);
    const refusal = ledger.acquire('node');
    assert.deepEqual(refusal, CAP_REFUSAL);
    assert.equal(refusal.errnoHint, 'EMFILE');
    assert.equal(ledger.inUse(), 2, 'the refusal evicted nothing');
    assert.deepEqual(ledger.kinds(), { node: 1, 'file-handle': 1 });
    assert.deepEqual(ledger.stats(), { cap: 2, inUse: 2, peak: 2, refusals: 1 });
    ledger.release(first.token);
    assert.equal(ledger.acquire('node').ok, true, 'a release makes room');
    assert.equal(ledger.stats().peak, 2);
});

test('the peak is the high-water mark and survives releases', () => {
    const ledger = createDescriptorLedger({ cap: 10 });
    const tokens = Array.from({ length: 7 }, () => ledger.acquire('node').token);
    for (const token of tokens) ledger.release(token);
    assert.equal(ledger.inUse(), 0);
    assert.equal(ledger.stats().peak, 7);
});

test('releasing twice or releasing an unknown token is an error, not a silent no-op', () => {
    const ledger = createDescriptorLedger({ cap: 2 });
    const { token } = ledger.acquire('node');
    ledger.release(token);
    assert.throws(() => ledger.release(token));
    assert.throws(() => ledger.release(999));
});

test('a verification that needs a transient descriptor refuses at the cap and never fails open; the descriptor is released on every path', () => {
    const ledger = createDescriptorLedger({ cap: 1 });
    let ran = 0;
    const ok = ledger.withTransient('verify', () => { ran += 1; return 'checked'; });
    assert.deepEqual(ok, { ok: true, value: 'checked' });
    assert.equal(ledger.inUse(), 0);
    assert.throws(() => ledger.withTransient('verify', () => { throw new Error('boom'); }), /boom/);
    assert.equal(ledger.inUse(), 0, 'released although the work threw');
    const held = ledger.acquire('node');
    const refused = ledger.withTransient('verify', () => { ran += 1; return 'must not run'; });
    assert.deepEqual(refused, CAP_REFUSAL);
    assert.equal(ran, 1, 'the work did not run without a descriptor');
    ledger.release(held.token);
});

test('invalid caps and kinds are rejected', () => {
    for (const cap of [0, -1, 1.5, '3', undefined, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createDescriptorLedger({ cap }), TypeError);
    assert.throws(() => createDescriptorLedger({ cap: 1 }).acquire(''), TypeError);
});

test('the cap must sit below RLIMIT_NOFILE with the inherited descriptors and a margin', () => {
    const { descriptorCap, fileServerInheritedDescriptors, rlimitHeadroom } = VIEW_LIMIT_DEFAULTS;
    const minimum = descriptorCap + fileServerInheritedDescriptors + rlimitHeadroom;
    assert.equal(descriptorCapProblem({ cap: descriptorCap, rlimitNofile: minimum }), null);
    assert.equal(descriptorCapProblem({ cap: descriptorCap, rlimitNofile: minimum - 1 }), 'cap_not_below_rlimit');
    assert.equal(descriptorCapProblem({ cap: 0, rlimitNofile: 4096 }), 'cap_not_positive');
    assert.equal(descriptorCapProblem({ cap: 10, rlimitNofile: -1 }), 'rlimit_not_positive');
    assert.equal(descriptorCapProblem({ cap: 10, rlimitNofile: 80 }, { rlimitHeadroom: 100 }), 'cap_not_below_rlimit');
});

test('limits are named, positive integers, provisional, and unknown names are rejected', () => {
    assert.ok(Object.isFrozen(resolveViewLimits()));
    assert.equal(resolveViewLimits({ descriptorCap: 5 }).descriptorCap, 5);
    assert.throws(() => resolveViewLimits({ descriptorCapp: 5 }), /Unknown limit/);
    for (const value of [0, -3, 2.5, '7', null, NaN]) assert.throws(() => resolveViewLimits({ descriptorCap: value }), TypeError);
    assert.throws(() => resolveViewLimits(null), TypeError);
    assert.throws(() => resolveViewLimits([]), TypeError);
});
