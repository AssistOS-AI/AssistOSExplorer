import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectNestedContainer } from './webtty-runtime-evidence.mjs';
import { findSecretLeaks } from './security.mjs';
import { findTraceCredentialResidue } from './redacted-trace.mjs';

export const ROBOTEAM_BASE = '/base-agent-additional-server/roboTeamAgent/3001';
export const LIVE_BASE = `${ROBOTEAM_BASE}/api/live-sessions`;
export const ENDED = ['finished', 'failed', 'stopped', 'lost'];
const execute = promisify(execFile);
const REFUSAL = /\[input error\]|\[error\]|unauthenticated|authentication (?:failed|required)|not logged in|please (?:log|sign) in|invalid.api.key|insufficient.quota|quota.exceeded|rate.limit|tier.exhausted|all models.*exhausted|provider.*(?:error|failure)|billing|credit balance|backend.*unavailable|Agent process exited repeatedly|bwrap:/i;

export function requiresCopilotSourceVerification(specs) {
    return specs.length === 0 || specs.some(spec => ['specs/05-copilot-folder-launch.spec.mjs', 'specs/07-live-sessions.spec.mjs']
        .includes(String(spec).replaceAll('\\', '/')));
}

export function foreignAccount(env = process.env) {
    const prefix = 'SMOKE_LIVE_SESSIONS_FOREIGN_';
    const loginEmail = String(env[`${prefix}LOGIN_EMAIL`] || '').trim();
    const signInMethod = env[`${prefix}SIGN_IN_METHOD`];
    const accountPassword = String(env[`${prefix}ACCOUNT_PASSWORD`] || '');
    const totpSecret = String(env[`${prefix}TOTP_SECRET`] || '');
    if (!loginEmail || !['password', 'totp', 'emailCode'].includes(signInMethod)
        || signInMethod === 'password' && !accountPassword
        || signInMethod === 'totp' && !totpSecret
        || signInMethod === 'emailCode' && !env.SMOKE_EMAIL_CODE_COMMAND) {
        throw new Error('Live Sessions requires SMOKE_LIVE_SESSIONS_FOREIGN_LOGIN_EMAIL, SIGN_IN_METHOD and its method-specific private inputs.');
    }
    return { username: env[`${prefix}USERNAME`] || loginEmail, loginEmail, signInMethod,
        accountPassword, totpSecret, password: String(env[`${prefix}PASSWORD`] || '') };
}

export function assertLivePrincipals(admin, owner, foreign) {
    assert.ok(admin?.canonicalId && admin.roles?.includes('admin'), 'Live Sessions observer must be a verified administrator.');
    for (const principal of [owner, foreign]) {
        assert.ok(principal?.canonicalId && principal.roles?.includes('user')
            && !principal.roles.includes('admin') && !principal.roles.includes('guest'),
        'Live Sessions owner and foreign viewer must be verified ordinary users.');
    }
    assert.equal(new Set([admin, owner, foreign].map(value => value.canonicalId)).size, 3,
        'Live Sessions requires three distinct verified principals.');
    assert.equal(new Set([admin, owner, foreign].map(value => value.canonicalUsername)).size, 3,
        'Live Sessions requires three distinct verified account names.');
}

export function assertNoNativeRefusal(text) {
    if (REFUSAL.test(String(text))) throw new Error('Native provider/startup refusal observed; preserve the first failure and do not retry or substitute a backend.');
}

