import assert from 'node:assert/strict';
import test from 'node:test';

import { D2_DECISION } from '../../server/views/d2Decision.mjs';
import { FUSE_VIEW_SETTINGS, findSettingsViolations } from '../../server/views/fuseSettings.mjs';

// A construction sample that meets the specification: what the Rust glue is expected to produce.
function goodSample() {
    return {
        init: { capabilities: ['FUSE_ASYNC_READ', 'FUSE_ATOMIC_O_TRUNC', 'FUSE_DO_READDIRPLUS', 'FUSE_PARALLEL_DIROPS'] },
        entryReplies: [
            { entryValid: { secs: 0, nsecs: 0 }, attrValid: { secs: 1, nsecs: 0 } },
            { entryValid: { secs: 0, nsecs: 0 }, attrValid: { secs: 0, nsecs: 0 } }
        ],
        negativeLookupReplies: [
            { kind: 'error', errno: 'ENOENT' },
            { kind: 'entry', nodeId: 0, entryValid: { secs: 0, nsecs: 0 } }
        ],
        readdirplusEntries: [{ entryValid: { secs: 0, nsecs: 0 } }],
        openReplies: [{ openFlags: ['FOPEN_DIRECT_IO'] }, { openFlags: ['FOPEN_DIRECT_IO', 'FOPEN_PARALLEL_DIRECT_WRITES'] }],
        opendirReplies: [{ openFlags: [] }],
        readReplies: [{ delivery: 'copy' }],
        mountOptions: ['allow_other', 'nosuid'],
        grantAccess: 'write'
    };
}

const codes = (violations) => violations.map((violation) => violation.code).sort();

test('a sample that meets the specification has no violation', () => {
    assert.deepEqual(findSettingsViolations(goodSample()), []);
    const readOnly = { ...goodSample(), grantAccess: 'read', mountOptions: ['allow_other', 'ro'] };
    assert.deepEqual(findSettingsViolations(readOnly), []);
});

test('the specification states the review R4-6 settings and is deeply frozen', () => {
    assert.deepEqual(FUSE_VIEW_SETTINGS.entry.entryValid, { secs: 0, nsecs: 0 });
    assert.deepEqual(FUSE_VIEW_SETTINGS.open.requiredFlags, ['FOPEN_DIRECT_IO']);
    for (const flag of ['FOPEN_KEEP_CACHE', 'FOPEN_CACHE_DIR']) assert.ok(FUSE_VIEW_SETTINGS.open.forbiddenFlags.includes(flag), flag);
    for (const capability of ['FUSE_WRITEBACK_CACHE', 'FUSE_PASSTHROUGH', 'FUSE_CACHE_SYMLINKS', 'FUSE_NO_OPEN_SUPPORT',
        'FUSE_NO_OPENDIR_SUPPORT', 'FUSE_AUTO_INVAL_DATA', 'FUSE_READDIRPLUS_AUTO', 'FUSE_SPLICE_READ', 'FUSE_SPLICE_WRITE', 'FUSE_SPLICE_MOVE',
        'FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_DIRECT_IO_RELAX']) {
        assert.ok(FUSE_VIEW_SETTINGS.init.forbiddenCapabilities.includes(capability), capability);
    }
    assert.deepEqual(Object.keys(FUSE_VIEW_SETTINGS.init).sort(), ['forbiddenCapabilities', 'permittedCapabilities'], 'no pending category is left');
    assert.equal(FUSE_VIEW_SETTINGS.d2, D2_DECISION);
    assert.equal(FUSE_VIEW_SETTINGS.d2.decided, true);
    assert.equal(FUSE_VIEW_SETTINGS.read.delivery, 'copy');
    assert.ok(Object.isFrozen(FUSE_VIEW_SETTINGS) && Object.isFrozen(FUSE_VIEW_SETTINGS.init.forbiddenCapabilities));
    assert.throws(() => { 'use strict'; FUSE_VIEW_SETTINGS.entry.entryValid.secs = 5; }, TypeError);
    assert.equal(JSON.stringify(FUSE_VIEW_SETTINGS).match(/\b0x[0-9a-f]+\b/i), null, 'no numeric bit values are recorded');
});

