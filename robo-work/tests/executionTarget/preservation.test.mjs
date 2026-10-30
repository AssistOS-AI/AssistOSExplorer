// Preservation checks for generic T1 (T1-10): the default runtime still refuses, the new modules have no production
// importer, and a nonempty Environment cannot start work. SYNTHETIC contexts and stores only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectExecutionTargets, requireExecutionTarget } from '../../server/executionTarget/availability.mjs';
import { runtimeUnavailable } from '../../server/runtimeUnavailable.mjs';
import { openWorkerState } from '../../server/workerState.mjs';
import { LIMITS, PROVIDER, WORKSPACE, admitRequest, makeTempDir, newId, robotConfig, syntheticContext } from '../helpers/synthetic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROBO_WORK = path.resolve(here, '..', '..');
const REPOSITORY = path.resolve(ROBO_WORK, '..');
const MODULE_DIR = path.join(ROBO_WORK, 'server', 'executionTarget');
const TEST_DIR = here;
const TEMP_DIR = fs.realpathSync(os.tmpdir());
// The one operator tool (P6a) that may import the module from outside tests/executionTarget; nothing may import the tool.
const OPERATOR_TOOL = path.join(ROBO_WORK, 'tools', 'install-fixture-record.mjs');
// Proof-fixture G7 code (P3 rwtarget manifest renderer, P6b rwworker host) and its self-tests may import the modules;
// nothing outside these two directories may import them (checked below).
const G7_FIXTURE_DIR = path.join(ROBO_WORK, 'tests', 'g7', 'fixture');
const G7_SELFTEST_DIR = path.join(ROBO_WORK, 'tests', 'g7', 'selftest');

test('T1-10 the default runtime adapter is unchanged and refuses everything', () => {
    assert.ok(Object.isFrozen(runtimeUnavailable));
    assert.deepEqual(Object.keys(runtimeUnavailable), ['name', 'canPrepare', 'attestRobot', 'admissionReady', 'requiredKinds', 'verifyAbsence']);
    assert.equal(runtimeUnavailable.name, 'runtime-unavailable');
    assert.equal(runtimeUnavailable.canPrepare(), false);
    assert.equal(runtimeUnavailable.attestRobot({}), false);
    assert.equal(runtimeUnavailable.admissionReady({}), false);
    assert.deepEqual(runtimeUnavailable.requiredKinds('admit'), []);
    assert.equal(runtimeUnavailable.verifyAbsence({}), null);
    // The exact baseline quoted by the T0 freeze (runtimeUnavailable.mjs:12-18).
    const source = fs.readFileSync(path.join(ROBO_WORK, 'server', 'runtimeUnavailable.mjs'), 'utf8');
    assert.ok(source.includes([
        'export const runtimeUnavailable = Object.freeze({',
        "    name: 'runtime-unavailable',",
        '    canPrepare() { return false; },',
        '    attestRobot() { return false; },',
        '    admissionReady() { return false; },',
        '    requiredKinds() { return []; },',
        '    verifyAbsence() { return null; }',
        '});'
    ].join('\n')));
});

test('T1-10 a store opened with the default runtime provisions, attests and admits nothing', (t) => {
    const dir = makeTempDir(t);
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, create: true });
    t.after(() => store.close());
    const context = syntheticContext();
    assert.throws(() => store.beginProvision(context, { operationId: newId(), name: 'Synthetic robot', configuration: robotConfig() }), (error) => error.code === 'runtime_unavailable');
    assert.throws(() => store.admit(context, admitRequest(newId(), {}, context)), (error) => ['runtime_unavailable', 'not_found'].includes(error.code));
    assert.deepEqual(store.listRobots(context), []);
});

// Whether `text` (the content of `file`) imports from tests/g7/fixture or tests/g7/selftest: by a path naming them, or by
// a relative specifier that resolves into them.
function importsIntoG7(file, text) {
    if (/(import|require)\s*\(?[^;]*g7\/(fixture|selftest)\//.test(text)) return true;
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (target.startsWith(`${G7_FIXTURE_DIR}${path.sep}`) || target.startsWith(`${G7_SELFTEST_DIR}${path.sep}`)) return true;
    }
    return false;
}

function sourceFiles(root) {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // Never traverse managed checkouts, dependency trees or VCS metadata; never follow links.
            if (entry.name === '.ploinky' || entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            // Concurrent test files create and delete temporary stores under TMPDIR (which may lie inside the checkout).
            if (full === TEMP_DIR) continue;
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && /\.(mjs|cjs|js|ts|mts|json)$/.test(entry.name)) files.push(full);
        }
    };
    walk(root);
    return files;
}

