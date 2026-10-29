import assert from 'node:assert/strict';
import test from 'node:test';

import { D2_DECISION } from '../../server/views/d2Decision.mjs';
import {
    DECISION_RECORDS, OPERATIONS, decideOperation, filterDirectoryEntries, scanForProtectedDescendants
} from '../../server/views/operationPolicy.mjs';
import { expandPolicyCases, loadVectors, runPolicyVectors } from './helpers/vectors.mjs';

const vectors = loadVectors('operation-policy.json');
const realDecide = (input, options) => decideOperation(input, options);

// --- Deliberately weakened policies: each must fail the vectors that are meant to catch it. -------------------------

const serveAll = (verdict) => ({ ...verdict, outcome: 'serve', code: 'allowed' });
const WEAKENINGS = [
    {
        name: 'the second rename operand is not checked',
        decide: (input, options) => decideOperation(input.names?.newName === undefined ? input : { ...input, names: { ...input.names, newName: 'harmless' } }, options),
        mustCatch: ['r02:rename', 'r03:rename_exchange', 'r03:rename_whiteout']
    },
    {
        name: 'binding-chain state is ignored',
        decide: (input, options) => decideOperation(input.nodes ? { ...input, nodes: Object.fromEntries(Object.keys(input.nodes).map((role) => [role, 'ok'])) } : input, options),
        mustCatch: ['q11:lookup', 'h02:read', 'h02:write', 'l03:link', 'r11:rename', 'n02:getattr', 'c10:create', 'u07:unlink']
    },
    {
        name: 'unproven bindings are served',
        decide: (input, options) => decideOperation(input.nodes ? { ...input, nodes: Object.fromEntries(Object.entries(input.nodes).map(([role, state]) => [role, state === 'unproven' ? 'ok' : state])) } : input, options),
        mustCatch: ['q12:lookup', 'h03:read', 'h03:readdir', 'n03:open']
    },
    {
        name: 'a protected name is served by lookup',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.outcome === 'absent' && verdict.code === 'protected_name' ? serveAll(verdict) : verdict;
        },
        mustCatch: ['q02:lookup', 'q03:lookup', 'q05:lookup', 'u02:unlink']
    },
    {
        name: 'a protected name is created',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.code === 'protected_operand' ? serveAll(verdict) : verdict;
        },
        mustCatch: ['c02:create', 'c04:mkdir', 'c06:symlink', 'l02:link', 'r02:rename']
    },
    {
        name: 'a protected create is reported absent instead of refused',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.code === 'protected_operand' ? { ...verdict, outcome: 'absent', errnoHint: 'ENOENT' } : verdict;
        },
        mustCatch: ['c02:create', 'r02:rename']
    },
    {
        name: 'lifecycle notifications are refused on a tainted node',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return ['release', 'forget', 'releasedir', 'flush'].includes(input.op) && input.nodes?.subject === 'protected'
                ? { ...verdict, outcome: 'refused', code: 'handle_observed_protected', noDataIo: undefined } : verdict;
        },
        mustCatch: ['k02:release', 'k02:forget']
    },
    {
        name: 'unknown hidden-descendant answers count as none',
        decide: (input, options) => decideOperation(input.op === 'rmdir' || input.movesDirectory
            ? { ...input, hiddenDescendants: input.hiddenDescendants === true ? true : false } : input, options),
        mustCatch: ['u05:rmdir', 'u06:rmdir', 'r08:rename', 'r09:rename_exchange']
    },
    {
        name: 'a link whose source node is tainted is allowed',
        decide: (input, options) => decideOperation(input.op === 'link' ? { ...input, nodes: { ...input.nodes, source: 'ok' } } : input, options),
        mustCatch: ['l03:link', 'l04:link']
    },
    {
        name: 'copy_file_range is served with the report-true-outcome rule (the reviewed leak)',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return input.op === 'copy_file_range' ? { outcome: 'serve', code: 'allowed', errnoHint: null, postCheck: 'report_true_outcome' } : verdict;
        },
        mustCatch: ['h05:copy_file_range', 'h07:copy_file_range', 'h08:copy_file_range', 'h09:copy_file_range']
    },
    {
        name: 'extended attributes are served',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.code === 'xattr_not_reviewed' ? serveAll(verdict) : verdict;
        },
        mustCatch: ['x02:getxattr', 'x04:setxattr']
    },
    {
        name: 'ioctl is passed through',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.code === 'ioctl_not_passed_through' ? serveAll(verdict) : verdict;
        },
        mustCatch: ['x01:ioctl']
    },
    {
        name: 'unknown operations are served',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return verdict.code === 'unknown_operation' ? serveAll(verdict) : verdict;
        },
        mustCatch: ['z01:frobnicate', 'z01:constructor', 'z01:__proto__']
    },
    {
        name: 'a post-read check is not required for reads',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return { ...verdict, postCheck: input.op === 'read' ? null : verdict.postCheck };
        },
        mustCatch: ['h04:read']
    },
    {
        name: 'a write is allowed to be reported as refused (discard policy for writes)',
        decide: (input, options) => {
            const verdict = decideOperation(input, options);
            return input.op === 'write' ? { ...verdict, postCheck: 'discard_data_on_failure' } : verdict;
        },
        mustCatch: ['h06:write']
    }
];

