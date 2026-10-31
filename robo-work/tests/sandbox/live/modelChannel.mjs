// Live probe for the Soul Gateway model channel (M-26; acceptance AC-M6, AC-M7, AC-M8). Run as container root in the Box worker as an
// extra process (or in the nested-podman profile, like smoke.mjs), AFTER a fresh deploy of the candidate:
//
//   node /code/tests/sandbox/live/modelChannel.mjs                 # live: the worker's own PLOINKY_AGENT_API_KEY and Router descriptor
//   node /code/tests/sandbox/live/modelChannel.mjs --self-test     # no gateway: a fake upstream and a synthetic key (mechanics only)
//   <key on stdin> | node .../modelChannel.mjs --key-stdin         # the needle to search for is read from stdin, not from the environment
//   node /code/tests/sandbox/live/modelChannel.mjs --watch 600     # scan only: for 600 s sample every process, then scan the worker's data
//                                                                  # directory and the extra paths (run it DURING the AC-M5 e2e turn, so that
//                                                                  # real ALA, the real endpoint and workloads and the real ledger rows are covered)
//
// The needle is the worker's PLOINKY_AGENT_API_KEY. By default it is taken from this process's environment (a `podman exec` into the worker
// container has it); with --key-stdin it is read from stdin instead (for example
// `tr '\000' '\n' < /proc/<worker pid>/environ | sed -n 's/^PLOINKY_AGENT_API_KEY=//p' | node ... --key-stdin`). It is never an argv element and never printed.
//
// Optional environment: MODEL_PROBE_ID (the gateway model id to use; default the first id of the live catalog),
// MODEL_PROBE_PREFIX (the prefix of the stored model of A, default soul-gateway; for example Soul-Gateway),
// MODEL_PROBE_CHAT=0 (no real completion request; the default sends two tiny chat requests through the channel),
// MODEL_PROBE_OPENCODE=1 (also run `opencode run` in A's workload sandbox; on by default in --self-test, off live where AC-M5 is the e2e),
// MODEL_PROBE_SCAN (colon-separated extra files or directories to scan for the key: the worker's state directory, a saved copy of
// `podman logs` of the worker, ...). The state directory ROBO_WORK_DATA_DIR/state (the ledger database) is always scanned when it exists.
//
// It builds TWO executions with the REAL execution factory, supervisor, launcher, network, provider endpoint process, relay and model
// channel (a thin ledger stand-in and a stub in place of ALA; `--watch` is the mode that covers real ALA and the real ledger): A is an OpenCode robot whose model is `soul-gateway/<id>`, B is an OpenCode
// robot on the default model. Both run at the same time. Then:
//
//   AC-M6  the worker's key is searched for as an exact byte string (the needle is read from this process's own environment, never put on
//          an argv, never printed): in /proc/<pid>/environ and /proc/<pid>/cmdline of every process except this one and the worker's own
//          main process, sampled every 5 ms during the whole run (so the short-lived prep and stage processes of every sandbox launch,
//          the endpoint, the ALA stub and the workloads are all covered); in the robot HOMEs, session and config directories, the whole
//          runtime directory and the files the stub and workloads wrote; in the ledger database and any MODEL_PROBE_SCAN path; and in the
//          log lines this run produced. Only counts are printed. The processes of THIS run are the stub and a thin ledger stand-in; real ALA
//          and the real ledger rows are covered by `--watch` during a real turn. The scan counters (processes in sandbox PID namespaces, files) must be
//          positive, so a zero cannot come from scanning nothing. Scope: processes in a PID namespace other than the worker's own plus the
//          prep and stage processes (stage.sh, sandboxPrep.mjs on their command line); the worker container's own processes are skipped
//          and counted. The number of sandbox processes sampled is printed and must be > 0.
//   AC-M7  a workload of B (default model, running at the same time as A) connects to 127.0.0.1:<relay port> with node (not curl) and
//          gets a connection error, not a status; its channels directory has no model.sock and /run/robo-work/model does not exist.
//   AC-M8  in A's workload: a POST with another model id returns 403; GET /v1/models lists exactly the one model; `?x=1`,
//          /v1/embeddings and a GET on the chat route are 404; a request carrying a workload-chosen Authorization and X-Ploinky-* headers is
//          served (200) with the worker's identity, not the workload's; no model.sock exists in the workload's channels directory or at
//          /run/robo-work/model, and the ALA stub (orchestration domain) cannot open either socket path or reach the relay port.
//
// Prints ONE JSON document of facts (codes, statuses, counts) on stdout; progress goes to stderr. Exit 0 only when every check held.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createProcView } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionFactory, readManagedConfig } from '../../../server/runtime/executionFactory.mjs';
import { MODEL_RELAY_PORT, createSoulGatewayUpstream, selectGatewayProvider } from '../../../server/runtime/modelChannel.mjs';
import { planAlaExecution } from '../../../server/runtime/alaPlan.mjs';
import { createRobotStore } from '../../../server/runtime/robotStore.mjs';
import { createExecutionSupervisor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

const SOURCE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SELF_TEST = process.argv.includes('--self-test');
const WANT_CHAT = process.env.MODEL_PROBE_CHAT !== '0';
const evidence = { mode: SELF_TEST ? 'self-test' : 'live', checks: {}, scan: {}, errors: [] };
const progress = (text) => process.stderr.write(`[modelChannel] ${text}\n`);
const check = (name, ok, extra = {}) => { evidence.checks[name] = { ok: ok === true, ...extra }; if (ok !== true) evidence.errors.push(name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY_FROM_STDIN = process.argv.includes('--key-stdin');
const WATCH_INDEX = process.argv.indexOf('--watch');
const WATCH_SECONDS = WATCH_INDEX === -1 ? null : Number(process.argv[WATCH_INDEX + 1]);
if (WATCH_SECONDS !== null && !(WATCH_SECONDS >= 1 && WATCH_SECONDS <= 86400)) { process.stderr.write('--watch needs a number of seconds from 1 to 86400\n'); process.exit(2); }
if (SELF_TEST) process.env.PLOINKY_AGENT_API_KEY = `selftest-${crypto.randomBytes(24).toString('hex')}`;
// The needle lives only in this process's memory.
const NEEDLE = Buffer.from(KEY_FROM_STDIN && !SELF_TEST ? fs.readFileSync(0, 'utf8').replace(/\r?\n$/u, '') : (process.env.PLOINKY_AGENT_API_KEY ?? ''), 'utf8');
if (NEEDLE.length < 16) { process.stderr.write('the key to search for is missing or too short (environment PLOINKY_AGENT_API_KEY, or stdin with --key-stdin)\n'); process.exit(2); }

// ---- the programs that run inside the sandboxes ---------------------------------------------------------------------------------

// The ALA stub: probes the orchestration domain, writes its facts to the session directory and idles (like ALA, until it is stopped).
const ALA_STUB = String.raw`
import fs from 'node:fs';
import net from 'node:net';
const out = { env: { OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? null } };
const code = (fn) => { try { fn(); return 'OK'; } catch (error) { return error.code ?? 'ERR'; } };
out.channels = (() => { try { return fs.readdirSync('/run/robo-work/channels').sort(); } catch (error) { return error.code; } })();
out.modelDir = (() => { try { return fs.readdirSync('/run/robo-work/model'); } catch (error) { return error.code; } })();
const tries = [];
for (const target of ['/run/robo-work/model/model.sock', '/run/robo-work/channels/model.sock']) {
    tries.push(new Promise((resolve) => { const socket = net.connect(target); socket.once('connect', () => { socket.destroy(); resolve([target, 'CONNECTED']); }); socket.once('error', (error) => resolve([target, error.code])); }));
}
tries.push(new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: ${MODEL_RELAY_PORT}, timeout: 2000 });
    socket.once('connect', () => { socket.destroy(); resolve(['tcp', 'CONNECTED']); });
    socket.once('timeout', () => { socket.destroy(); resolve(['tcp', 'ETIMEDOUT']); });
    socket.once('error', (error) => resolve(['tcp', error.code]));
}));
out.connect = Object.fromEntries(await Promise.all(tries));
out.fds = fs.readdirSync('/proc/self/fd').length;
fs.writeFileSync('/session/ala-probe.json', JSON.stringify(out));
setInterval(() => {}, 1e6);
`;

// The workload probe (node, in the workload sandbox). PROBE_CONFIG: { port, id, other, chat }.
const WORKLOAD = String.raw`
const fs = require('fs'); const http = require('http'); const net = require('net');
const config = JSON.parse(process.env.PROBE_CONFIG);
const out = { role: config.role, opencodeConfigEnv: process.env.OPENCODE_CONFIG ?? null };
const list = (dir) => { try { return fs.readdirSync(dir).sort(); } catch (error) { return error.code; } };
out.channels = list('/run/robo-work/channels');
out.modelDir = list('/run/robo-work/model');
const request = (method, url, headers, body) => new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: config.port, method, path: url, timeout: 120000, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}), ...headers } }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* text */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (error) => resolve({ error: error.code ?? 'ERR' }));
    req.end(payload ?? undefined);
});
const direct = (target) => new Promise((resolve) => { const socket = net.connect(target); socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); }); socket.once('error', (error) => resolve(error.code)); });
(async () => {
    out.direct = { model: await direct('/run/robo-work/model/model.sock'), channels: await direct('/run/robo-work/channels/model.sock') };
    const models = await request('GET', '/v1/models', {});
    out.models = models.error ? { error: models.error } : { status: models.status, ids: (models.json?.data ?? []).map((entry) => entry.id) };
    if (config.role === 'A') {
        try {
            const file = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
            const provider = file.provider[config.providerId];
            out.config = { providers: Object.keys(file.provider), npm: provider.npm, baseURL: provider.options.baseURL, apiKeyIsPlaceholder: provider.options.apiKey === 'robo-work', timeout: provider.options.timeout, models: Object.keys(provider.models) };
        } catch (error) { out.config = { error: error.code ?? 'ERR' }; }
        const chat = (model, headers, extra = {}) => request('POST', '/v1/chat/completions', headers, { model, messages: [{ role: 'user', content: 'Reply with the single word ok.' }], max_tokens: 8, ...extra });
        out.otherModel = (await chat(config.other, {})).status;
        out.otherModelPrefixed = (await chat('soul-gateway/' + config.other, {})).status;
        out.query = (await request('GET', '/v1/models?x=1', {})).status;
        out.embeddings = (await request('POST', '/v1/embeddings', {}, { model: config.id, input: 'x' })).status;
        out.chatGet = (await request('GET', '/v1/chat/completions', {})).status;
        out.chatQuery = (await request('POST', '/v1/chat/completions?x=1', {}, { model: config.id, messages: [] })).status;
        if (config.chat) {
            const plain = await chat(config.id, {});
            out.chat = { status: plain.status ?? plain.error, hasChoices: Array.isArray(plain.json?.choices) };
            const withHeaders = await chat(config.id, { authorization: 'Bearer workload-chosen', 'x-ploinky-agent': 'agent:evil/other', 'x-ploinky-authority-probe': '1' });
            out.chatWithForeignHeaders = { status: withHeaders.status ?? withHeaders.error, hasChoices: Array.isArray(withHeaders.json?.choices) };
        }
    } else {
        out.relay = await new Promise((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port: config.port, timeout: 3000 });
            socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); });
            socket.once('timeout', () => { socket.destroy(); resolve('ETIMEDOUT'); });
            socket.once('error', (error) => resolve(error.code ?? 'ERR'));
        });
    }
    fs.writeFileSync('/home/robot/probe.json', JSON.stringify(out));
})();
`;

// ---- the key scanners -----------------------------------------------------------------------------------------------------------

const countIn = (buffer) => {
    let count = 0;
    for (let at = buffer.indexOf(NEEDLE); at !== -1; at = buffer.indexOf(NEEDLE, at + NEEDLE.length)) count += 1;
    return count;
};

// Occurrences of the key in a file, read in chunks with an overlap (no sockets, no devices, no symlinks followed).
function scanFile(file) {
    let descriptor;
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) return null;
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch { return null; }
    let matches = 0;
    try {
        const chunk = Buffer.alloc(1 << 20);
        let tail = Buffer.alloc(0);
        for (;;) {
            const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (read === 0) break;
            const window = Buffer.concat([tail, chunk.subarray(0, read)]);
            matches += countIn(window) - countIn(tail);
            tail = window.subarray(Math.max(0, window.length - NEEDLE.length + 1));
        }
    } catch { /* unreadable: not scanned */ } finally { fs.closeSync(descriptor); }
    return matches;
}

function scanTree(target, tally) {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
        let names = [];
        try { names = fs.readdirSync(target); } catch { return; }
        for (const name of names) scanTree(path.join(target, name), tally);
        return;
    }
    const matches = scanFile(target);
    if (matches !== null) { tally.files += 1; tally.matches += matches; }
}

const selfNs = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return null; } })();
const newTally = () => ({ samples: 0, pids: new Set(), sandboxPids: new Set(), stagePids: new Set(), environMatches: 0, cmdlineMatches: 0, matchedPids: new Set(), matchedComms: new Set() });
const processTally = newTally();
const workerPids = new Set();
function sampleProcesses(tally = processTally, only = null) {
    let names = [];
    try { names = only === null ? fs.readdirSync('/proc').filter((name) => /^[0-9]+$/u.test(name)) : [String(only)]; } catch { return; }
    tally.samples += 1;
    for (const name of names) {
        const pid = Number(name);
        if (pid === process.pid || workerPids.has(pid)) continue;
        let cmdline = null;
        try { cmdline = fs.readFileSync(`/proc/${name}/cmdline`); } catch { continue; }
        if (only === null && cmdline.includes('server/main.mjs')) { workerPids.add(pid); continue; }
        // AC-M6 scope (M-43(b), M-47): the processes that could hold or receive the worker's key are the SANDBOX processes (a pid namespace
        // other than the worker's own: endpoint, ALA, workloads) and the marker-carrying PREP and STAGE processes of every launch (setpriv,
        // nsenter, unshare, stage.sh, node sandboxPrep.mjs; they run in the worker's pid namespace). The worker container's own processes
        // (podman-init, the entrypoint, RuntimeHttpRelay, the main process's children) are not the subject and are not counted, so they can
        // neither hide a leak behind a large number nor create a false match. A positive control (`only`) is always scanned.
        let sandbox = false;
        try { sandbox = fs.readlinkSync(`/proc/${name}/ns/pid`) !== selfNs; } catch { continue; /* gone */ }
        const prepOrStage = cmdline.includes('stage.sh') || cmdline.includes('sandboxPrep.mjs');
        if (only === null && !sandbox && !prepOrStage) { tally.skippedContainerLevel = (tally.skippedContainerLevel ?? 0) + 1; continue; }
        tally.pids.add(pid);
        if (prepOrStage) tally.stagePids.add(pid);
        if (sandbox) tally.sandboxPids.add(pid);
        const noteMatch = () => { tally.matchedPids.add(pid); try { tally.matchedComms.add(fs.readFileSync(`/proc/${name}/comm`, 'utf8').trim().slice(0, 24)); } catch { /* gone */ } };
        const found = countIn(cmdline);
        if (found) { tally.cmdlineMatches += found; noteMatch(); }
        try {
            const hits = countIn(fs.readFileSync(`/proc/${name}/environ`));
            if (hits) { tally.environMatches += hits; noteMatch(); }
        } catch { /* gone or unreadable */ }
    }
}