const NEGATIVE_SAMPLES = [
    ['an entry lifetime of one millisecond', (s) => { s.entryReplies[0].entryValid = { secs: 0, nsecs: 1_000_000 }; }, ['entry_ttl_nonzero']],
    ['an entry lifetime of one second', (s) => { s.entryReplies[1].entryValid = { secs: 1, nsecs: 0 }; }, ['entry_ttl_nonzero']],
    ['a malformed entry lifetime', (s) => { s.entryReplies[0].entryValid = { secs: -1, nsecs: 0 }; }, ['entry_ttl_malformed']],
    ['a missing entry lifetime', (s) => { delete s.entryReplies[0].entryValid; }, ['entry_ttl_malformed']],
    ['a cached negative entry', (s) => { s.negativeLookupReplies[1].entryValid = { secs: 1, nsecs: 0 }; }, ['negative_entry_cached']],
    ['a negative entry with a tiny lifetime', (s) => { s.negativeLookupReplies[1].entryValid = { secs: 0, nsecs: 1 }; }, ['negative_entry_cached']],
    ['a negative lookup answered with another error', (s) => { s.negativeLookupReplies[0] = { kind: 'error', errno: 'EACCES' }; }, ['negative_lookup_malformed']],
    ['a readdirplus entry with a lifetime', (s) => { s.readdirplusEntries[0].entryValid = { secs: 0, nsecs: 5 }; }, ['readdirplus_ttl_nonzero']],
    ['readdirplus enabled without evidence for its entries', (s) => { delete s.readdirplusEntries; }, ['missing_evidence']],
    ['FOPEN_KEEP_CACHE on an open', (s) => { s.openReplies[0].openFlags.push('FOPEN_KEEP_CACHE'); }, ['forbidden_open_flag']],
    ['FOPEN_CACHE_DIR on an open', (s) => { s.openReplies[1].openFlags.push('FOPEN_CACHE_DIR'); }, ['forbidden_open_flag']],
    ['FOPEN_PASSTHROUGH on an open', (s) => { s.openReplies[1].openFlags.push('FOPEN_PASSTHROUGH'); }, ['forbidden_open_flag']],
    ['a missing FOPEN_DIRECT_IO', (s) => { s.openReplies[1].openFlags = []; }, ['open_direct_io_missing']],
    ['FOPEN_CACHE_DIR on an opendir', (s) => { s.opendirReplies[0].openFlags.push('FOPEN_CACHE_DIR'); }, ['forbidden_opendir_flag']],
    ['the writeback cache capability', (s) => { s.init.capabilities.push('FUSE_WRITEBACK_CACHE'); }, ['forbidden_init_capability']],
    ['the passthrough capability', (s) => { s.init.capabilities.push('FUSE_PASSTHROUGH'); }, ['forbidden_init_capability']],
    ['the cache-symlinks capability', (s) => { s.init.capabilities.push('FUSE_CACHE_SYMLINKS'); }, ['forbidden_init_capability']],
    ['no-open support', (s) => { s.init.capabilities.push('FUSE_NO_OPEN_SUPPORT'); }, ['forbidden_init_capability']],
    ['no-opendir support', (s) => { s.init.capabilities.push('FUSE_NO_OPENDIR_SUPPORT'); }, ['forbidden_init_capability']],
    ['auto data invalidation', (s) => { s.init.capabilities.push('FUSE_AUTO_INVAL_DATA'); }, ['forbidden_init_capability']],
    ['automatic readdirplus', (s) => { s.init.capabilities.push('FUSE_READDIRPLUS_AUTO'); }, ['forbidden_init_capability']],
    ['splice read', (s) => { s.init.capabilities.push('FUSE_SPLICE_READ'); }, ['forbidden_init_capability']],
    ['splice write and move', (s) => { s.init.capabilities.push('FUSE_SPLICE_WRITE', 'FUSE_SPLICE_MOVE'); }, ['forbidden_init_capability', 'forbidden_init_capability']],
    ['the older name of the direct-I/O mapping opt-in (decision D2 (a))', (s) => { s.init.capabilities.push('FUSE_DIRECT_IO_RELAX'); }, ['forbidden_init_capability']],
    ['a capability that no review has seen', (s) => { s.init.capabilities.push('FUSE_SOMETHING_NEW'); }, ['unreviewed_init_capability']],
    ['a misspelt forbidden capability', (s) => { s.init.capabilities.push('FUSE_WRITEBACK_CACHES'); }, ['unreviewed_init_capability']],
    ['direct-I/O mapping (decision D2 (a))', (s) => { s.init.capabilities.push('FUSE_DIRECT_IO_ALLOW_MMAP'); }, ['forbidden_init_capability']],
    ['a spliced read reply', (s) => { s.readReplies.push({ delivery: 'splice' }); }, ['data_delivery_not_copy']],
    ['a zero-copy read reply', (s) => { s.readReplies[0].delivery = 'zero_copy'; }, ['data_delivery_not_copy']],
    ['a mount without allow_other', (s) => { s.mountOptions = ['nosuid']; }, ['mount_option_missing']],
    ['a read-only grant mounted read-write', (s) => { s.grantAccess = 'read'; }, ['read_only_grant_not_ro']],
    ['an unknown grant access', (s) => { s.grantAccess = 'admin'; }, ['grant_access_malformed']],
    ['no entry replies at all', (s) => { s.entryReplies = []; }, ['missing_evidence']],
    ['no open replies at all', (s) => { delete s.openReplies; }, ['missing_evidence']],
    ['no INIT capabilities evidence', (s) => { delete s.init; }, ['missing_evidence']]
];

