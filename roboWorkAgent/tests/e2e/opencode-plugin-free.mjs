#!/usr/bin/env node
// Live probe: OpenCode 2 starts in a home with no plugin dependency tree, loads a plugin that imports the modules the host provides
// (`@opencode/plugin`, `effect`), and creates no tree of its own. Dependency-free, so the file also runs alone from a container's /tmp.
//
//   node opencode-plugin-free.mjs --binary <opencode> [--offline] [--keep] [--timeout-ms <n>] [--record-wait-ms <n>]
//
// Prints exactly one line `ROBOWORK_OPENCODE_PLUGIN_FREE_V1 <json>` and exits 0 only when every check passed; any failure prints its
// reason (and the raw evidence) to stderr, prints no sentinel and exits non-zero.
//
// `--offline` re-runs this script inside `unshare -rn`: a new user and network namespace that has no interface and no route. A new
// network namespace starts with its loopback down, so the script raises `lo` itself (`ip` or `ifconfig`) and then asserts that
// no non-loopback interface exists and that a connect to a documentation address is refused with no route, before it starts the
// server. When `unshare`, loopback setup or the isolation assertion is unavailable the probe fails; it never falls back to a run
// with network.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SENTINEL = 'ROBOWORK_OPENCODE_PLUGIN_FREE_V1';
export const RECORDER_ID = 'robowork.opencode-plugin-free-recorder';
export const RECORDER_FILE = 'robowork-plugin-free-recorder.js';
// Files whose appearance under `.config/opencode` means something installed or generated a dependency tree.
export const TREE_NAMES = Object.freeze(['node_modules', 'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb']);
const STRIPPED_ENV = /^(?:OPENCODE_|XDG_|HOME$|OLDPWD$|PWD$|npm_)/u;
const KEPT_ENV = /^(?:PATH|LANG|LC_[A-Z]+|TERM|TMPDIR|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy)$/u;

// An OpenCode 2 default-export plugin. Its `setup` makes the one import RoboWork's own plugin depends on
// (`server/plugins/soul-gateway.js` imports `Model` and `Provider` from `@opencode/plugin`) plus one from `effect`, and records
// whether each export is present and works. The record lives in the scratch home, outside `.config/opencode`.
export const recorderSource = recordFile => `export default { id: ${JSON.stringify(RECORDER_ID)}, async setup(ctx) {
    const fs = await import('node:fs');
    const record = { id: ${JSON.stringify(RECORDER_ID)}, pid: process.pid, at: new Date().toISOString(), plugin: { imported: false }, effect: { imported: false } };
    const attempt = (target, name, work) => { try { target[name] = work() === true; } catch (error) { target[name] = false; target[name + 'Error'] = String(error?.message || error).slice(0, 200); } };
    try {
        const { Model, Provider } = await import('@opencode/plugin');
        record.plugin.imported = true;
        attempt(record.plugin, 'providerId', () => typeof Provider.ID.make('probe') !== 'undefined');
        attempt(record.plugin, 'providerInfo', () => typeof Provider.Info.empty(Provider.ID.make('probe')) === 'object');
        attempt(record.plugin, 'modelId', () => typeof Model.ID.make('probe') !== 'undefined');
        attempt(record.plugin, 'modelInfo', () => typeof Model.Info.default(Provider.ID.make('probe'), Model.ID.make('probe')) === 'object');
    } catch (error) { record.plugin.error = String(error?.message || error).slice(0, 200); }
    try {
        const { Effect } = await import('effect');
        record.effect.imported = true;
        attempt(record.effect, 'succeed', () => typeof Effect.succeed === 'function' && typeof Effect.succeed(42) === 'object');
        attempt(record.effect, 'runSync', () => typeof Effect.runSync !== 'function' || Effect.runSync(Effect.succeed(42)) === 42);
    } catch (error) { record.effect.error = String(error?.message || error).slice(0, 200); }
    fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(record) + '\\n');
    return () => {};
} };
`;