// Positive controls, so that a count of zero cannot come from a scanner that finds nothing: a child that holds the key in its environment
// (never on its argv) and a file that contains it, in a directory outside the scanned tree.
async function positiveControls(controlDirectory) {
    const child = spawn('sleep', ['30'], { env: { PATH: process.env.PATH, CONTROL_KEY: NEEDLE.toString('utf8') }, stdio: 'ignore' });
    await sleep(100);
    const tally = newTally();
    sampleProcesses(tally, child.pid);
    child.kill('SIGKILL');
    fs.writeFileSync(path.join(controlDirectory, 'control.txt'), Buffer.concat([Buffer.from('prefix '), NEEDLE, Buffer.from(' suffix')]));
    const files = { files: 0, matches: 0 };
    scanTree(controlDirectory, files);
    return { environ: tally.environMatches, cmdline: tally.cmdlineMatches, file: files.matches };
}

// ---- --watch: scan only, during a real turn ------------------------------------------------------------------------------------
if (WATCH_SECONDS !== null) {
    const watchEvidence = { mode: 'watch', seconds: WATCH_SECONDS, checks: {}, errors: [] };
    const watchCheck = (name, ok, extra = {}) => { watchEvidence.checks[name] = { ok: ok === true, ...extra }; if (ok !== true) watchEvidence.errors.push(name); };
    const watchControlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mcp-control-'));
    watchEvidence.controls = await positiveControls(watchControlDirectory);
    fs.rmSync(watchControlDirectory, { recursive: true, force: true });
    watchCheck('M6 the scanners detect a planted key (positive controls: environ, file)', watchEvidence.controls.environ === 1 && watchEvidence.controls.file === 1 && watchEvidence.controls.cmdline === 0, watchEvidence.controls);
    const watchTimer = setInterval(() => sampleProcesses(), 5);
    await sleep(WATCH_SECONDS * 1000);
    clearInterval(watchTimer);
    sampleProcesses();
    const dataDirectory = process.env.ROBO_WORK_DATA_DIR || '/var/lib/robo-work';
    const tallies = [];
    for (const target of [dataDirectory, ...String(process.env.MODEL_PROBE_SCAN ?? '').split(':').filter(Boolean)]) { const tally = { files: 0, matches: 0 }; scanTree(target, tally); tallies.push(tally); }
    const stored = tallies.reduce((sum, tally) => ({ files: sum.files + tally.files, matches: sum.matches + tally.matches }), { files: 0, matches: 0 });
    watchEvidence.scan = {
        samples: processTally.samples, processesScanned: processTally.pids.size, sandboxProcessesScanned: processTally.sandboxPids.size, stagePrepProcessesScanned: processTally.stagePids.size,
        processEnvironMatches: processTally.environMatches, processCmdlineMatches: processTally.cmdlineMatches, matchedProcesses: processTally.matchedPids.size,
        matchedProcessNames: [...processTally.matchedComms], filesScanned: stored.files, fileMatches: stored.matches, workerMainProcessesExcluded: workerPids.size,
        containerLevelProcessSamplesSkipped: processTally.skippedContainerLevel ?? 0
    };
    watchCheck('M6 no process environ or cmdline held the key during the watch', processTally.environMatches === 0 && processTally.cmdlineMatches === 0 && processTally.sandboxPids.size > 0,
        { sandboxProcessesScanned: processTally.sandboxPids.size });
    watchCheck('M6 no file of the data directory or the extra paths holds the key (robot homes, sessions, runtime, ledger database, saved logs)', stored.matches === 0 && stored.files > 0, { filesScanned: stored.files });
    watchEvidence.pass = watchEvidence.errors.length === 0;
    process.stdout.write(`${JSON.stringify(watchEvidence, null, 1)}\n`);
    process.exit(watchEvidence.pass ? 0 : 1);
}

