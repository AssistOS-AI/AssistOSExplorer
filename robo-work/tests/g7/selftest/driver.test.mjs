// Slice P7 self-test of tests/g7/driver.mjs in its LOCAL configuration: the rwcoord front process (production
// coordinatorAuth + availability + qualificationStore, real HS256 hop tokens), the LOCAL Router stand-in and the
// coordinator CLI, all as separate processes driven exactly as a live run drives them. LOCAL results are not live
// evidence. Every identity, secret and record is SYNTHETIC. Nothing here is skipped.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalTargetJson } from '../../../server/executionTarget/contract.mjs';
import { installFixtureRecord } from '../tools/install-fixture-record.mjs';
import { buildFixture } from '../fixture/rwcoord/facts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const G7 = path.resolve(here, '..');
const RWCOORD = path.join(G7, 'fixture', 'rwcoord');
const DRIVER = path.join(G7, 'driver.mjs');
const NODE = process.execPath;
const UID = process.getuid();
const WORKER = 'agent:rwrepo/rwworker';
const COORDINATOR = 'agent:rwrepo/rwcoord';
const ROGUE = 'agent:rwrepo/rwrogue';
const sid = (label) => crypto.createHash('sha256').update(`rwcoord-driver-selftest:${label}`).digest().subarray(0, 16).toString('base64url');
const WORKER_IDENTITY = { principal: WORKER, runtimeInstanceId: 'rwworker-instance-1', enableGeneration: 'rwworker-enable-1', generation: sid('generation') };

function tempBase(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rwd-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
}