for (const [label, mutate, expected] of NEGATIVE_SAMPLES) {
    test(`negative sample: ${label}`, () => {
        const sample = goodSample();
        mutate(sample);
        assert.deepEqual(codes(findSettingsViolations(sample)), [...expected].sort());
    });
}

test('negative control: a specification with an emptied forbidden list lets the same bad samples through', () => {
    // The two mmap opt-ins are removed from forbiddenCapabilities by emptying it, and added to the allowlist, because the
    // allowlist alone would otherwise still catch them as unreviewed (review nit N3).
    const weakened = structuredClone(FUSE_VIEW_SETTINGS);
    weakened.init.forbiddenCapabilities = [];
    weakened.open.forbiddenFlags = [];
    weakened.init.permittedCapabilities.push('FUSE_WRITEBACK_CACHE', 'FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_DIRECT_IO_RELAX');
    const sample = goodSample();
    sample.init.capabilities.push('FUSE_WRITEBACK_CACHE', 'FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_DIRECT_IO_RELAX');
    sample.openReplies[0].openFlags.push('FOPEN_KEEP_CACHE');
    assert.deepEqual(findSettingsViolations(sample, weakened), [], 'the weakened specification misses all four');
    assert.deepEqual(codes(findSettingsViolations(sample)),
        ['forbidden_init_capability', 'forbidden_init_capability', 'forbidden_init_capability', 'forbidden_open_flag'],
        'the real specification reports all four');
});

test('a malformed sample is reported, not accepted', () => {
    for (const sample of [null, undefined, 5, 'x', []]) assert.deepEqual(codes(findSettingsViolations(sample)), ['sample_malformed']);
    assert.ok(findSettingsViolations({}).length >= 5, 'an empty sample has no evidence for any section');
});

test('the INIT capabilities are an allowlist: no permitted name is forbidden, and the good sample passes it', () => {
    const { permittedCapabilities, forbiddenCapabilities } = FUSE_VIEW_SETTINGS.init;
    for (const name of permittedCapabilities) {
        assert.equal(forbiddenCapabilities.includes(name), false, name);
    }
    assert.ok(forbiddenCapabilities.includes('FUSE_DIRECT_IO_RELAX'));
    for (const name of permittedCapabilities) {
        const sample = goodSample();
        sample.init.capabilities = [name];
        assert.deepEqual(findSettingsViolations(sample).filter((violation) => violation.code === 'unreviewed_init_capability'), [], name);
    }
});

test('negative control: a specification without an allowlist is reported incomplete, and one that lists a new name accepts it', () => {
    const incomplete = structuredClone(FUSE_VIEW_SETTINGS);
    delete incomplete.init.permittedCapabilities;
    assert.ok(findSettingsViolations(goodSample(), incomplete).some((violation) => violation.code === 'spec_incomplete'));
    const widened = structuredClone(FUSE_VIEW_SETTINGS);
    widened.init.permittedCapabilities.push('FUSE_SOMETHING_NEW');
    const sample = goodSample();
    sample.init.capabilities.push('FUSE_SOMETHING_NEW');
    assert.deepEqual(findSettingsViolations(sample, widened), []);
    assert.deepEqual(codes(findSettingsViolations(sample)), ['unreviewed_init_capability']);
});

test('decision D2 (a): every kernel opt-in that the decision forbids is a forbidden INIT capability here', () => {
    const named = D2_DECISION.forbidden.filter((entry) => /^FUSE_[A-Z0-9_]+$/.test(entry));
    assert.deepEqual(named, ['FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_DIRECT_IO_RELAX']);
    for (const name of named) {
        assert.ok(FUSE_VIEW_SETTINGS.init.forbiddenCapabilities.includes(name), name);
        const sample = goodSample();
        sample.init.capabilities.push(name);
        assert.deepEqual(codes(findSettingsViolations(sample)), ['forbidden_init_capability'], name);
    }
});