// ---- set up -----------------------------------------------------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mcp-'));
const runtimeRoot = path.join(root, 'runtime');
const alaRoot = path.join(root, 'ala');
fs.mkdirSync(runtimeRoot);
fs.mkdirSync(path.join(root, 'ws'));
fs.mkdirSync(path.join(alaRoot, 'bin'), { recursive: true });
fs.writeFileSync(path.join(alaRoot, 'bin', 'ala.mjs'), ALA_STUB);
const robots = createRobotStore({ root });
const logLines = [];
const log = (event, fields = {}) => logLines.push(JSON.stringify({ event, ...fields }));
const view = createProcView({ runtimeRoot });
const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });

const fakeUpstream = {
    async request({ operation }) {
        if (operation === 'models') return { ok: true, status: 200, json: { data: [{ id: 'probe-model' }, { id: 'probe-other' }] } };
        return { ok: true, status: 200, json: { id: 'c', object: 'chat.completion', created: 1, model: 'probe-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    }
};
const upstream = SELF_TEST ? fakeUpstream : createSoulGatewayUpstream({ env: process.env });

let modelId = process.env.MODEL_PROBE_ID ?? null;
if (modelId === null) {
    const catalog = await upstream.request({ operation: 'models', totalTimeoutMs: 15000 });
    modelId = catalog.ok ? (catalog.json?.data?.[0]?.id ?? null) : null;
    if (modelId === null) { process.stderr.write(`no usable gateway model (catalog status ${catalog.status ?? 'none'}); set MODEL_PROBE_ID\n`); process.exit(2); }
}
evidence.model = SELF_TEST ? 'probe-model' : '(live catalog model)';
const otherId = `${modelId}-not-allowed-${crypto.randomBytes(3).toString('hex')}`;

const newRobotId = () => crypto.randomBytes(16).toString('base64url');
const robotA = newRobotId();
const robotB = newRobotId();
// MODEL_PROBE_PREFIX (default soul-gateway) is the prefix of the stored model: a case variant checks that the channel's provider follows it.
const storedPrefix = process.env.MODEL_PROBE_PREFIX || 'soul-gateway';
robots.prepare(robotA, { backend: 'opencode', settings: { model: `${storedPrefix}/${modelId}` } });
const expectedProvider = selectGatewayProvider({ specification: {}, managed: readManagedConfig(robots.paths(robotA).config) });
robots.prepare(robotB, { backend: 'opencode', settings: { model: 'opencode/glm-5.3-flash-free' } });

const captured = new Map(); // executionId -> ledger
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
        // The ledger's end order (section 5.5): process trees, endpoint, egress, views, runtime directory (which also ends the anchor).
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
    serverDir: path.join(SOURCE, 'server'), alaRoot, log, modelUpstream: upstream,
    deps: { createExecutionLedger: makeLedger }
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

async function runWorkload(entry, role, config) {
    const ledger = captured.get(entry.item.executionId);
    const request = {
        processClass: 'run', executable: process.execPath, args: ['-e', WORKLOAD], env: { PROBE_CONFIG: JSON.stringify({ role, port: MODEL_RELAY_PORT, ...config }) },
        home: '/home/robot', cwd: '/home/robot', folders: [], exclusions: [], network: 'robot-egress', requirements: { privateProc: true }, communication: { kind: 'streams', stdin: 'ignore' }
    };
    const created = await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: 1, request, streams: {} } });
    const exit = await Promise.race([created.handle.wait(), sleep(240000).then(() => ({ exitCode: 'timeout' }))]);
    const file = path.join(robots.paths(entry.robotId).home, 'probe.json');
    return { exit: exit.exitCode ?? exit.signal ?? null, result: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

// OpenCode itself in A's workload sandbox, with the OPENCODE_CONFIG the supervisor sets: one tiny turn through the relay and the channel.
// Only the exit code and the size of what it printed are reported (and, in the self-test, whether the fake answer arrived).
async function runOpenCode(entry, id) {
    const ledger = captured.get(entry.item.executionId);
    const script = `opencode run -m ${expectedProvider}/${id} 'Reply with the single word ok.' > /home/robot/opencode.out 2>&1; echo $? > /home/robot/opencode.exit`;
    const request = {
        processClass: 'run', executable: '/bin/sh', args: ['-c', script], env: {}, home: '/home/robot', cwd: '/home/robot', folders: [], exclusions: [],
        network: 'robot-egress', requirements: { privateProc: true }, communication: { kind: 'streams', stdin: 'ignore' }
    };
    const created = await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: 2, request, streams: {} } });
    const exit = await Promise.race([created.handle.wait(), sleep(180000).then(() => ({ exitCode: 'timeout' }))]);
    const home = robots.paths(entry.robotId).home;
    const read = (name) => { try { return fs.readFileSync(path.join(home, name), 'utf8'); } catch { return null; } };
    const printed = read('opencode.out');
    return { shellExit: exit.exitCode ?? exit.signal ?? null, opencodeExit: Number(String(read('opencode.exit') ?? '').trim()), printedBytes: printed === null ? null : Buffer.byteLength(printed), answered: SELF_TEST ? /\bok\b/u.test(printed ?? '') : undefined };
}

