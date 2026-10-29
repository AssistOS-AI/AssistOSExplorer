// G1 evidence records and the verdict rule (plan g4-apparatus-target-plan, "Harness interface and evidence record").
//
// PASS requires the expected observation AND the negative control's opposite observation. A record whose negative
// control was not observed is FAIL. Any unreadable /proc entry is FAIL, never skipped. A harness error is NOT-RUN.
// Verdicts are computed from the stored observations by the probe's pure `grade` function, so the collector can
// recompute every verdict from the evidence and refuse a record whose stored verdict disagrees.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'NOT-RUN', 'NON-QUALIFYING', 'BLOCKED']);
export const RECORD_SCHEMA = 'robo-work-g1-record/1';
const PROBE_ID = /^(T0-0[1-9]|G1-[0-9]{2}[a-z]?)$/;

export function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Stable JSON: object keys sorted, so the same record always serializes to the same bytes.
export function canonicalJson(value) {
    return JSON.stringify(sortKeys(value), null, 1) + '\n';
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
    }
    return value;
}

function observed(value) {
    return value !== undefined && value !== null;
}

// The verdict rule. `grade(observed, controlObserved)` is the probe's pure grader and returns
// { expectedMet: boolean, controlOppositeMet: boolean, notes?: string[] }.
export function gradeRecord(record, grade) {
    if (record.harnessError) return { verdict: 'NOT-RUN', reasons: [`harness error: ${record.harnessError}`] };
    if (record.blocked) return { verdict: 'BLOCKED', reasons: [`blocked: ${record.blocked}`] };
    const reasons = [];
    const control = record.negativeControl;
    if (!control || !observed(control.observed)) reasons.push('negative control not observed');
    if (!control || typeof control.command !== 'string' || control.command === '') reasons.push('negative control has no command');
    if (Array.isArray(record.unreadable) && record.unreadable.length > 0) {
        reasons.push(`unreadable /proc entries: ${record.unreadable.map((entry) => entry.path).join(', ')}`);
    }
    if (!observed(record.observed)) reasons.push('expected observation missing');
    if (reasons.length === 0) {
        let result;
        try {
            result = grade(record.observed, control.observed);
        } catch (error) {
            result = { expectedMet: false, controlOppositeMet: false, notes: [`grader threw: ${error.message}`] };
        }
        if (result?.expectedMet !== true) reasons.push('expected observation not met');
        if (result?.controlOppositeMet !== true) reasons.push('negative control did not behave as the opposite');
        for (const note of result?.notes ?? []) reasons.push(note);
        if (result?.expectedMet !== true || result?.controlOppositeMet !== true) return { verdict: 'FAIL', reasons };
    } else {
        return { verdict: 'FAIL', reasons };
    }
    if (record.qualificationRequired === true && record.qualifying !== true) {
        return { verdict: 'NON-QUALIFYING', reasons: ['the runtime is not the qualifying image Node'] };
    }
    return { verdict: 'PASS', reasons };
}

export function buildRecord(fields, grade) {
    if (!PROBE_ID.test(fields.probeId ?? '')) throw new TypeError(`bad probe id ${fields.probeId}`);
    for (const key of ['stage', 'candidateIdentitySha256', 'command', 'startedAt', 'expected']) {
        if (typeof fields[key] !== 'string' || fields[key] === '') throw new TypeError(`record field ${key} is required`);
    }
    if (!/^[0-9a-f]{64}$/.test(fields.candidateIdentitySha256)) throw new TypeError('candidateIdentitySha256 must be a SHA-256');
    const record = {
        schema: RECORD_SCHEMA,
        probeId: fields.probeId,
        planRefs: fields.planRefs ?? [],
        rows: fields.rows ?? [],
        stage: fields.stage,
        candidateIdentitySha256: fields.candidateIdentitySha256,
        command: fields.command,
        startedAt: fields.startedAt,
        expected: fields.expected,
        observed: fields.observed ?? null,
        negativeControl: fields.negativeControl ?? null,
        measurements: fields.measurements ?? {},
        unreadable: fields.unreadable ?? [],
        harnessError: fields.harnessError ?? null,
        blocked: fields.blocked ?? null,
    };
    const { verdict, reasons } = gradeRecord(record, grade);
    record.verdict = verdict;
    record.verdictReasons = reasons;
    return record;
}

// Exclusive create: an existing record is never overwritten.
export function writeRecord(outDir, record) {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const file = path.join(outDir, `${record.probeId}.json`);
    const bytes = canonicalJson(record);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { file, sha256: sha256(bytes) };
}

// AC-1 for one stage: every required probe present exactly once, re-graded verdict equal to the stored one, verdict
// PASS with an observed negative control, zero NOT-RUN, and the identity hash equal in every record.
export function verifyRecordSet({ records, required, identitySha256, graders, stage }) {
    const problems = [];
    if (!/^[0-9a-f]{64}$/.test(identitySha256 ?? '')) problems.push('identity hash missing');
    const byId = new Map();
    for (const record of records) {
        if (byId.has(record.probeId)) problems.push(`${record.probeId}: duplicate record`);
        byId.set(record.probeId, record);
    }
    for (const id of required) {
        const record = byId.get(id);
        if (!record) {
            problems.push(`${id}: no record (counts as NOT-RUN)`);
            continue;
        }
        if (record.schema !== RECORD_SCHEMA) problems.push(`${id}: schema ${record.schema}`);
        if (record.stage !== stage) problems.push(`${id}: stage ${record.stage}, expected ${stage}`);
        if (record.candidateIdentitySha256 !== identitySha256) problems.push(`${id}: candidate identity hash differs`);
        const grade = graders[id];
        if (typeof grade !== 'function') {
            problems.push(`${id}: no grader`);
            continue;
        }
        const recomputed = gradeRecord(record, grade).verdict;
        if (recomputed !== record.verdict) problems.push(`${id}: stored verdict ${record.verdict}, recomputed ${recomputed}`);
        if (record.verdict === 'NOT-RUN') problems.push(`${id}: NOT-RUN`);
        else if (recomputed !== 'PASS') problems.push(`${id}: verdict ${recomputed}`);
        if (!record.negativeControl || !observed(record.negativeControl.observed)) problems.push(`${id}: negative control not observed`);
    }
    return { ok: problems.length === 0, problems };
}