test('the real policy passes every shared operation vector', () => {
    assert.deepEqual(runPolicyVectors(vectors, realDecide), []);
    assert.ok(expandPolicyCases(vectors).length >= 150, 'the vector set expands to a substantial number of cases');
});

test('the vectors name every operation of the table at least once, and every table operation is in the vectors', () => {
    const covered = new Set(expandPolicyCases(vectors).map((entry) => entry.input.op));
    for (const op of Object.keys(OPERATIONS)) assert.ok(covered.has(op), `operation ${op} has no vector`);
    for (const op of covered) assert.ok(Object.hasOwn(OPERATIONS, op) || op === '' || /^(frobnicate|constructor|__proto__|LOOKUP)$/.test(op), `vector op ${op} is unknown`);
});

test('the section 5.4 table rows are all present in the operation table', () => {
    for (const op of ['lookup', 'getattr', 'open', 'readdir', 'readlink', 'access', 'create', 'mkdir', 'mknod', 'tmpfile', 'symlink', 'link',
        'rename', 'rename_exchange', 'rename_whiteout', 'read', 'write', 'mapping_fault', 'ioctl', 'getxattr']) {
        assert.ok(Object.hasOwn(OPERATIONS, op), op);
    }
});

for (const weakening of WEAKENINGS) {
    test(`negative control: the vectors catch a policy where ${weakening.name}`, () => {
        const failures = runPolicyVectors(vectors, weakening.decide);
        for (const id of weakening.mustCatch) assert.ok(failures.includes(id), `${id} must fail (got ${failures.join(',')})`);
    });
}

test('an absent answer is ENOENT and never differs between a protected name and a protected chain', () => {
    const byName = decideOperation({ op: 'lookup', names: { name: '.data' }, nodes: { subject: 'ok' } });
    const byChain = decideOperation({ op: 'lookup', names: { name: 'ordinary' }, nodes: { subject: 'protected' } });
    for (const verdict of [byName, byChain]) {
        assert.equal(verdict.outcome, 'absent');
        assert.equal(verdict.errnoHint, 'ENOENT');
    }
});

test('the policy has no input for existence, so a protected create cannot be an existence oracle', () => {
    assert.throws(() => decideOperation({ op: 'create', names: { name: '.env' }, nodes: { subject: 'ok' }, exists: true }), TypeError);
    const one = decideOperation({ op: 'create', names: { name: '.env' }, nodes: { subject: 'ok' } });
    const two = decideOperation({ op: 'create', names: { name: '.env' }, nodes: { subject: 'ok' } });
    assert.deepEqual(one, two);
    assert.equal(one.outcome, 'refused');
});

