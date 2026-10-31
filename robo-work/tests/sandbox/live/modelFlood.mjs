// Live flood probe for the model channel's admission limits (decision M-45). Run as container root in the Box worker as an extra process
// (or in the nested-podman profile, like smoke.mjs and modelChannel.mjs):
//
//   node /code/tests/sandbox/live/modelFlood.mjs --self-test       # a fake upstream (40 ms per completion): mechanics and numbers, no gateway
//   node /code/tests/sandbox/live/modelFlood.mjs                   # live: the worker's own Soul Gateway identity (MODEL_PROBE_ID selects the model)
//   options: --flood-seconds <n> (default 30)   --turns <n> (default 6)   --requests-per-turn <n> (default 4)   --pause-ms <n> (default 4000)
//
// Two executions are built IN THIS PROCESS with the real execution factory, supervisor, launcher, network, provider endpoint, relay and model
// channel (a stub for ALA and a thin ledger stand-in, like modelChannel.mjs), so the event loop measured here is the one the channels and the
// endpoint servers run on in the worker. Both are OpenCode robots with a gateway model, so each has its own channel:
//
//   B baseline   B's workload completes TURNS turns (REQUESTS_PER_TURN sequential chat requests each, PAUSE_MS between turns) while A is idle.
//   flood        A's workload floods its relay with 2 MiB bodies of a foreign model (8 parallel loops, no pause) for FLOOD_SECONDS, and during
//                the same window B completes the same turns again.
//
// Recorded (perf_hooks monitorEventLoopDelay at a 10 ms resolution plus process.cpuUsage, per phase): the supervisor process's maximum, p99 and
// mean event-loop delay, B's turn times and request latencies with and without the flood, and what A's flood got back (status counts).
// After the flood A sends 80 requests one at a time: each must be answered (429 for the refused ones) and NONE may see a reset or any error.
// (During the flood itself, connections beyond the channel's and the relay's connection limits are dropped at accept: those errors come without an
// answer and are reported, but only an error AFTER an answer fails the probe.)
// Pass (exit 0) when every B request is 200 in both phases, the flood met the limits (429 `rate_limited` seen, and no more non-429 answers than
// the bucket allows), B's slowest flooded turn is at most 2 s longer than its slowest baseline turn, and the flood's maximum event-loop delay
// stays under 1000 ms. The numbers are printed whatever the verdict, as ONE JSON document on stdout; progress goes to stderr.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { createProcView } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { planAlaExecution } from '../../../server/runtime/alaPlan.mjs';
import { createExecutionFactory } from '../../../server/runtime/executionFactory.mjs';
import { ADMISSION, MODEL_RELAY_PORT, createSoulGatewayUpstream } from '../../../server/runtime/modelChannel.mjs';
import { createRobotStore } from '../../../server/runtime/robotStore.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';

