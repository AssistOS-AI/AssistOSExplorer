// The native target helper's journal differential vector (robo-work/native/crates/target-helper/tests/vectors/
// journal-differential.json) must be exactly what the generator produces from the current journal oracle. A change to
// journalModel.mjs (or the modules it imports) that alters any result fails here until the vector is regenerated and
// the native differential test (cargo test -p rw-target-helper --test journal_differential) passes against it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roboWork = path.resolve(here, '../..');
const vectorDir = path.join(roboWork, 'native/crates/target-helper/tests/vectors');
const { buildVector, renderVector } = await import(pathToFileURL(path.join(vectorDir, 'gen-journal-differential.mjs')).href);

test('the committed journal differential vector regenerates byte-identically from the oracle', async () => {
    const committed = fs.readFileSync(path.join(vectorDir, 'journal-differential.json'), 'utf8');
    const vector = await buildVector(roboWork);
    assert.equal(renderVector(vector), committed);
    for (const [file, digest] of Object.entries(vector.oracleModules)) {
        const bytes = fs.readFileSync(path.join(roboWork, '..', file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest, file);
    }
});

test('the vector exercises every helper operation, fault and journal event', async () => {
    const vector = JSON.parse(fs.readFileSync(path.join(vectorDir, 'journal-differential.json'), 'utf8'));
    const ops = new Set(vector.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.op)));
    for (const op of ['prepare', 'commit', 'lookup', 'input', 'stop', 'observeExit', 'release', 'retire', 'advance', 'inject', 'loseJournal', 'replaceJournal', 'recreateHelper']) {
        assert.ok(ops.has(op), op);
    }
    const faults = new Set(vector.scenarios.flatMap((scenario) => scenario.steps.filter((step) => step.op === 'inject').map((step) => step.fault)));
    assert.deepEqual([...faults].sort(), ['crash-after-intent', 'crash-after-persist', 'crash-before-durable', 'lost-reply']);
    const codes = new Set(vector.scenarios.flatMap((scenario) => scenario.steps.filter((step) => step.result && !step.result.ok).map((step) => step.result.error.code)));
    for (const code of ['invalid_request', 'journal_unavailable', 'operation_conflict', 'binding_mismatch', 'not_found', 'capacity_exceeded', 'outcome_unknown', 'absence_unverified', 'delivery_unknown', 'lease_retired']) {
        assert.ok(codes.has(code), code);
    }
});