export function workload(id = crypto.randomUUID()) {
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    const initial = `initial-${id}`;
    const followup = `owner-${id}`;
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const first = `LS_EXEC_${digest(initial)}`;
    const second = `LS_EXEC_${digest(followup)}_雪_🙂_<img data-ls-canary="${id}" src=x onerror="globalThis.__lsExecuted=1">`;
    const command = (challenge, filename, suffix = '') => `node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const text="LS_EXEC_"+crypto.createHash("sha256").update(${JSON.stringify(challenge)}).digest("hex")+${JSON.stringify(suffix)};fs.writeFileSync(${JSON.stringify(filename)},JSON.stringify({challenge:${JSON.stringify(challenge)},text}));console.log(text)'`;
    const firstFile = `live-proof-${id}-initial.json`;
    const secondFile = `live-proof-${id}-owner.json`;
    const suffix = second.slice(`LS_EXEC_${digest(followup)}`.length);
    const initialCommand = command(initial, firstFile);
    const ownerCommand = command(followup, secondFile, suffix);
    return {
        id, first, second, firstFile, secondFile,
        initialCommand, ownerCommand,
        prompt: `Live Sessions execution ${id}. Work only in this selected folder. Use your real native command tool to execute this command exactly: ${initialCommand}. Read that file and emit its text value verbatim as an assistant message, not a promise. Keep this same turn active for at most 180 seconds by executing separate five-second sleep commands and checking incoming owner instructions between commands. Do not finish while waiting. When an owner instruction arrives, execute it, emit the produced text value, and continue the bounded wait. Do not launch background jobs. Stop promptly when interrupted.`,
        message: `Execute this command with the native command tool now, then read its file and emit its text value verbatim as an assistant message: ${ownerCommand}. Continue the bounded wait from the original instruction.`,
        initial, followup,
    };
}

export function assertExecutionFile(filename, challenge, text) {
    const stat = fs.lstatSync(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 16_384, 'Native execution proof must be a bounded regular file.');
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { challenge, text });
}

export function parseSse(buffer) {
    const frames = [];
    const normalized = buffer.replace(/\r\n/g, '\n');
    let offset = 0;
    while (true) {
        const end = normalized.indexOf('\n\n', offset);
        if (end < 0) break;
        const block = normalized.slice(offset, end);
        offset = end + 2;
        let event = 'message', id = '';
        const data = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trimStart();
            if (line.startsWith('id:')) id = line.slice(3).trimStart();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) frames.push({ event, id, data: JSON.parse(data.join('\n')) });
    }
    return { frames, remainder: normalized.slice(offset) };
}

export function executionText(frames) {
    return frames.filter(frame => frame.event === 'output' && ['assistant', 'output'].includes(frame.data?.style))
        .map(frame => frame.data.text).join('');
}

export function assertOrderedFrames(frames) {
    const ids = frames.filter(frame => frame.event === 'output').map(frame => Number(frame.id));
    assert.ok(ids.length > 0 && ids.every((id, index) => Number.isSafeInteger(id) && id > 0 && (!index || id > ids[index - 1])),
        'Output cursor IDs must increase without duplicate application.');
}

export function replayApplicationMatches(frames, applied) {
    assertOrderedFrames(frames);
    const expected = frames.filter(frame => frame.event === 'output')
        .map(frame => ({ text: frame.data.text, style: frame.data.style }));
    return JSON.stringify(applied) === JSON.stringify(expected);
}

// A separate authenticated HTTP reader allows deliberate header/negative probes
// without manufacturing browser diagnostic exceptions. Cookies stay in memory.
export async function openSse(context, baseURL, id, { cursor, timeoutMs = 240_000 } = {}) {
    assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
    const url = new URL(`${LIVE_BASE}/${id}/stream`, baseURL);
    const cookies = await context.cookies(url.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(url, { redirect: 'error', signal: controller.signal,
            headers: { accept: 'text/event-stream', cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
                ...(cursor === undefined ? {} : { 'Last-Event-ID': String(cursor) }) } });
        assert.equal(response.status, 200, 'Authenticated production SSE must open.');
        assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
    } catch (error) {
        clearTimeout(timer);
        controller.abort();
        throw error;
    }
    const frames = [];
    let failure = null, remainder = '', bytes = 0;
    const completed = (async () => {
        const decoder = new TextDecoder();
        try {
            for await (const chunk of response.body) {
                bytes += chunk.byteLength;
                if (bytes > 4 * 1024 * 1024) throw new Error('Live Sessions SSE evidence exceeded its bound.');
                const parsed = parseSse(remainder + decoder.decode(chunk, { stream: true }));
                remainder = parsed.remainder;
                frames.push(...parsed.frames);
                assertNoNativeRefusal(parsed.frames.filter(frame => frame.event === 'output' && frame.data?.style !== 'user')
                    .map(frame => frame.data.text).join(''));
            }
        } catch (error) { if (!controller.signal.aborted) failure = error; }
        finally { clearTimeout(timer); }
    })();
    return { frames, check() { if (failure) throw failure; },
        async close() { controller.abort(); await completed; if (failure) throw failure; } };
}