const fail = message => Object.assign(new Error(message), { probeFailure: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A timer that only takes part in a race must not keep the process alive after the race is decided.
const after = ms => new Promise(resolve => setTimeout(resolve, ms).unref());
const active = { server: undefined, home: undefined, keep: false };

export function parseArguments(argv) {
    const options = { offline: false, keep: false, inNetns: false, timeoutMs: 120000, recordWaitMs: 15000 };
    const numeric = (name, value) => {
        if (!/^[1-9]\d{0,7}$/u.test(value ?? '')) throw fail(`${name} needs a positive integer`);
        return Number(value);
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--binary') options.binary = argv[++index];
        else if (argument === '--offline') options.offline = true;
        else if (argument === '--keep') options.keep = true;
        else if (argument === '--in-netns') options.inNetns = true;
        else if (argument === '--timeout-ms') options.timeoutMs = numeric(argument, argv[++index]);
        else if (argument === '--record-wait-ms') options.recordWaitMs = numeric(argument, argv[++index]);
        else throw fail(`Unknown argument ${argument}`);
    }
    if (!options.binary || !path.isAbsolute(options.binary)) throw fail('--binary needs an absolute path to the opencode executable');
    return options;
}

// ---- offline: a namespace with no route -----------------------------------------------------------------------------------

function offlineCommand(options) {
    if (process.platform !== 'linux') throw fail(`--offline needs Linux and unshare; this host is ${process.platform}`);
    const check = spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8' });
    if (check.error || check.status !== 0) {
        throw fail(`--offline needs "unshare -rn" (user and network namespaces), which is unavailable: ${check.error?.message || check.stderr.trim() || `exit ${check.status}`}`);
    }
    const forwarded = process.argv.slice(2).filter(argument => argument !== '--in-netns');
    return { command: 'unshare', args: ['-rn', '--', process.execPath, fileURLToPath(import.meta.url), ...forwarded, '--in-netns'], options };
}

async function assertNoNetwork() {
    const lo = [['ip', ['link', 'set', 'lo', 'up']], ['ifconfig', ['lo', 'up']]]
        .map(([command, args]) => spawnSync(command, args, { encoding: 'utf8' }));
    if (!lo.some(result => !result.error && result.status === 0)) {
        throw fail(`Loopback could not be raised inside the network namespace (ip and ifconfig both failed: ${lo.map(result => result.error?.message || result.stderr.trim()).join('; ')})`);
    }
    const external = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter(entry => !entry.internal).map(() => name));
    if (external.length) throw fail(`The namespace still has a non-loopback interface: ${[...new Set(external)].join(', ')}`);
    // 192.0.2.1 is a documentation address. With no interface and no route the connect is refused at once; success or a stall means a path exists.
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '192.0.2.1', port: 9 });
        const timer = setTimeout(() => { socket.destroy(); reject(fail('A connect to 192.0.2.1 did not fail at once, so the namespace may have a route')); }, 3000);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(fail('A connect to 192.0.2.1 succeeded, so the namespace has network')); });
        socket.once('error', error => {
            clearTimeout(timer); socket.destroy();
            if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
            else reject(fail(`A connect to 192.0.2.1 failed with ${error.code}, not with a missing route`));
        });
    });
}

// ---- the server -----------------------------------------------------------------------------------------------------------

function serverEnvironment(home) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (KEPT_ENV.test(key) && !STRIPPED_ENV.test(key)) env[key] = value;
    const password = randomBytes(24).toString('base64url');
    return { password, env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
        OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: '{"update":"disable"}' } };
}

function startServer(binary, home, workspace) {
    const { password, env } = serverEnvironment(home);
    // Detached, so one signal reaches the whole group when the binary is a launcher around the real server.
    const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const server = { child, password, output: '', exited: false, base: undefined };
    server.closed = new Promise(resolve => child.once('close', () => { server.exited = true; resolve(); }));
    server.spawnError = new Promise(resolve => child.once('error', error => { server.exited = true; resolve(error); }));
    server.announced = new Promise(resolve => {
        const listener = chunk => {
            server.output = (server.output + chunk).slice(-8192);
            const match = server.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').match(/server listening on (http:\/\/127\.0\.0\.1:(\d+))/u);
            if (match && !server.base && match[2] !== '0') { server.base = match[1]; resolve(match[1]); }
        };
        child.stdout.on('data', listener); child.stderr.on('data', listener);
    });
    return server;
}

async function stopServer(server) {
    if (!server || server.exited) return;
    const signal = name => { try { process.kill(-server.child.pid, name); } catch { try { server.child.kill(name); } catch { /* Already gone. */ } } };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 3000);
    try { await Promise.race([server.closed, after(6000)]); } finally { clearTimeout(timer); }
    // A launcher may leave grandchildren in the group after its own exit.
    signal('SIGKILL');
}