test('T1-10 no file outside tests/executionTarget imports the executionTarget modules', () => {
    const offenders = [];
    let scanned = 0;
    for (const file of sourceFiles(REPOSITORY)) {
        if (file.startsWith(`${MODULE_DIR}${path.sep}`) || file.startsWith(`${TEST_DIR}${path.sep}`) || file === OPERATOR_TOOL) continue;
        if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (file.startsWith(`${G7_FIXTURE_DIR}${path.sep}`) || file.startsWith(`${G7_SELFTEST_DIR}${path.sep}`)) continue;
        scanned += 1;
        if (importsIntoG7(file, text)) offenders.push(path.relative(REPOSITORY, file));
        if (/executionTarget\//.test(text) && /(import|require)\s*\(?[^;]*executionTarget\//.test(text)) offenders.push(path.relative(REPOSITORY, file));
        if (/server\/executionTarget/.test(text)) offenders.push(path.relative(REPOSITORY, file));
        if (/install-fixture-record/.test(text)) offenders.push(path.relative(REPOSITORY, file));
        if (/gen-journal-differential/.test(text)) offenders.push(path.relative(REPOSITORY, file));
    }
    assert.ok(scanned > 100, 'the scan covered the repository');
    assert.deepEqual([...new Set(offenders)], []);
    // Negative controls for the G7 importer rule: a sibling importing relatively, another tree importing by path.
    assert.equal(importsIntoG7(path.join(ROBO_WORK, 'tests', 'g7', 'driver.mjs'), "import { createWorkerHost } from './fixture/rwworker/workerHost.mjs';"), true);
    assert.equal(importsIntoG7(path.join(ROBO_WORK, 'server', 'x.mjs'), "const m = await import('../tests/g7/selftest/rwworker.test.mjs');"), true);
    assert.equal(importsIntoG7(path.join(ROBO_WORK, 'tests', 'g7', 'driver.mjs'), "import fs from 'node:fs';\nimport { a } from './tools/install-fixture-record.mjs';"), false);
    assert.ok(fs.statSync(OPERATOR_TOOL).isFile(), 'the single exempt operator tool exists');
});

test('T1-10 the new modules import only each other and Node built-ins', () => {
    const files = fs.readdirSync(MODULE_DIR).filter((name) => name.endsWith('.mjs'));
    assert.deepEqual(files.sort(), ['availability.mjs', 'contract.mjs', 'journalModel.mjs', 'limits.mjs', 'qualificationStore.mjs', 'receipts.mjs', 'sourceReservations.mjs', 'transportContract.mjs']);
    for (const file of files) {
        const text = fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
        const specifiers = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
        for (const specifier of specifiers) {
            assert.ok(specifier.startsWith('node:') || /^\.\/[A-Za-z]+\.mjs$/.test(specifier), `${file} imports ${specifier}`);
        }
        assert.doesNotMatch(text, /\brequire\(|import\(/, `${file}: no dynamic import`);
        assert.doesNotMatch(text, /from 'node:(fs|net|http|https|child_process|dgram|tls|worker_threads)'/, `${file}: no I/O or process module`);
    }
});

test('T1-10 a nonempty Environment cannot start work: activation is a constant, every selection refuses', () => {
    const source = fs.readFileSync(path.join(MODULE_DIR, 'availability.mjs'), 'utf8');
    assert.match(source, /^const BACKEND_ACTIVATED = false;$/m);
    assert.equal(source.match(/BACKEND_ACTIVATED/g).length, 2, 'declared once, read once, never reassigned');
    const live = { workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1' };
    const excluded = { principals: ['agent:SyntheticIDE/roboTeamAgent', 'agent:SyntheticIDE/roboWork'], aliases: [], runtimeInstanceIds: [] };
    for (let index = 0; index < 200; index += 1) {
        const name = crypto.createHash('sha256').update(`selection-${index}`).digest('hex').slice(0, 12);
        const ref = `Repo${index % 7}/${name}`;
        const entry = {
            ref, label: name, principal: `agent:${ref}`, aliases: [], runtimeInstanceId: `instance-${index}`, containerId: 'c'.repeat(64),
            enableGeneration: 'enable-1', helperIncarnation: crypto.createHash('sha256').update(name).digest().subarray(0, 16).toString('base64url'),
            ...live, enabled: true, running: true, runtime: 'container', placement: 'global', declaration: { valid: true }, prepared: true,
            journal: 'available', attestation: {}, activeExecutions: 0
        };
        for (const surface of ['terminal', 'browser', 'desktop']) {
            for (const mode of ['production', 'proof-fixture']) {
                const result = requireExecutionTarget(ref, { surface, mode, live, excluded, entries: [entry], sourceState: null, qualifications: null, request: null, home: null, admittedBinding: null });
                assert.equal(result.ok, false, `${ref} ${surface} ${mode}`);
            }
        }
        const projection = projectExecutionTargets({ entries: [entry], trustedIdentities: { live, excluded }, qualificationStore: null, sourceState: null, mode: 'production' });
        assert.ok(projection.ok && projection.value.targets.every((target) => target.available === false));
    }
});