// A long-running child whose first stdout line is {event: 'listening', port}.
async function startListening(t, args, env) {
    const child = spawn(NODE, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    const first = await new Promise((resolve, reject) => {
        lines.once('line', (line) => resolve(JSON.parse(line)));
        child.once('exit', (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    assert.equal(first.event, 'listening');
    const events = [];
    lines.on('line', (line) => events.push(JSON.parse(line)));
    return { child, port: first.port, events };
}

function runDriver(configFile, out) {
    return new Promise((resolve) => {
        const child = spawn(NODE, [DRIVER, 'p7', '--config', configFile, '--out', out], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function localRun(t, { routerCallers = [COORDINATOR], environment = 'local', hideStandIn = false } = {}) {
    const base = tempBase(t);
    const nowMs = Date.now();
    const live = {
        workspaceId: 'workspace:synthetic-driver', boxIdentity: 'ploinky-box-synthetic', boxGeneration: 'b'.repeat(64), coordinator: COORDINATOR,
        staleWorkerAlias: 'agent:rwrepo/rw-worker-old', candidateDigest: 'c'.repeat(64), worker: WORKER_IDENTITY,
        target: {
            ref: 'rwrepo/rwtarget', instanceId: 'rwtarget-instance-1', containerId: 'd'.repeat(64), enableGeneration: 'rwtarget-enable-1', helperIncarnation: sid('helper'),
            running: true, journalAvailable: true, journalStoreIdentity: sid('journal'), imageDigest: 'e'.repeat(64), helperExecutableDigest: 'f'.repeat(64),
            contractDigest: '1'.repeat(64), inventoryDigest: '2'.repeat(64), profileDigest: '3'.repeat(64), peerDigest: '4'.repeat(64)
        },
        platform: { kernelRelease: '6.8.0-synthetic', runtimeVersion: '5.0.0-synthetic' }, originSeeds: ['first', 'second']
    };
    const { variants, record, plan } = buildFixture(live, nowMs);
    const storeRoot = path.join(base, 'qualification');
    const installed = installFixtureRecord({
        fs, uid: UID, storeRoot, create: true, ref: 'rwrepo/rwtarget', recordText: Buffer.from(canonicalTargetJson(record, { maxBytes: 1 << 20 }).value),
        expectedLive: { containerId: record.scope.containerId, helperIncarnation: record.scope.helperIncarnation }
    });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    const variantFiles = {};
    for (const [name, value] of Object.entries(variants)) {
        variantFiles[name] = path.join(base, name);
        fs.writeFileSync(variantFiles[name], JSON.stringify(value));
    }
    const factsFile = path.join(base, 'facts.json');
    fs.copyFileSync(variantFiles['facts-base.json'], factsFile);
    const secret = crypto.randomBytes(32).toString('hex');
    const stateDir = path.join(base, 'front');
    const front = await startListening(t, [path.join(RWCOORD, 'front.mjs'), 'serve', '--port', '0', '--store-root', storeRoot, '--facts', factsFile, '--state', stateDir,
        '--coordinator', COORDINATOR, '--worker-generation', WORKER_IDENTITY.generation, '--agent-lib', path.join(base, 'no-agent-lib')], {
        PLOINKY_AGENT_ID: WORKER, PLOINKY_AGENT_INSTANCE_ID: WORKER_IDENTITY.runtimeInstanceId, PLOINKY_AGENT_ENABLE_GENERATION: WORKER_IDENTITY.enableGeneration,
        PLOINKY_AGENT_SECRET: secret
    });
    const router = await startListening(t, [path.join(RWCOORD, 'localRouter.mjs'), '--port', '0', '--provider-route', 'rwworker', '--provider-principal', WORKER,
        '--callers', routerCallers.join(','), '--front-port', String(front.port), '--route-port', '7301'], { RWCOORD_LOCAL_PROVIDER_SECRET: secret });
    const routerUrl = `http://127.0.0.1:${router.port}`;
    const coordinatorCli = path.join(RWCOORD, 'coordinator.mjs');
    const install = (name) => [NODE, '-e', 'require("fs").copyFileSync(process.argv[1], process.argv[2])', variantFiles[name], factsFile];
    // `hideStandIn`: a wrapper that adds the stand-in arguments itself, so the configuration does not name them (only the
    // per-answer transport check can then tell that the run did not go through Ploinky's Router).
    const side = (caller) => {
        if (!hideStandIn) return { command: [NODE, coordinatorCli], args: ['--local-router', routerUrl, '--local-caller', caller] };
        const wrapper = path.join(base, `wrap-${caller.split('/')[1]}.mjs`);
        fs.writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, [${JSON.stringify(coordinatorCli)}, ...process.argv.slice(2), ${JSON.stringify('--local-' + 'router')}, ${JSON.stringify(routerUrl)}, ${JSON.stringify('--local-' + 'caller')}, ${JSON.stringify(caller)}], { stdio: 'inherit' });\nprocess.exitCode = r.status;\n`);
        return { command: [NODE, wrapper], args: [] };
    };
    const config = {
        environment, label: 'driver selftest (LOCAL Router stand-in)', provider: { route: 'rwworker', port: 7301 },
        coordinator: side(COORDINATOR),
        rogue: side(ROGUE),
        observe: [NODE, path.join(RWCOORD, 'front.mjs'), 'observe', '--store-root', storeRoot, '--state', stateDir, '--ref', 'rwrepo/rwtarget'],
        facts: {
            base: install('facts-base.json'), unprepared: install('facts-unprepared.json'), noSourceUnprepared: install('facts-no-source-unprepared.json'),
            ploinkySource: install('facts-ploinky-source.json')
        },
        selections: {
            target: 'rwrepo/rwtarget', worker: WORKER, roboteam: 'agent:AchillesIDE/roboTeamAgent', staleWorkerAlias: live.staleWorkerAlias, coordinator: COORDINATOR,
            shadow: 'rwrepo/rwshadow', unknown: 'rwrepo/nosuch'
        },
        admissibleOrigins: [plan.origins.first, plan.origins.second]
    };
    const configFile = path.join(base, 'run.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const out = path.join(base, 'out');
    const result = await runDriver(configFile, out);
    const report = fs.existsSync(path.join(out, 'p7-results.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'p7-results.json'), 'utf8')) : null;
    return { result, report, front, secret, plan };
}

test('P7 driver, LOCAL configuration: all seventeen cases match, refusals leave the count and records unchanged', async (t) => {
    const { result, report, front, secret, plan } = await localRun(t);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(report.cases, 17);
    assert.equal(report.passed, 17);
    assert.deepEqual(report.results.map((entry) => entry.id), Array.from({ length: 17 }, (_, index) => `P7-${String(index + 1).padStart(2, '0')}`));
    const byId = Object.fromEntries(report.results.map((entry) => [entry.id, entry]));
    assert.equal(byId['P7-01'].answer.answer.value.executionsUsed, 1);
    assert.equal(byId['P7-17'].answer.answer.value.executionsUsed, 2);
    assert.deepEqual(byId['P7-17'].observationAfter.admissions, [...plan.operationIds].sort());
    assert.equal(byId['P7-04'].answer.status, 403);
    // The front saw every case except the undeclared caller, and logged no secret.
    const seen = front.events.filter((event) => event.event === 'request');
    assert.equal(seen.length, 16);
    assert.equal(JSON.stringify(front.events).includes(secret), false);
    assert.equal(JSON.stringify(report).includes(secret), false);
});

test('P7 driver negative control: when the Router also forwards the undeclared caller, the driver fails that case and exits 1', async (t) => {
    const { result, report } = await localRun(t, { routerCallers: [COORDINATOR, ROGUE] });
    assert.equal(result.code, 1);
    const failed = report.results.filter((entry) => !entry.pass).map((entry) => entry.id);
    assert.deepEqual(failed, ['P7-04']);
    // The front itself still refused the undeclared principal (defense in depth), without a count.
    const rogue = report.results.find((entry) => entry.id === 'P7-04');
    assert.deepEqual([rogue.answer.status, rogue.answer.answer.code, rogue.answer.answer.reason], [403, 'forbidden', 'coordinator']);
    assert.deepEqual(rogue.observationAfter, rogue.observationBefore);
});

test('P7 driver, live configuration: naming the LOCAL Router stand-in is refused before any case runs', async (t) => {
    const { result, report, front } = await localRun(t, { environment: 'live' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /must not name the LOCAL Router stand-in/);
    assert.equal(report, null);
    assert.equal(front.events.filter((event) => event.event === 'request').length, 0);
});

test('P7 driver, live configuration: an answer that did not travel through the Ploinky private Router fails its case', async (t) => {
    const { result, report } = await localRun(t, { environment: 'live', hideStandIn: true });
    assert.equal(result.code, 1);
    assert.equal(report.failed, 17);
    for (const entry of report.results) assert.ok(entry.reasons.includes('transport local-stand-in'), `${entry.id}: ${entry.reasons.join('; ')}`);
});

test('P7 driver observation lists leftover intents, so the no-side-effect check sees them', (t) => {
    const base = tempBase(t);
    const state = path.join(base, 'front');
    const observe = () => JSON.parse(spawnSync(NODE, [path.join(RWCOORD, 'front.mjs'), 'observe', '--store-root', path.join(base, 'q'), '--state', state, '--ref', 'rwrepo/rwtarget'], { encoding: 'utf8' }).stdout);
    fs.mkdirSync(path.join(state, 'intents'), { recursive: true });
    const before = observe();
    assert.deepEqual(before.intents, []);
    fs.writeFileSync(path.join(state, 'intents', `${'A'.repeat(22)}.json`), '{}');
    fs.writeFileSync(path.join(state, 'intents', '.not-an-intent.tmp'), '{}');
    const after = observe();
    assert.deepEqual(after.intents, ['A'.repeat(22)]);
    assert.notEqual(JSON.stringify(after), JSON.stringify(before), 'the driver compares whole observations');
});