export async function liveRequest(page, id = '', action = '', { method = 'GET', body, raw, headers = {} } = {}) {
    const url = `${LIVE_BASE}${id ? `/${id}` : ''}${action ? `/${action}` : ''}`;
    const mutation = method !== 'GET';
    if (mutation) {
        const proofResponse = await page.request.get('/auth/token?agent=roboTeamAgent');
        assert.equal(proofResponse.status(), 200, 'Mutation proof request must authenticate.');
        const { browserMutation: proof } = await proofResponse.json();
        assert.equal(proof?.routeKey, 'roboTeamAgent');
        assert.equal(proof?.origin, new URL(page.url()).origin);
        assert.ok(proof?.csrfToken);
        const mutationHeaders = new Headers(headers);
        mutationHeaders.set('origin', proof.origin);
        mutationHeaders.set('x-ploinky-browser-csrf-token', proof.csrfToken);
        mutationHeaders.set('content-type', 'application/json');
        headers = Object.fromEntries(mutationHeaders.entries());
    }
    return page.request.fetch(url, { method, headers, timeout: 45_000, maxRedirects: 0,
        ...(raw !== undefined ? { data: raw } : body === undefined ? {} : { data: body }) });
}

export async function inventory(page) {
    const response = await liveRequest(page);
    assert.equal(response.status(), 200, 'Inventory must reach authenticated RoboTeam, not an authentication refusal.');
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.version, 1);
    assert.ok(Array.isArray(payload.sessions));
    assert.deepEqual(findSecretLeaks(payload.sessions), [], 'Public inventory must not expose private input values.');
    assert.deepEqual(findTraceCredentialResidue(JSON.stringify(payload.sessions)), [], 'Public inventory must not expose credentials.');
    return payload.sessions;
}

export async function discoverSource(page) {
    await page.waitForFunction(() => Boolean(globalThis.assistOS?.workspace?.appPlugins?.['live-sessions:source']?.length));
    const sources = await page.evaluate(() => globalThis.assistOS.workspace.appPlugins['live-sessions:source']
        .filter(source => source.agent === 'roboTeamAgent').map(source => ({ agent: source.agent,
            contributionType: source.contributionType, liveSessions: source.liveSessions })));
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0], { agent: 'roboTeamAgent', contributionType: 'live-sessions-source', liveSessions: { version: 1, base: LIVE_BASE } });
    return sources[0];
}

export async function openWatch(page, id) {
    const dialog = page.getByRole('dialog', { name: 'Live Sessions', exact: true });
    if (!await dialog.isVisible()) await page.locator('[data-app-plugin-key="explorer/live-sessions"] button:visible').click();
    await dialog.waitFor({ state: 'visible' });
    const key = `${LIVE_BASE}:${id}`;
    const watch = dialog.locator(`[data-session-id="${key}"][data-session-action="attach"]`);
    await watch.waitFor({ state: 'visible' });
    await watch.click();
    const output = dialog.locator('#liveSessionsFrame pre.live-session-output');
    await output.waitFor({ state: 'visible' });
    assert.equal(await output.count(), 1, 'Watch must expose exactly one output container.');
    return { dialog, output, form: dialog.locator('.live-session-message-form') };
}

export async function detachWatch(page) {
    const button = page.locator('[data-local-action="detachViewer"]');
    if (await button.isVisible()) await button.click();
}