const SOURCE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SELF_TEST = process.argv.includes('--self-test');
const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(process.argv[index + 1]);
    if (!Number.isFinite(value) || value < 1) { process.stderr.write(`${name} needs a positive number\n`); process.exit(2); }
    return value;
};
const FLOOD_SECONDS = option('--flood-seconds', 30);
const TURNS = option('--turns', 6);
const REQUESTS_PER_TURN = option('--requests-per-turn', 4);
const PAUSE_MS = option('--pause-ms', 4000);
const evidence = { mode: SELF_TEST ? 'self-test' : 'live', config: { floodSeconds: FLOOD_SECONDS, turns: TURNS, requestsPerTurn: REQUESTS_PER_TURN, pauseMs: PAUSE_MS, admission: ADMISSION }, phases: {}, checks: {}, errors: [] };
const progress = (text) => process.stderr.write(`[modelFlood] ${text}\n`);
const check = (name, ok, extra = {}) => { evidence.checks[name] = { ok: ok === true, ...extra }; if (ok !== true) evidence.errors.push(name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the programs that run inside the sandboxes ---------------------------------------------------------------------------------

const ALA_STUB = 'setInterval(() => {}, 1e6);\n';

// A: floods its relay with 2 MiB bodies of a foreign model, PARALLEL loops without a pause, until the deadline (or MAX requests: the serial phase).
const FLOOD = String.raw`
const http = require('http'); const fs = require('fs');
const config = JSON.parse(process.env.PROBE_CONFIG);
const LIMIT = 2 * 1024 * 1024;
const frame = JSON.stringify({ model: config.foreign, messages: [{ role: 'user', content: '' }] });
const body = Buffer.from(JSON.stringify({ model: config.foreign, messages: [{ role: 'user', content: 'p'.repeat(LIMIT - Buffer.byteLength(frame)) }] }));
const out = { bodyBytes: body.length, sent: 0, statuses: {}, errors: {}, errorsAfterResponse: 0, errorsWithoutResponse: 0 };
const deadline = Date.now() + config.seconds * 1000;
const once = () => new Promise((resolve) => {
    out.sent += 1;
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port: config.port, method: 'POST', path: '/v1/chat/completions', agent: false, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
        answered = true;
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { out.statuses[res.statusCode] = (out.statuses[res.statusCode] ?? 0) + 1; resolve(); });
        res.on('error', () => resolve());
    });
    req.on('error', (error) => {
        out.errors[error.code ?? 'ERR'] = (out.errors[error.code ?? 'ERR'] ?? 0) + 1;
        if (answered) out.errorsAfterResponse += 1; else out.errorsWithoutResponse += 1;
        resolve();
    });
    req.setTimeout(30000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.end(body);
});
const loop = async () => { while (Date.now() < deadline && out.sent < (config.max ?? Infinity)) await once(); };
Promise.all(Array.from({ length: config.parallel }, loop)).then(() => { fs.writeFileSync('/home/robot/' + config.result, JSON.stringify(out)); });
`;

// B: TURNS turns of REQUESTS_PER_TURN sequential valid chat requests, timed.
const TURN = String.raw`
const http = require('http'); const fs = require('fs');
const config = JSON.parse(process.env.PROBE_CONFIG);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = () => new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const payload = Buffer.from(JSON.stringify({ model: config.id, messages: [{ role: 'user', content: 'Reply with the single word ok.' }], max_tokens: 8 }));
    const req = http.request({ host: '127.0.0.1', port: config.port, method: 'POST', path: '/v1/chat/completions', agent: false, timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': String(payload.length) } }, (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on('error', (error) => resolve({ status: error.code ?? 'ERR', ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.end(payload);
});
(async () => {
    const out = { turns: [], requests: [] };
    for (let turn = 0; turn < config.turns; turn += 1) {
        const started = process.hrtime.bigint();
        for (let index = 0; index < config.perTurn; index += 1) out.requests.push(await request());
        out.turns.push(Number(process.hrtime.bigint() - started) / 1e6);
        if (turn + 1 < config.turns) await pause(config.pauseMs);
    }
    fs.writeFileSync('/home/robot/' + config.result, JSON.stringify(out));
})();
`;

// ---- set up -----------------------------------------------------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mfl-'));
const runtimeRoot = path.join(root, 'runtime');
const alaRoot = path.join(root, 'ala');
fs.mkdirSync(runtimeRoot);
fs.mkdirSync(path.join(root, 'ws'));
fs.mkdirSync(path.join(alaRoot, 'bin'), { recursive: true });
fs.writeFileSync(path.join(alaRoot, 'bin', 'ala.mjs'), ALA_STUB);
const robots = createRobotStore({ root });
const log = () => {};
const view = createProcView({ runtimeRoot });
const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });

