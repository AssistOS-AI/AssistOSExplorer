import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildRecord, gradeRecord, verifyRecordSet, writeRecord } from '../lib/record.mjs';
import { tempDir } from './synthProc.mjs';

// SYNTHETIC records only: the verdict rule of plan g4 "Harness interface and evidence record".

const IDENTITY = 'a'.repeat(64);
const passGrade = (observed, control) => ({ expectedMet: observed.ok === true, controlOppositeMet: control.opposite === true });

function base(overrides = {}) {
    return {
        probeId: 'T0-04', stage: 'S0', candidateIdentitySha256: IDENTITY, command: 'probe', startedAt: '2026-10-28T00:00:00.000Z',
        expected: 'x', observed: { ok: true }, negativeControl: { command: 'control', expected: 'y', observed: { opposite: true } }, ...overrides,
    };
}

test('PASS needs the expected observation and the opposite negative control', () => {
    assert.equal(buildRecord(base(), passGrade).verdict, 'PASS');
    assert.equal(buildRecord(base({ observed: { ok: false } }), passGrade).verdict, 'FAIL');
    assert.equal(buildRecord(base({ negativeControl: { command: 'c', expected: 'y', observed: { opposite: false } } }), passGrade).verdict, 'FAIL');
});

test('mutation: a missing negative control is FAIL, whatever the grader says', () => {
    const alwaysPass = () => ({ expectedMet: true, controlOppositeMet: true });
    assert.equal(buildRecord(base({ negativeControl: null }), alwaysPass).verdict, 'FAIL');
    assert.equal(buildRecord(base({ negativeControl: { command: 'c', expected: 'y' } }), alwaysPass).verdict, 'FAIL');
    assert.equal(buildRecord(base({ negativeControl: { command: 'c', expected: 'y', observed: null } }), alwaysPass).verdict, 'FAIL');
    assert.equal(buildRecord(base({ negativeControl: { command: '', expected: 'y', observed: {} } }), alwaysPass).verdict, 'FAIL');
    const record = buildRecord(base({ negativeControl: null }), alwaysPass);
    assert.match(record.verdictReasons.join(' '), /negative control not observed/);
});

test('unreadable /proc entries are FAIL, harness errors are NOT-RUN, grader exceptions are FAIL', () => {
    assert.equal(buildRecord(base({ unreadable: [{ path: '/proc/9/status', code: 'EACCES' }] }), passGrade).verdict, 'FAIL');
    assert.equal(buildRecord(base({ harnessError: 'boom' }), passGrade).verdict, 'NOT-RUN');
    assert.equal(buildRecord(base({ blocked: 'ssh' }), passGrade).verdict, 'BLOCKED');
    assert.equal(buildRecord(base(), () => { throw new Error('x'); }).verdict, 'FAIL');
    assert.equal(buildRecord(base({ observed: null }), () => ({ expectedMet: true, controlOppositeMet: true })).verdict, 'FAIL');
});

test('a qualification-required record on a non-qualifying runtime is NON-QUALIFYING', () => {
    const record = { ...base(), qualificationRequired: true, qualifying: false, unreadable: [] };
    assert.equal(gradeRecord(record, passGrade).verdict, 'NON-QUALIFYING');
    assert.equal(gradeRecord({ ...record, qualifying: true }, passGrade).verdict, 'PASS');
});

test('records are written exclusively and fields are validated', () => {
    const dir = tempDir();
    const record = buildRecord(base(), passGrade);
    const first = writeRecord(dir, record);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.throws(() => writeRecord(dir, record), /EEXIST/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'T0-04.json'), 'utf8')).verdict, 'PASS');
    assert.throws(() => buildRecord(base({ probeId: '../x' }), passGrade), /bad probe id/);
    assert.throws(() => buildRecord(base({ candidateIdentitySha256: 'abc' }), passGrade), /SHA-256/);
});

test('AC-1 record-set verification: recomputed verdicts, identity, completeness, no NOT-RUN', () => {
    const graders = { 'T0-04': passGrade, 'T0-01': passGrade };
    const good = [buildRecord(base(), passGrade), buildRecord(base({ probeId: 'T0-01' }), passGrade)];
    assert.equal(verifyRecordSet({ records: good, required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' }).ok, true);
    const missing = verifyRecordSet({ records: good.slice(0, 1), required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' });
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /T0-01: no record/);
    const tampered = [{ ...buildRecord(base({ observed: { ok: false } }), passGrade), verdict: 'PASS' }, good[1]];
    assert.match(verifyRecordSet({ records: tampered, required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' }).problems.join(' '), /recomputed FAIL/);
    const noControl = [{ ...good[0], negativeControl: null, verdict: 'PASS' }, good[1]];
    assert.equal(verifyRecordSet({ records: noControl, required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' }).ok, false);
    assert.equal(verifyRecordSet({ records: good, required: ['T0-01', 'T0-04'], identitySha256: 'b'.repeat(64), graders, stage: 'S0' }).ok, false);
    const notRun = [buildRecord(base({ harnessError: 'x' }), passGrade), good[1]];
    assert.match(verifyRecordSet({ records: notRun, required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' }).problems.join(' '), /NOT-RUN/);
    assert.equal(verifyRecordSet({ records: good, required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S1' }).ok, false);
    assert.equal(verifyRecordSet({ records: [...good, good[0]], required: ['T0-01', 'T0-04'], identitySha256: IDENTITY, graders, stage: 'S0' }).ok, false);
});