export async function restartRoboTeam({ executable, workspaceRoot, timeoutMs = 300_000 }) {
    assert.ok(path.isAbsolute(executable) && path.isAbsolute(workspaceRoot), 'Restart requires exact absolute fixture paths.');
    const result = await execute(executable, ['restart', 'roboTeamAgent'], {
        cwd: workspaceRoot, env: { ...process.env, PLOINKY_CWD: workspaceRoot }, timeout: timeoutMs,
        killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    assert.match(result.stdout, /✓ Agent restarted(?: \([^)]+\))?\./);
    assert.doesNotMatch(result.stderr, /failed to (?:restart|start)|managed restart failed/i);
    return { completed: true };
}

export function validateNativeEvidence(record, { release, runtime, workspaceRoot, config, initial = true }) {
    assert.equal(record?.schemaVersion, 1, 'Native evidence schema must be version 1.');
    assert.match(record.robotId, /^[a-z0-9][a-z0-9-]{2,63}$/);
    assert.equal(record.workspaceRoot, workspaceRoot);
    assert.equal(record.outerContainerId, release.liveBox.box.containerId);
    assert.equal(record.imageDigest, release.imageDigest);
    assert.deepEqual(record.repositories, release.repositories, 'Native evidence must bind the complete verified source graph.');
    if (initial) {
        for (const key of ['containerId', 'containerName', 'instanceId', 'enableGeneration']) {
            assert.equal(record.initialRoboTeam?.[key], runtime[key], `Native evidence initial RoboTeam ${key} must match.`);
        }
    }
    const native = record.native;
    assert.ok(native && ['claude', 'codex', 'opencode', 'pi'].includes(native.backend));
    assert.equal(native.backend, config.codingAgent, 'Configured native backend must not be substituted.');
    assert.equal(native.model, config.models?.[native.backend] ?? config.defaultModels?.[native.backend] ?? null);
    assert.equal(native.effort, config.efforts?.[native.backend] ?? null);
    assert.match(native.version, /^[^\r\n\u0000-\u001f]{1,128}$/);
    assert.ok(typeof native.cliVersion === 'string' && native.cliVersion.includes(native.version)
        && native.cliVersion.length <= 256 && !/[\u0000-\u001f]/.test(native.cliVersion),
    'Operator evidence must include the actual native --version output.');
    assert.match(native.sha256, /^[a-f0-9]{64}$/);
    assert.match(native.generation, /^[a-f0-9]{64}$/);
    for (const key of ['executablePath', 'realpath', 'cacheRoot']) assert.ok(path.posix.isAbsolute(native[key]));
    assert.ok(native.realpath.startsWith(`${native.cacheRoot}/${native.backend}/generations/${native.generation}/`),
        'The frozen native binary must belong to its recorded cache generation.');
    return native;
}

export async function verifyNativeExecutable(evidence, runtime, native) {
    const before = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(before?.State?.Running, true);
    const script = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const expected = JSON.parse(process.argv[1]);
const realpath = fs.realpathSync(expected.executablePath);
const stat = fs.statSync(realpath);
if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('invalid native executable');
const root = path.join(expected.cacheRoot, expected.backend);
const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const stamp = JSON.parse(fs.readFileSync(path.join(root, 'generations', expected.generation, 'stamp.json'), 'utf8'));
if (descriptor.generation !== expected.generation || stamp.generation !== expected.generation
    || descriptor.versions?.[expected.backend] !== stamp.versions?.[expected.backend]) throw new Error('native cache generation drift');
const hash = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(realpath)) hash.update(chunk);
process.stdout.write(JSON.stringify({ realpath, sha256: hash.digest('hex'), generation: stamp.generation,
    version: stamp.versions[expected.backend] }));
`;
    const result = await execute('podman', ['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', runtime.containerId,
        '/usr/local/bin/node', '--input-type=module', '--eval', script, JSON.stringify(native)], {
        timeout: 30_000, maxBuffer: 16_384, killSignal: 'SIGKILL',
    });
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed, { realpath: native.realpath, sha256: native.sha256,
        generation: native.generation, version: native.version });
    const after = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(after?.Id, before.Id);
    assert.equal(after?.State?.StartedAt, before.State.StartedAt);
    return observed;
}

export function activeTurnProcesses(rows) {
    return rows.filter(row => /(?:^|\s)--control-stdin(?:\s|$)/.test(row)
        && /(?:^|\s)--turn-id(?:\s|$)/.test(row)).sort();
}

// Inspect only process identity, argv and the selected public executable. Never
// read process environments, homes, credential files, logs or managed sources.
export async function nativeProcessIdentity(evidence, runtime, native, directoryName) {
    assert.match(directoryName, /^[A-Za-z0-9_-]+$/);
    const before = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(before?.State?.Running, true);
    const script = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
const rootPid = Number(process.argv[1]);
const native = JSON.parse(process.argv[2]);
const directoryName = process.argv[3];
const entries = fs.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value));
if (entries.length > 8192 || !Number.isSafeInteger(rootPid) || rootPid < 2) throw new Error('invalid bounded process inventory');
function stat(pid) {
    const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const parts = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, ppid: Number(parts[1]), startToken: parts[19], state: parts[0] };
}
const root = stat(rootPid);
const rows = new Map();
for (const entry of entries) {
    try { const row = stat(Number(entry)); rows.set(row.pid, row); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
function descendant(pid, ancestor) {
    const seen = new Set();
    while (rows.has(pid) && !seen.has(pid)) {
        if (pid === ancestor) return true;
        seen.add(pid); pid = rows.get(pid).ppid;
    }
    return false;
}
function argv(pid) {
    const buffer = fs.readFileSync('/proc/' + pid + '/cmdline');
    if (buffer.length > 65536) throw new Error('bounded process arguments exceeded');
    return buffer.toString('utf8').split('\0').filter(Boolean);
}
const candidates = [];
for (const row of rows.values()) {
    if (!descendant(row.pid, rootPid) || row.state === 'Z') continue;
    try { row.argv = argv(row.pid); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (row.argv.includes('--control-stdin') && row.argv.includes('--turn-id')
        && row.argv.some(value => value.endsWith('/' + directoryName))) candidates.push(row);
}
if (candidates.length !== 1) throw new Error('expected exactly one selected native-turn parent');
const ala = candidates[0];
const matches = [];
for (const row of rows.values()) {
    if (!descendant(row.pid, ala.pid) || row.pid === ala.pid || row.state === 'Z') continue;
    try {
        const command = argv(row.pid);
        const executable = fs.readlinkSync('/proc/' + row.pid + '/exe');
        if (/(?:^|\/)bwrap$/.test(executable)) continue;
        if (executable !== native.realpath && !command.includes(native.realpath)) continue;
        const file = '/proc/' + row.pid + '/root' + native.realpath;
        const metadata = fs.statSync(file);
        if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024) throw new Error('invalid selected process executable');
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        const after = stat(row.pid);
        if (after.startToken !== row.startToken || after.ppid !== row.ppid) throw new Error('native process changed during snapshot');
        matches.push({ pid: row.pid, startToken: row.startToken, executable: native.realpath, sha256: hash.digest('hex') });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
if (matches.length !== 1) throw new Error('expected exactly one frozen native CLI process');
if (stat(rootPid).startToken !== root.startToken || stat(ala.pid).startToken !== ala.startToken) throw new Error('native runtime changed during snapshot');
process.stdout.write(JSON.stringify({ ala: { pid: ala.pid, startToken: ala.startToken }, native: matches[0] }));
`;
    const result = await execute('podman', ['exec', evidence.outerContainerId, '/usr/local/bin/node', '--input-type=module', '--eval',
        script, String(before.State.Pid), JSON.stringify(native), directoryName], {
        timeout: 30_000, maxBuffer: 16_384, killSignal: 'SIGKILL',
    });
    const identity = JSON.parse(result.stdout);
    assertNativeProcessIdentity(identity, native);
    const after = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(after?.State?.StartedAt, before.State.StartedAt);
    return identity;
}

export function assertNativeProcessIdentity(identity, native) {
    for (const process of [identity?.ala, identity?.native]) {
        assert.ok(Number.isSafeInteger(process?.pid) && process.pid > 1);
        assert.match(process?.startToken, /^[1-9][0-9]*$/);
    }
    assert.notEqual(identity.ala.pid, identity.native.pid);
    assert.equal(identity.native.sha256, native.sha256, 'The actual running native executable must match the frozen hash.');
    assert.equal(identity.native.executable, native.realpath);
}

export function observeFinitePageWork(page) {
    const pending = new Set();
    let started = 0;
    page.on('request', request => { started += 1; pending.add(request); });
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => pending.delete(request));
    page.on('response', response => {
        if (response.ok() && /^text\/event-stream(?:;|$)/i.test(response.headers()['content-type'] || '')) {
            pending.delete(response.request());
        }
    });
    return {
        async settle(timeoutMs = 45_000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const sample = started;
                const rendered = await page.evaluate(async () => {
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const presenter = document.querySelector('file-exp')?.webSkelPresenter;
                    return !presenter?.__appPluginRenderPromise;
                });
                if (rendered && pending.size === 0 && sample === started) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Finite browser response bodies and plugin renders did not quiesce before page close.');
        },
    };
}