const fakeUpstream = {
    async request({ operation }) {
        if (operation === 'models') return { ok: true, status: 200, json: { data: [{ id: 'probe-model' }] } };
        await sleep(40);
        return { ok: true, status: 200, json: { id: 'c', object: 'chat.completion', created: 1, model: 'probe-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    }
};
const upstream = SELF_TEST ? fakeUpstream : createSoulGatewayUpstream({ env: process.env });
let modelId = process.env.MODEL_PROBE_ID ?? (SELF_TEST ? 'probe-model' : null);
if (modelId === null) {
    const catalog = await upstream.request({ operation: 'models', totalTimeoutMs: 15000 });
    modelId = catalog.ok ? (catalog.json?.data?.[0]?.id ?? null) : null;
    if (modelId === null) { process.stderr.write('no usable gateway model; set MODEL_PROBE_ID\n'); process.exit(2); }
}
const foreignId = `${modelId}-foreign-${crypto.randomBytes(3).toString('hex')}`;

const newRobotId = () => crypto.randomBytes(16).toString('base64url');
const robotA = newRobotId();
const robotB = newRobotId();
for (const robotId of [robotA, robotB]) robots.prepare(robotId, { backend: 'opencode', settings: { model: `soul-gateway/${modelId}` } });

const captured = new Map();
const makeLedger = ({ sandbox, layout, executionId }) => {
    const state = { keeper: null };
    const publish = async ({ kind, spec = null }) => {
        const locator = { ...deriveLocator(kind, newLocatorId(), layout), ...(kind === 'keeper' || state.keeper === null ? {} : { keeper: state.keeper }) };
        const resourceId = crypto.randomBytes(16).toString('base64url');
        const created = await sandbox.create({ kind, resourceId, marker: resourceId, locator, spec });
        if (kind === 'keeper') state.keeper = resourceId;
        if (created.gate && (await created.gate.commit()) !== true) throw new Error(`the gate of ${kind} was not committed`);
        return { handle: created.handle, identity: created.identity };
    };
    const ledger = {
        publish,
        startKeeper: () => publish({ kind: 'keeper' }),
        async endExecution() {
            const failures = [];
            for (const [name, step] of [['endProcessTrees', () => sandbox.endProcessTrees()], ['endEndpoint', () => sandbox.endEndpoint()], ['releaseEgress', () => sandbox.releaseEgress()],
                ['releaseViews', () => sandbox.releaseViews()], ['removeRuntime', () => sandbox.removeRuntime()]]) {
                try { await step(); } catch (error) { failures.push(`${name}: ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 120)}`); }
            }
            evidence.endFailures = [...(evidence.endFailures ?? []), ...failures];
            return {};
        }
    };
    captured.set(executionId, ledger);
    return ledger;
};

const factory = createExecutionFactory({
    store: {}, robots, launcher, view, walker: null, clock: { now: () => Date.now(), sleep }, workspaceRoot: path.join(root, 'ws'), runtimeDir: runtimeRoot,
    serverDir: path.join(SOURCE, 'server'), alaRoot, log, modelUpstream: upstream, deps: { createExecutionLedger: makeLedger }
});

const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
async function openExecution(label, robotId) {
    const item = {
        robotId, executionId: `${label}-${crypto.randomBytes(4).toString('hex')}`, attemptId: `${label}-attempt`,
        specification: { version: 2, prompt: 'probe', displayText: 'probe', sessionId: SESSION, turnId: `t${label}`, permissions: 'full-access' }
    };
    const plan = planAlaExecution({ specification: item.specification, workspaceRoot: path.join(root, 'ws') });
    const execution = await factory.open({ item, plan, context: { probe: label }, channels: {}, activity: () => {} });
    return { label, robotId, item, execution };
}

let processNumber = 0;
async function runWorkload(entry, program, config, timeoutMs) {
    const ledger = captured.get(entry.item.executionId);
    processNumber += 1;
    const request = {
        processClass: 'run', executable: process.execPath, args: ['-e', program], env: { PROBE_CONFIG: JSON.stringify({ port: MODEL_RELAY_PORT, ...config }) },
        home: '/home/robot', cwd: '/home/robot', folders: [], exclusions: [], network: 'robot-egress', requirements: { privateProc: true }, communication: { kind: 'streams', stdin: 'ignore' }
    };
    const created = await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: processNumber, request, streams: {} } });
    const exit = await Promise.race([created.handle.wait(), sleep(timeoutMs).then(() => ({ exitCode: 'timeout' }))]);
    const file = path.join(robots.paths(entry.robotId).home, config.result);
    return { exit: exit.exitCode ?? exit.signal ?? null, result: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]; };
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
function summarize(run) {
    const result = run.result;
    if (result === null) return null;
    return {
        exit: run.exit, turnMs: result.turns.map(round), turnMedianMs: round(median(result.turns)), turnMaxMs: round(Math.max(...result.turns)),
        requests: result.requests.length, allOk: result.requests.length === TURNS * REQUESTS_PER_TURN && result.requests.every((entry) => entry.status === 200),
        requestMedianMs: round(median(result.requests.map((entry) => entry.ms))), requestMaxMs: round(Math.max(...result.requests.map((entry) => entry.ms)))
    };
}

// One measured phase: the event-loop histogram and the CPU time of THIS process around `body()`.
async function measured(name, body) {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const cpuBefore = process.cpuUsage();
    const startedAt = Date.now();
    histogram.enable();
    let value;
    try { value = await body(); } finally { histogram.disable(); }
    const cpu = process.cpuUsage(cpuBefore);
    evidence.phases[name] = {
        wallMs: Date.now() - startedAt, supervisorCpuMs: round((cpu.user + cpu.system) / 1000),
        eventLoopDelayMs: { max: round(histogram.max / 1e6), p99: round(histogram.percentile(99) / 1e6), mean: round(histogram.mean / 1e6) }
    };
    return value;
}

// ---- run --------------------------------------------------------------------------------------------------------------------------