function request(server, pathname) {
    return fetch(new URL(pathname, server.base), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`, 'x-opencode-directory': server.workspace },
        signal: AbortSignal.timeout(15000),
    });
}

async function getJson(server, pathname) {
    let response;
    try { response = await request(server, pathname); } catch (error) { throw fail(`GET ${pathname} failed: ${error.message}`); }
    const text = await response.text();
    if (!response.ok) throw fail(`GET ${pathname} answered HTTP ${response.status}: ${text.slice(0, 500)}`);
    try { return { body: JSON.parse(text), text }; } catch { throw fail(`GET ${pathname} did not answer JSON: ${text.slice(0, 500)}`); }
}

async function waitForServer(server, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const early = (async () => { const error = await Promise.race([server.spawnError, server.closed.then(() => null)]);
        throw fail(error ? `OpenCode did not start: ${error.message}` : `OpenCode exited before it was ready: ${server.output.trim().slice(-1500)}`); })();
    early.catch(() => {});
    await Promise.race([server.announced, early, after(Math.min(30000, timeoutMs)).then(() => { throw fail(`OpenCode did not announce a loopback URL: ${server.output.trim().slice(-1500)}`); })]);
    for (;;) {
        const attempt = await getJson(server, '/api/info').catch(error => error);
        if (!(attempt instanceof Error)) {
            const major = Number(String(attempt.body.version ?? '').split('.')[0]);
            if (!(major >= 2)) throw fail(`The running server is not OpenCode 2 or newer: ${attempt.text.slice(0, 200)}`);
            return attempt.body;
        }
        if (server.exited) await early;
        if (Date.now() >= deadline) throw fail(`OpenCode was not ready within ${timeoutMs} ms (${attempt.message}): ${server.output.trim().slice(-1500)}`);
        await sleep(200);
    }
}

async function waitForMigration(server, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { body } = await getJson(server, '/api/experimental/migration/v1');
        if (body.status === 'completed') return;
        if (!['required', 'running'].includes(body.status)) throw fail(`OpenCode native history migration did not complete: ${JSON.stringify(body).slice(0, 300)}`);
        if (Date.now() >= deadline) throw fail('OpenCode native history migration timed out');
        await sleep(100);
    }
}

// ---- checks ---------------------------------------------------------------------------------------------------------------

function readRecords(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { throw fail(`The recorder file holds a line that is not JSON: ${line.slice(0, 200)}`); } });
}

export function recorderEvidence(records) {
    const mine = records.filter(record => record?.id === RECORDER_ID);
    if (!mine.length) throw fail('The recorder plugin never ran: its setup left no record');
    const record = mine[mine.length - 1];
    const required = { plugin: ['imported', 'providerId', 'providerInfo', 'modelId', 'modelInfo'], effect: ['imported', 'succeed', 'runSync'] };
    for (const [group, names] of Object.entries(required)) {
        const missing = names.filter(name => record[group]?.[name] !== true);
        if (missing.length) throw fail(`The recorder could not use ${group === 'plugin' ? '@opencode/plugin' : 'effect'} (${missing.join(', ')} not true): ${JSON.stringify(record[group])}`);
    }
    return { id: record.id, records: mine.length, plugin: record.plugin, effect: record.effect };
}

export function checkPlugins(body) {
    if (!Array.isArray(body?.data)) throw fail(`/api/plugin answered no data array: ${JSON.stringify(body).slice(0, 500)}`);
    const failed = body.data.filter(plugin => plugin?.state?.status === 'failed');
    if (failed.length) throw fail(`/api/plugin reports failed plugins: ${JSON.stringify(failed).slice(0, 1000)}`);
    // `Plugin.Info` is `{ id, source: { type: 'local', path }, features, state: { status: 'active' | 'failed' } }`.
    const recorder = body.data.find(plugin => plugin?.id === RECORDER_ID || (plugin?.source?.type === 'local' && String(plugin.source.path).endsWith(RECORDER_FILE)));
    if (!recorder) throw fail(`/api/plugin does not list the recorder plugin: ${JSON.stringify(body.data).slice(0, 1000)}`);
    if (recorder.state?.status !== 'active') throw fail(`The recorder plugin is not active: ${JSON.stringify(recorder).slice(0, 500)}`);
    return { count: body.data.length, recorder: { id: recorder.id, source: recorder.source?.type, state: recorder.state.status } };
}

export function checkNoTree(home) {
    const config = path.join(home, '.config', 'opencode');
    const present = TREE_NAMES.filter(name => { try { fs.lstatSync(path.join(config, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    if (present.length) throw fail(`OpenCode created a dependency tree under .config/opencode: ${present.join(', ')}`);
    const cache = path.join(home, '.cache', 'opencode', 'npm');
    let entries = [];
    try { entries = fs.readdirSync(cache); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (entries.length) throw fail(`OpenCode installed packages into .cache/opencode/npm: ${entries.slice(0, 10).join(', ')}`);
}

async function runProbe(options) {
    const started = Date.now();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'robowork-opencode-plugin-free-'));
    const state = { server: undefined, ok: false };
    Object.assign(active, { home, keep: options.keep });
    try {
        const config = path.join(home, '.config', 'opencode');
        const workspace = path.join(home, 'workspace');
        const recordFile = path.join(home, 'recorder.jsonl');
        fs.mkdirSync(path.join(config, 'plugins'), { recursive: true, mode: 0o700 });
        fs.mkdirSync(workspace, { mode: 0o700 });
        fs.writeFileSync(path.join(config, 'plugins', RECORDER_FILE), recorderSource(recordFile), { mode: 0o600 });
        const { env } = serverEnvironment(home);
        const versionRun = spawnSync(options.binary, ['--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
        if (versionRun.error || versionRun.status !== 0) throw fail(`${options.binary} --version failed: ${versionRun.error?.message || versionRun.stderr.trim() || `exit ${versionRun.status}`}`);
        const version = (versionRun.stdout.match(/\d+\.\d+\.\d+\S*/u) || [])[0];
        if (!version || !(Number(version.split('.')[0]) >= 2)) throw fail(`OpenCode 2 or newer is required, --version printed: ${versionRun.stdout.trim().slice(0, 200)}`);

        state.server = startServer(options.binary, home, workspace);
        state.server.workspace = workspace;
        active.server = state.server;
        await waitForServer(state.server, options.timeoutMs);
        await waitForMigration(state.server, Math.min(options.timeoutMs, 120000));
        // Instance creation, and with it plugin setup, may happen on the first request that needs it.
        let plugins;
        try {
            plugins = checkPlugins((await getJson(state.server, '/api/plugin')).body);
        } catch (error) {
            if (error.probeFailure) process.stderr.write(`Server output tail:\n${state.server.output.trim().slice(-2000)}\n`);
            throw error;
        }
        const models = (await getJson(state.server, '/api/model')).body;
        if (!Array.isArray(models?.data)) throw fail(`/api/model answered no data array: ${JSON.stringify(models).slice(0, 500)}`);
        const deadline = Date.now() + options.recordWaitMs;
        while (!readRecords(recordFile).length && Date.now() < deadline) await sleep(100);
        const recorder = recorderEvidence(readRecords(recordFile));
        // Stop first: an installer may write on the way out, and the absence checks must see the final state.
        await stopServer(state.server);
        checkNoTree(home);
        state.ok = true;
        return { version, plugins: plugins.count, recorder: { ...recorder, listed: plugins.recorder }, models: models.data.length, offline: options.offline, elapsedMs: Date.now() - started };
    } finally {
        await stopServer(state.server);
        if (options.keep) process.stderr.write(`Scratch home kept at ${home}\n`);
        else fs.rmSync(home, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.offline && !options.inNetns) {
        const { command, args } = offlineCommand(options);
        const result = spawnSync(command, args, { stdio: 'inherit' });
        if (result.error) throw fail(`unshare could not run: ${result.error.message}`);
        process.exitCode = result.status === 0 ? 0 : (result.status || 1);
        return;
    }
    if (options.offline) await assertNoNetwork();
    const evidence = await runProbe(options);
    process.stdout.write(`${SENTINEL} ${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    // An interrupt must not leave the server or the scratch home behind.
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        if (active.server && !active.server.exited) { try { process.kill(-active.server.child.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
        if (active.home && !active.keep) fs.rmSync(active.home, { recursive: true, force: true });
        process.exit(130);
    });
    main().catch(error => {
        process.stderr.write(`${error.probeFailure ? 'FAIL' : 'ERROR'}: ${error.probeFailure ? error.message : error.stack}\n`);
        process.exitCode = 1;
    });
}