// ---- run --------------------------------------------------------------------------------------------------------------------------

if (!process.execPath.startsWith('/usr/')) { process.stderr.write('Node must be under /usr so that the workload sandbox can run it\n'); process.exit(2); }
const controlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mcp-control-'));
evidence.controls = await positiveControls(controlDirectory);
fs.rmSync(controlDirectory, { recursive: true, force: true });
check('M6 the scanners detect a planted key (positive controls: environ, file)', evidence.controls.environ === 1 && evidence.controls.file === 1 && evidence.controls.cmdline === 0, evidence.controls);
const sampler = setInterval(() => sampleProcesses(), 5);
sampler.unref();
let a;
let b;
try {
    progress('opening A (gateway model) and B (default model) at the same time');
    [a, b] = await Promise.all([openExecution('A', robotA), openExecution('B', robotB)]);
    // The model channel and the endpoint of A come up inside start(); B starts without any.
    await Promise.all([a.execution.start(), b.execution.start()]);
    progress('both executions are running');
    const [runA, runB] = await Promise.all([
        runWorkload(a, 'A', { id: modelId, other: otherId, chat: WANT_CHAT, providerId: expectedProvider }),
        runWorkload(b, 'B', { id: modelId, other: otherId, chat: false })
    ]);
    evidence.workloadExit = { A: runA.exit, B: runB.exit };
    const ala = (robotId) => { const file = path.join(robots.paths(robotId).sessions, 'ala-probe.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; };
    // The stub writes its facts as soon as it starts; give it a moment if the workloads were quicker.
    for (let wait = 0; wait < 100 && (ala(robotA) === null || ala(robotB) === null); wait += 1) await sleep(100);
    const stubA = ala(robotA);
    const stubB = ala(robotB);

    // AC-M8: execution A.
    const A = runA.result ?? {};
    evidence.A = A;
    check('M8 workload A ran', runA.result !== null && runA.exit === 0, { exit: runA.exit });
    check('M8 OPENCODE_CONFIG points at the generated file', A.opencodeConfigEnv === '/run/robo-work/channels/opencode.json');
    check('M8 the generated config has one provider, one model and a placeholder key', JSON.stringify(A.config?.providers) === JSON.stringify([expectedProvider]) && A.config?.models?.length === 1
        && A.config?.apiKeyIsPlaceholder === true && A.config?.timeout >= 510000 && A.config?.baseURL === `http://127.0.0.1:${MODEL_RELAY_PORT}/v1`);
    check('M8 GET /v1/models lists exactly the allowed model', A.models?.status === 200 && A.models?.ids?.length === 1);
    check('M8 a POST with another model is 403', A.otherModel === 403 && A.otherModelPrefixed === 403, { plain: A.otherModel, prefixed: A.otherModelPrefixed });
    check('M8 other routes are 404 (query string, embeddings, GET on chat, query on chat)', A.query === 404 && A.embeddings === 404 && A.chatGet === 404 && A.chatQuery === 404,
        { query: A.query, embeddings: A.embeddings, chatGet: A.chatGet, chatQuery: A.chatQuery });
    if (WANT_CHAT) {
        check('M8 a real completion goes through the channel (200 with choices)', A.chat?.status === 200 && A.chat?.hasChoices === true, { status: A.chat?.status });
        check('M8 a request with workload-chosen Authorization and X-Ploinky-* headers is served with the worker identity (200)', A.chatWithForeignHeaders?.status === 200 && A.chatWithForeignHeaders?.hasChoices === true,
            { status: A.chatWithForeignHeaders?.status });
    }
    check('M8 the workload has no path to model.sock', A.direct?.model === 'ENOENT' && A.direct?.channels === 'ENOENT' && Array.isArray(A.channels) && !A.channels.includes('model.sock') && A.modelDir === 'ENOENT',
        { direct: A.direct, channels: A.channels, modelDir: A.modelDir });
    check('M8 the ALA stub (orchestration domain) cannot open either socket path or reach the relay port',
        stubA !== null && stubA.connect?.['/run/robo-work/model/model.sock'] === 'ENOENT' && stubA.connect?.['/run/robo-work/channels/model.sock'] === 'ENOENT' && stubA.connect?.tcp !== 'CONNECTED'
        && stubA.modelDir === 'ENOENT' && Array.isArray(stubA.channels) && !stubA.channels.includes('model.sock') && stubA.env?.OPENCODE_CONFIG === null,
        { stub: stubA });

    // AC-M7: execution B, running at the same time.
    const B = runB.result ?? {};
    evidence.B = B;
    check('M7 workload B ran', runB.result !== null && runB.exit === 0, { exit: runB.exit });
    check('M7 B cannot reach the relay port (a connection error, not a status)', typeof B.relay === 'string' && B.relay !== 'CONNECTED' && B.models?.error !== undefined, { relay: B.relay, models: B.models });
    check('M7 B has no model.sock, no model directory and no OPENCODE_CONFIG', Array.isArray(B.channels) && !B.channels.includes('model.sock') && B.modelDir === 'ENOENT' && B.opencodeConfigEnv === null,
        { channels: B.channels, modelDir: B.modelDir });
    check('M7 the ALA stub of B has no path either', stubB !== null && stubB.connect?.tcp !== 'CONNECTED' && stubB.modelDir === 'ENOENT', { stub: stubB });

    if (process.env.MODEL_PROBE_OPENCODE === '1' || (SELF_TEST && process.env.MODEL_PROBE_OPENCODE !== '0')) {
        progress('running opencode in A\'s workload sandbox');
        evidence.opencode = await runOpenCode(a, modelId);
        check('M8 OpenCode 1.19.5 completes a turn through OPENCODE_CONFIG, the relay and the channel', evidence.opencode.opencodeExit === 0 && evidence.opencode.printedBytes > 0 && (!SELF_TEST || evidence.opencode.answered === true), evidence.opencode);
    }
    // The sandboxed processes were really sampled before anything is concluded.
    await sleep(200);
    for (const entry of [a, b]) evidence[`runtime${entry.label}`] = fs.existsSync(path.join(runtimeRoot, 'x')) ? fs.readdirSync(path.join(runtimeRoot, 'x')).length : 0;
} catch (error) {
    evidence.errors.push(`run: ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 200)}`);
} finally {
    for (const entry of [a, b]) {
        if (!entry) continue;
        try { await entry.execution.end({ classification: 'completed', outputText: '', data: null }); } catch (error) { evidence.errors.push(`end ${entry.label}: ${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 120)}`); }
    }
}

// ---- AC-M6: the key scan ----------------------------------------------------------------------------------------------------------

sampleProcesses();
clearInterval(sampler);
const files = { files: 0, matches: 0 };
scanTree(root, files);
const extra = [path.join(process.env.ROBO_WORK_DATA_DIR || '/var/lib/robo-work', 'state'), ...String(process.env.MODEL_PROBE_SCAN ?? '').split(':').filter(Boolean)];
const extraTally = { files: 0, matches: 0 };
for (const target of extra) scanTree(target, extraTally);
const logMatches = logLines.reduce((sum, line) => sum + countIn(Buffer.from(line, 'utf8')), 0);
evidence.scan = {
    samples: processTally.samples, processesScanned: processTally.pids.size, sandboxProcessesScanned: processTally.sandboxPids.size, stagePrepProcessesScanned: processTally.stagePids.size,
    processEnvironMatches: processTally.environMatches, processCmdlineMatches: processTally.cmdlineMatches, matchedProcesses: processTally.matchedPids.size, matchedProcessNames: [...processTally.matchedComms],
    storeFilesScanned: files.files, storeFileMatches: files.matches, extraFilesScanned: extraTally.files, extraFileMatches: extraTally.matches,
    extraTargets: extra.length, logLines: logLines.length, logMatches, workerMainProcessesExcluded: workerPids.size,
    containerLevelProcessSamplesSkipped: processTally.skippedContainerLevel ?? 0
};
check('M6 no process environ or cmdline holds the key (endpoint, ALA stub, workloads, prep and stage processes of every launch)',
    processTally.environMatches === 0 && processTally.cmdlineMatches === 0 && processTally.sandboxPids.size >= 6, { sandboxProcessesScanned: processTally.sandboxPids.size });
check('M6 prep and stage processes of the sandbox launches were sampled (stage.sh on their command line)', processTally.stagePids.size > 0, { stagePrepProcessesScanned: processTally.stagePids.size });
check('M6 no HOME, session, config or runtime file holds the key', files.matches === 0 && files.files > 0, { filesScanned: files.files });
check('M6 the ledger database and the extra paths hold no key', extraTally.matches === 0);
check('M6 this run\'s own log lines hold no key', logMatches === 0 && logLines.length > 0, { logLines: logLines.length });

// Cleanup: nothing of the executions is left.
const leftovers = view.listProcesses().filter((entry) => entry.pid !== process.pid && entry.cmdline.some((part) => String(part).includes('/opt/robo-work/') || String(part).includes('PROBE_CONFIG'))).length;
check('every sandbox process of the run is gone', leftovers === 0, { leftovers });
check('both execution runtime directories are gone', !fs.existsSync(path.join(runtimeRoot, 'x')) || fs.readdirSync(path.join(runtimeRoot, 'x')).length === 0);
check('the ledger end paths had no failure', (evidence.endFailures ?? []).length === 0, { failures: evidence.endFailures ?? [] });
fs.rmSync(root, { recursive: true, force: true });
evidence.pass = evidence.errors.length === 0;
process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
process.exit(evidence.pass ? 0 : 1);