let a;
let b;
try {
    if (!process.execPath.startsWith('/usr/')) throw new Error('Node must be under /usr so that the workload sandbox can run it');
    progress('opening A and B (each with its own model channel)');
    [a, b] = await Promise.all([openExecution('A', robotA), openExecution('B', robotB)]);
    await Promise.all([a.execution.start(), b.execution.start()]);
    const turnConfig = (result) => ({ id: modelId, turns: TURNS, perTurn: REQUESTS_PER_TURN, pauseMs: PAUSE_MS, result });
    const turnTimeout = (TURNS * (PAUSE_MS + 60000)) + 60000;

    progress('baseline: B completes its turns while A is idle');
    const baseline = await measured('baseline', () => runWorkload(b, TURN, turnConfig('baseline.json'), turnTimeout));
    evidence.baseline = summarize(baseline);

    progress(`flood: A floods 2 MiB foreign-model bodies for ${FLOOD_SECONDS} s while B completes the same turns`);
    const [flood, floodedTurns] = await measured('flood', () => Promise.all([
        runWorkload(a, FLOOD, { foreign: foreignId, seconds: FLOOD_SECONDS, parallel: 8, result: 'flood.json' }, (FLOOD_SECONDS + 120) * 1000),
        runWorkload(b, TURN, turnConfig('flooded.json'), turnTimeout)
    ]));
    evidence.flooded = summarize(floodedTurns);
    const f = flood.result ?? { sent: 0, statuses: {}, errors: {} };
    evidence.flood = { exit: flood.exit, bodyBytes: f.bodyBytes, sent: f.sent, statuses: f.statuses, errors: f.errors, errorsAfterResponse: f.errorsAfterResponse, errorsWithoutResponse: f.errorsWithoutResponse };

    // Refusals are observable (M-45 review): one client, one request at a time, 2 MiB bodies, right after the flood so that the bucket is empty.
    // Every request must get an answer and none may see a reset, an EPIPE or any other error, through the endpoint's TCP relay.
    progress('serial refusals: one request at a time, none may see a reset');
    await sleep(Number(process.env.MODEL_FLOOD_SETTLE_MS ?? 3000));
    const serial = await runWorkload(a, FLOOD, { foreign: foreignId, seconds: 120, parallel: 1, max: 80, result: 'serial.json' }, 180000);
    const sr = serial.result ?? { sent: 0, statuses: {}, errors: {}, errorsAfterResponse: 0, errorsWithoutResponse: 0 };
    evidence.serial = { exit: serial.exit, sent: sr.sent, statuses: sr.statuses, errors: sr.errors, errorsAfterResponse: sr.errorsAfterResponse, errorsWithoutResponse: sr.errorsWithoutResponse };

    // ---- the verdict
    const answered = Object.values(f.statuses).reduce((sum, count) => sum + count, 0);
    const limited = f.statuses[429] ?? 0;
    const allowance = ADMISSION.burst + ADMISSION.refillPerSecond * (FLOOD_SECONDS + 5);
    check('A flood ran and every request ended in an answer or an error', flood.result !== null && f.sent > 0 && answered + Object.values(f.errors).reduce((sum, count) => sum + count, 0) === f.sent, { sent: f.sent, answered });
    check('the flood met the limits: 429 rate_limited was returned', limited > 0, { limited });
    check('no more bodies were admitted than the bucket allows (burst + rate x time)', answered - limited <= allowance, { admitted: answered - limited, allowance });
    check('serial refusals: 429 rate_limited was answered to at least 20 of 80 requests', serial.result !== null && (sr.statuses[429] ?? 0) >= 20, { statuses: sr.statuses });
    check('serial refusals: no client saw a connection reset or any error, before or after the 429', serial.result !== null && Object.keys(sr.errors).length === 0 && sr.errorsAfterResponse === 0 && sr.errorsWithoutResponse === 0
        && Object.values(sr.statuses).reduce((sum, count) => sum + count, 0) === sr.sent, { sent: sr.sent, errors: sr.errors });
    check('flood: no client saw an error AFTER having received its answer', f.errorsAfterResponse === 0, { errorsAfterResponse: f.errorsAfterResponse, errorsWithoutResponse: f.errorsWithoutResponse, errors: f.errors });
    check('B completed every request with 200 without the flood', evidence.baseline?.allOk === true, { baseline: evidence.baseline });
    check('B completed every request with 200 during the flood', evidence.flooded?.allOk === true, { flooded: evidence.flooded });
    check('B\'s slowest flooded turn is at most 2 s longer than its slowest baseline turn', evidence.baseline && evidence.flooded && evidence.flooded.turnMaxMs <= evidence.baseline.turnMaxMs + 2000,
        { baselineMaxMs: evidence.baseline?.turnMaxMs, floodedMaxMs: evidence.flooded?.turnMaxMs });
    check('the supervisor\'s maximum event-loop delay during the flood stayed under 1000 ms', evidence.phases.flood.eventLoopDelayMs.max < 1000, evidence.phases.flood.eventLoopDelayMs);
} catch (error) {
    evidence.errors.push(`run: ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 200)}`);
} finally {
    for (const entry of [a, b]) {
        if (!entry) continue;
        try { await entry.execution.end({ classification: 'completed', outputText: '', data: null }); } catch (error) { evidence.errors.push(`end ${entry.label}: ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 120)}`); }
    }
}
check('the ledger end paths had no failure', (evidence.endFailures ?? []).length === 0, { failures: evidence.endFailures ?? [] });
fs.rmSync(root, { recursive: true, force: true });
evidence.pass = evidence.errors.length === 0;
process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
process.exit(evidence.pass ? 0 : 1);