test('unknown input keys and malformed inputs are programming errors or refusals, never an allow', () => {
    assert.throws(() => decideOperation({ op: 'lookup', surprise: 1 }), TypeError);
    assert.throws(() => decideOperation(null), TypeError);
    assert.throws(() => decideOperation([]), TypeError);
    for (const input of [
        { op: 'lookup', names: { name: 'a', extra: 'b' }, nodes: { subject: 'ok' } },
        { op: 'lookup', names: { name: 'a' }, nodes: { subject: 'ok', extra: 'ok' } },
        { op: 'lookup', names: { name: 'a' }, nodes: { subject: 'fine' } },
        { op: 'lookup', names: 'a', nodes: { subject: 'ok' } }
    ]) {
        assert.equal(decideOperation(input).outcome, 'refused', JSON.stringify(input));
    }
});

test('the hardening option changes the answer for a default-ignorable spelling and nothing else', () => {
    const input = { op: 'create', names: { name: '.e‌nv' }, nodes: { subject: 'ok' } };
    assert.equal(decideOperation(input).outcome, 'refused');
    assert.equal(decideOperation(input, { hardening: false }).outcome, 'serve');
});

test('the component byte bound is applied to operand names', () => {
    const input = { op: 'lookup', names: { name: 'x'.repeat(300) }, nodes: { subject: 'ok' } };
    assert.equal(decideOperation(input).code, 'invalid_name');
    assert.equal(decideOperation({ ...input, names: { name: 'x'.repeat(10) } }, { maxComponentBytes: 5 }).code, 'invalid_name');
});

test('directory listings omit protected names and keep ordinary ones, including synthetic dot entries', () => {
    const listing = filterDirectoryEntries(['.', '..', 'src', '.data', '.ENV.', 'x.secrets', '.roboteam', '.env.swp', 'README.md', '.e‌nv']);
    assert.deepEqual([...listing.visible], ['.', '..', 'src', '.env.swp', 'README.md']);
    assert.equal(listing.omitted, 5);
    assert.deepEqual([...filterDirectoryEntries(['.e‌nv'], { hardening: false }).visible], ['.e‌nv']);
});

test('the hidden-descendant scan: finds nested protected entries, refuses on budget or listing failure, and clears a clean tree', () => {
    const tree = {
        '': [{ name: 'a', isDirectory: true }, { name: 'f.txt', isDirectory: false }],
        a: [{ name: 'b', isDirectory: true }],
        'a/b': [{ name: 'deep', isDirectory: true }],
        'a/b/deep': [{ name: 'ok.txt', isDirectory: false }]
    };
    const listFor = (shape) => (ref) => (shape[ref.join('/')] ?? []).map((child) => ({ ...child, ref: [...ref, child.name] }));
    assert.equal(scanForProtectedDescendants({ root: [], list: listFor(tree), maxEntries: 100 }), false);
    const withHidden = { ...tree, 'a/b/deep': [{ name: '.ENV.', isDirectory: false }] };
    assert.equal(scanForProtectedDescendants({ root: [], list: listFor(withHidden), maxEntries: 100 }), true);
    assert.equal(scanForProtectedDescendants({ root: [], list: listFor(tree), maxEntries: 3 }), 'unknown');
    assert.equal(scanForProtectedDescendants({ root: [], list: () => { throw new Error('EIO'); }, maxEntries: 100 }), 'unknown');
    assert.equal(scanForProtectedDescendants({ root: [], list: listFor({ '': [{ name: 'x.secrets', isDirectory: false }] }), maxEntries: 100 }), true);
});

test('decision records state R4-5 as the decided D-S5-10 refusal and keep the symlink-target question open', () => {
    const records = new Map(DECISION_RECORDS.map((record) => [record.id, record]));
    assert.equal(records.get('DR-1').status, 'decided');
    assert.equal(records.get('DR-1').decision, 'D-S5-10');
    assert.match(records.get('DR-1').text, /refused when\s+the directory has a protected descendant/);
    assert.match(records.get('DR-1').text, /still reveals that a hidden entry exists/);
    assert.match(records.get('DR-1').text, /both sides/i);
    assert.match(records.get('DR-1').text, /not atomic/);
    assert.match(records.get('DR-1').text, /G6/);
    assert.equal(records.get('DR-6').status, 'question');
    for (const record of DECISION_RECORDS) assert.ok(['table', 'decided', 'proposed', 'question'].includes(record.status), record.id);
});

test('D2 is an explicit decided marker for option (a), deeply frozen, with its residuals and non-claims', () => {
    assert.equal(D2_DECISION.gate, 'D2');
    assert.equal(D2_DECISION.decided, true);
    assert.equal(D2_DECISION.option, 'a');
    assert.equal(D2_DECISION.proof, 'G6');
    assert.ok(Object.isFrozen(D2_DECISION));
    for (const key of ['semantics', 'residuals', 'forbidden', 'notClaimed', 'retained']) assert.ok(Object.isFrozen(D2_DECISION[key]), key);
    assert.throws(() => { 'use strict'; D2_DECISION.residuals.push('x'); }, TypeError);
    assert.ok(D2_DECISION.notClaimed.includes('atomic exclusion'));
    assert.ok(D2_DECISION.notClaimed.includes('instantaneous revocation'));
    assert.ok(D2_DECISION.forbidden.includes('FUSE_DIRECT_IO_ALLOW_MMAP') && D2_DECISION.forbidden.includes('FUSE_DIRECT_IO_RELAX'));
    // Review finding 3, accepted by the coordinator (message 8f3de067): the forced-termination residual is stated next to
    // the residuals of the decision, with the outcome UNKNOWN and no replay, rollback or durability claim.
    assert.ok(D2_DECISION.residuals.some((line) => /^Forced termination or server loss can leave some or all effects in place/.test(line)
        && /UNKNOWN; an error is not proof of no mutation\.$/.test(line)));
    assert.equal(D2_DECISION.residuals.some((line) => /reported failed/.test(line)), false, 'the superseded wording is gone');
    assert.ok(D2_DECISION.semantics.some((line) => /completed SIGTERM drain.*including partial writes/.test(line)));
    for (const claim of ['automatic replay based on assumed non-effect', 'rollback', 'new durability guarantee']) assert.ok(D2_DECISION.notClaimed.includes(claim), claim);
    assert.deepEqual([...D2_DECISION.retained], ['bounded teardown', 'refusal of new operations', 'read checks', 'verified quarantine']);
    // A mapping fault is only a read to the policy: refused after an observed protected name, served otherwise.
    assert.equal(decideOperation({ op: 'mapping_fault', nodes: { subject: 'protected' } }).code, 'handle_observed_protected');
    assert.equal(decideOperation({ op: 'mapping_fault', nodes: { subject: 'ok' } }).outcome, 'serve');
});

test('no operation that carries a source node can serve with a post-check that reports instead of discarding', () => {
    // Structural invariant behind DR-7: bytes of a second node may only move through the checked read path.
    for (const [name, spec] of Object.entries(OPERATIONS)) {
        if (spec.nodes.includes('source') && spec.kind === 'handle') assert.fail(`${name} serves a handle operation with a source node`);
    }
    const reporting = Object.entries(OPERATIONS).filter(([, spec]) => spec.postCheck === 'report_true_outcome').map(([name]) => name).sort();
    assert.deepEqual(reporting, ['fallocate', 'setattr', 'write']);
    const discarding = Object.entries(OPERATIONS).filter(([, spec]) => spec.postCheck === 'discard_data_on_failure').map(([name]) => name).sort();
    assert.deepEqual(discarding, ['mapping_fault', 'read', 'readdir', 'readdirplus', 'readlink']);
});

test('copy_file_range is refused whatever the node states, with an ENOSYS hint so the kernel falls back to read and write', () => {
    for (const nodes of [{ subject: 'ok', source: 'ok' }, { subject: 'protected', source: 'ok' }, { subject: 'unproven', source: 'protected' }, {}]) {
        const verdict = decideOperation({ op: 'copy_file_range', nodes });
        assert.equal(verdict.outcome, 'refused');
        assert.equal(verdict.code, 'copy_file_range_not_supported');
        assert.equal(verdict.errnoHint, 'ENOSYS');
    }
    assert.ok(DECISION_RECORDS.some((record) => record.id === 'DR-7' && /copy_file_range is refused/.test(record.text)));
});
