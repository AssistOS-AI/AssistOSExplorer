import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectNestedContainer, workspaceHash } from './webtty-runtime-evidence.mjs';
import { assertBoxWorkspacePath } from './box-workspace.mjs';
import { collectSecrets, createRedactor, findSecretLeaks } from './security.mjs';
import { redactTraceText, findTraceCredentialResidue } from './redacted-trace.mjs';
import { buildResidentRunProgram, processRuntimeFence } from './robowork-run-evidence.mjs';
import { buildControllerProducerProgram, buildControllerProducerCensusProgram } from './robowork-process-evidence.mjs';
import { buildBoxProcReadProgram, residentProcReadBridge } from './robowork-proc-evidence.mjs';

export const ROBOTEAM_BASE = '/base-agent-additional-server/roboTeamAgent/3001';
export const LIVE_BASE = `${ROBOTEAM_BASE}/api/live-sessions`;
export const ENDED = ['finished', 'failed', 'stopped', 'lost'];
const retainedResidentProofs = new WeakSet();

function sealResidentProof(proof) {
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    const retained = freeze(proof);
    retainedResidentProofs.add(retained);
    return retained;
}
const execute = promisify(execFile);
const REFUSAL = /\[input error\]|\[error\]|unauthenticated|authentication (?:failed|required)|not logged in|please (?:log|sign) in|invalid.api.key|insufficient.quota|quota.exceeded|rate.limit|tier.exhausted|all models.*exhausted|provider.*(?:error|failure)|billing|credit balance|backend.*unavailable|Agent process exited repeatedly|bwrap:/i;

export function requiresCopilotSourceVerification(specs) {
    return specs.length === 0 || specs.some(spec => ['specs/05-copilot-folder-launch.spec.mjs', 'specs/07-live-sessions.spec.mjs',
        'specs/08-robowork-restart.spec.mjs']
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
        prompt: `Live Sessions execution ${id}. List the available workflows, then launch the default workflow exactly once in this selected folder with this objective: Work only in this selected folder. Use your real native command tool to execute this command exactly: ${initialCommand}. Read that file and emit its text value verbatim as an assistant message. Keep this same workflow phase active for at most 180 seconds by executing separate five-second sleep commands and checking incoming owner instructions between commands. Do not finish while waiting. When an owner instruction arrives, execute it, emit the produced text value, and continue the bounded wait. Do not launch background jobs or additional workflows. Stop promptly when interrupted. After launching, report the workflow link and finish the launcher turn.`,
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

// The Live Sessions panel is the shell's expanded-modal dialog (role dialog, named by its title). The list, the viewer,
// the Detach control and the stream output belong to the Live Sessions page that dialog frames in
// `iframe.expanded-modal-frame` (expanded-modal.js mountFrameContent); a shell row's terminal is one more frame inside
// that page (`#liveSessionsFrame iframe`). `dialog` is the shell and `content` is the framed page.
export const LIVE_SESSIONS_PAGE_FRAME = 'iframe.expanded-modal-frame';

export function liveSessionsPanel(page) {
    const dialog = page.getByRole('dialog', { name: 'Live Sessions', exact: true });
    return { dialog, content: dialog.frameLocator(LIVE_SESSIONS_PAGE_FRAME) };
}

export async function openWatch(page, id) {
    const { dialog, content } = liveSessionsPanel(page);
    if (!await dialog.isVisible()) await page.locator('[data-app-plugin-key="explorer/live-sessions"] button:visible').click();
    await dialog.waitFor({ state: 'visible' });
    const key = `${LIVE_BASE}:${id}`;
    const watch = content.locator(`[data-session-id="${key}"][data-session-action="attach"]`);
    await watch.waitFor({ state: 'visible' });
    await watch.click();
    const output = content.locator('#liveSessionsFrame pre.live-session-output');
    await output.waitFor({ state: 'visible' });
    assert.equal(await output.count(), 1, 'Watch must expose exactly one output container.');
    return { dialog, content, output, form: content.locator('.live-session-message-form') };
}

// Detach view, the page's own control (`requestDetachViewer`). Strict: the viewer must be shown, the exact control must
// exist and be clicked, and the viewer must then be gone. A missing control or an open close choice fails here.
export async function detachWatch(page) {
    const { dialog, content } = liveSessionsPanel(page);
    await dialog.waitFor({ state: 'visible' });
    const viewer = content.locator('#liveSessionsViewer');
    await viewer.waitFor({ state: 'visible' });
    await content.locator('[data-local-action="requestDetachViewer"]').click();
    await viewer.waitFor({ state: 'hidden' });
}

// Cleanup: detaches only a viewer that is shown. The panel never opened, or no view is attached, means there is
// nothing to detach. Whenever a viewer is shown, the same strict detach runs, so a changed control cannot be skipped.
export async function detachWatchIfShown(page) {
    const { dialog, content } = liveSessionsPanel(page);
    if (!await dialog.isVisible() || !await content.locator('#liveSessionsViewer').isVisible()) return false;
    await detachWatch(page);
    return true;
}

export async function restartRoboTeam({ executable, workspaceRoot, timeoutMs = 300_000 }) {
    return restartResidentAgent('roboTeamAgent', { executable, workspaceRoot, timeoutMs });
}

export async function restartRoboWork({ executable, workspaceRoot, timeoutMs = 300_000 }) {
    return restartResidentAgent('roboWorkAgent', { executable, workspaceRoot, timeoutMs });
}

async function restartResidentAgent(agent, { executable, workspaceRoot, timeoutMs }) {
    assert.ok(path.isAbsolute(executable) && path.isAbsolute(workspaceRoot), 'Restart requires exact absolute fixture paths.');
    const result = await execute(executable, ['restart', agent], {
        cwd: workspaceRoot, env: { ...process.env, PLOINKY_CWD: workspaceRoot }, timeout: timeoutMs,
        killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    assert.match(result.stdout, /✓ Agent restarted(?: \([^)]+\))?\./);
    assert.doesNotMatch(result.stderr, /failed to (?:restart|start)|managed restart failed/i);
    return { completed: true };
}

export function validateNativeEvidence(record, { release, runtime, executionRuntime, workspaceRoot, config, initial = true }) {
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
    if (executionRuntime) {
        assert.notEqual(executionRuntime.containerId, runtime.containerId, 'Controller and execution evidence must name separate containers.');
        for (const key of ['containerId', 'containerName', 'instanceId', 'enableGeneration']) {
            assert.equal(record.initialRoboWork?.[key], executionRuntime[key], `Native evidence RoboWork ${key} must match.`);
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

// The injectable I/O boundary is for observer-contract tests only. The exported
// program below always supplies Node's real fs and the canonical /proc root.
export function validateNativeAlaBinding(binding) {
    const clean = value => typeof value === 'string' && value.startsWith('/') && value !== '/'
        && !/[\u0000-\u001f\u007f]/.test(value) && !value.split('/').some((part, index) => index > 0 && ['', '.', '..'].includes(part));
    if (!binding || !clean(binding.root) || !clean(binding.command) || binding.command !== `${binding.root}/bin/ala.mjs`
        || !binding.hashes || !/^[a-f0-9]{64}$/.test(binding.hashes['bin/ala.mjs'] || '')) throw new Error('invalid frozen ALA binding');
    return binding;
}

export async function collectNativeProcessSnapshot(rootPid, native, expectedCwd, io = fs, selection = null) {
    if (!Number.isSafeInteger(rootPid) || !(rootPid > 1 || rootPid === 1 && Array.isArray(selection?.residentRecords))
        || typeof expectedCwd !== 'string' || !expectedCwd.startsWith('/')
        || expectedCwd === '/' || /[\u0000-\u001f\u007f]/.test(expectedCwd)
        || expectedCwd.split('/').some((part, index) => index > 0 && ['', '.', '..'].includes(part))) {
        throw new Error('invalid exact process context');
    }
    if (!native || typeof native.realpath !== 'string' || !native.realpath.startsWith('/')
        || /[\u0000-\u001f\u007f]/.test(native.realpath)
        || native.realpath.split('/').some((part, index) => index > 0 && ['', '.', '..'].includes(part))
        || !/^[a-f0-9]{64}$/.test(native.sha256 || '')) throw new Error('invalid frozen native identity');
    validateNativeAlaBinding(selection?.alaBinding);
    {
        if (!['copilot', 'workflow', 'census'].includes(selection.kind)) throw new Error('invalid selected producer kind');
        if (selection.kind !== 'census') for (const key of ['sessionId', 'turnId']) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(selection[key] || '')) throw new Error('invalid selected native ID');
        }
        for (const root of [selection.codeRoot, ...(selection.workflowCodeRoot ? [selection.workflowCodeRoot] : [])]) {
            if (typeof root !== 'string' || !root.startsWith('/')
                || root.split('/').some((part, index) => index > 0 && ['', '.', '..'].includes(part))
                || /[\u0000-\u001f\u007f]/.test(root)) throw new Error('invalid deployed producer root');
        }
    }
    const entries = io.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value));
    if (entries.length > 8192) throw new Error('bounded process inventory exceeded');
    function readBounded(file, limit = 65536) {
        const fd = io.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(limit + 1);
            let length = 0, count;
            while (length < buffer.length && (count = io.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
            if (length > limit) throw new Error('bounded process metadata exceeded');
            return buffer.subarray(0, length);
        } finally { io.closeSync(fd); }
    }
    function stat(pid) {
        const text = readBounded('/proc/' + pid + '/stat').toString('utf8');
        const open = text.indexOf('('), close = text.lastIndexOf(')');
        const parts = text.slice(close + 1).trim().split(/\s+/);
        if (open <= 0 || close <= open || Number(text.slice(0, open).trim()) !== pid
            || parts.length < 20 || !/^[A-Z]$/.test(parts[0] || '')
            || !/^(?:0|[1-9][0-9]*)$/.test(parts[1] || '')
            || !Number.isSafeInteger(Number(parts[1])) || !/^[1-9][0-9]{0,19}$/.test(parts[19] || '')) {
            throw new Error('malformed process stat');
        }
        return { pid, ppid: Number(parts[1]), startToken: parts[19], state: parts[0] };
    }
    function namespace(pid) {
        const value = io.readlinkSync('/proc/' + pid + '/ns/pid');
        if (!/^pid:\[[1-9][0-9]{0,19}\]$/.test(value)) throw new Error('malformed PID namespace');
        return value;
    }
    function argv(pid) {
        const buffer = readBounded('/proc/' + pid + '/cmdline');
        if (buffer.length && (buffer.at(-1) !== 0 || !buffer.toString('utf8').isWellFormed()
            || !Buffer.from(buffer.toString('utf8')).equals(buffer))) throw new Error('malformed process argv');
        return buffer.length ? buffer.toString('utf8').slice(0, -1).split('\0') : [];
    }
    function readProcess(pid) {
        const first = stat(pid);
        const pidNamespace = namespace(pid), args = argv(pid);
        const last = stat(pid);
        if (first.startToken !== last.startToken || first.ppid !== last.ppid
            || last.state === 'Z' || namespace(pid) !== pidNamespace) throw new Error('process changed during snapshot');
        return { ...last, pidNamespace, argv: args };
    }
    function same(first, last) {
        return first.pid === last.pid && first.startToken === last.startToken && first.ppid === last.ppid
            && first.pidNamespace === last.pidNamespace && JSON.stringify(first.argv) === JSON.stringify(last.argv);
    }
    function identity(row) {
        return { pid: row.pid, ppid: row.ppid, startToken: row.startToken, pidNamespace: row.pidNamespace };
    }
    function hashExecutable(pid) {
        const fd = io.openSync('/proc/' + pid + '/root' + native.realpath, 'r');
        try {
            const before = io.fstatSync(fd);
            if (!before.isFile() || before.size <= 0 || before.size > 256 * 1024 * 1024) throw new Error('invalid selected process executable');
            const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
            let count, size = 0;
            while ((count = io.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
                size += count;
                if (size > 256 * 1024 * 1024) throw new Error('bounded native executable exceeded');
                hash.update(buffer.subarray(0, count));
            }
            const after = io.fstatSync(fd);
            if (size !== before.size || ['size', 'ino', 'dev', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('native executable changed during snapshot');
            const sha256 = hash.digest('hex');
            if (sha256 !== native.sha256) throw new Error('frozen native executable hash drift');
            return sha256;
        } finally { io.closeSync(fd); }
    }
    function turnContext(args, wrapper = false) {
        const result = {};
        if (wrapper && args.some(value => value === '--turn-id' || value.startsWith('--turn-id='))) throw new Error('invalid workflow producer turn advertisement');
        for (const flag of ['--control-stdin', '--cwd', '--session-id', ...(wrapper ? [] : ['--turn-id'])]) {
            if (args.filter(value => value === flag || value.startsWith(flag + '=')).length !== 1) throw new Error('invalid required native-turn arguments');
            const index = args.indexOf(flag);
            if (index < 0) throw new Error('invalid required native-turn arguments');
            if (flag === '--control-stdin') continue;
            const value = args[index + 1];
            if (!value || value.startsWith('--') || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid required native-turn value');
            result[flag.slice(2)] = value;
        }
        for (const key of ['session-id', ...(wrapper ? [] : ['turn-id'])]) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(result[key])) throw new Error('invalid required native-turn identity');
        }
        return { cwd: result.cwd, sessionId: result['session-id'], ...(wrapper ? {} : { turnId: result['turn-id'] }) };
    }
    const workflowScript = `${selection.workflowCodeRoot || selection.codeRoot}/server/robot-task.mjs`;
    function interpreter(row) {
        const executable = io.readlinkSync('/proc/' + row.pid + '/exe');
        if (!/(?:^|\/)(?:node|nodejs|bun)$/.test(executable)) throw new Error('invalid deployed producer interpreter');
        return executable;
    }
    function hashEntrypoint(pid, command, expectedHash) {
        const file = `/proc/${pid}/root${command}`;
        const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK);
        try {
            const before = io.fstatSync(fd, { bigint: true }), keys = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
            if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > 4n * 1024n * 1024n) throw new Error('invalid pinned ALA entrypoint');
            const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
            let count, length = 0;
            while ((count = io.readSync(fd, buffer, 0, Math.min(buffer.length, 4 * 1024 * 1024 + 1 - length), null)) > 0) {
                length += count;
                if (length > 4 * 1024 * 1024) throw new Error('bounded ALA entrypoint exceeded');
                hash.update(buffer.subarray(0, count));
            }
            const after = io.fstatSync(fd, { bigint: true }), bound = io.lstatSync(file, { bigint: true });
            if (BigInt(length) !== before.size || !bound.isFile() || keys.some(key => before[key] !== after[key] || after[key] !== bound[key])) throw new Error('ALA entrypoint changed during snapshot');
            const sha256 = hash.digest('hex');
            if (sha256 !== expectedHash) throw new Error('frozen ALA entrypoint hash drift');
            return { sha256, stat: Object.fromEntries(keys.map(key => [key, before[key]])) };
        } finally { io.closeSync(fd); }
    }
    const hashAlaEntrypoint = pid => hashEntrypoint(pid, selection.alaBinding.command, selection.alaBinding.hashes['bin/ala.mjs']);
    const resident = selection.residentRecords;
    if (resident !== undefined) {
        if (!Array.isArray(resident) || resident.length > 512 || !/^[a-f0-9]{64}$/.test(selection.serviceSha256 || '')) throw new Error('invalid trusted resident inventory');
        if (new Set(resident.map(record => record.runId)).size !== resident.length) throw new Error('ambiguous trusted resident run');
    }
    function namespacePids(pid) {
        const text = readBounded(`/proc/${pid}/status`).toString('utf8');
        const matches = [...text.matchAll(/^NSpid:\s*([0-9]+(?:[\t ]+[0-9]+)*)\s*$/gmu)];
        if (matches.length !== 1) throw new Error('invalid resident namespace PID');
        const pids = matches[0][1].trim().split(/\s+/u).map(Number);
        if (pids.length > 32 || pids.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('invalid resident namespace PID');
        return pids;
    }
    const namespacePid = pid => {
        const pids = namespacePids(pid);
        if (pids.length < namespaceDepth) throw new Error('resident process is outside its container PID namespace');
        return pids[namespaceDepth - 1];
    };
    const init = readProcess(rootPid);
    const namespaceDepth = resident ? namespacePids(init.pid).length : 0;
    const rows = new Map();
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isSafeInteger(pid)) throw new Error('invalid inventory PID');
        try {
            // Inventory stat/namespace only; read argv only for the selected
            // namespace or a descendant needed by the native ancestry proof.
            const row = stat(pid);
            if (row.state !== 'Z') rows.set(pid, { ...row, pidNamespace: namespace(pid) });
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    const candidates = [], wrappers = [];
    function belowInit(row) {
        const seen = new Set();
        while (row && !seen.has(row.pid) && seen.size < 256) {
            if (row.pid === init.pid) return true;
            seen.add(row.pid); row = rows.get(row.ppid);
        }
        return false;
    }
    for (const row of rows.values()) {
        if (resident ? !belowInit(row) : row.pidNamespace !== init.pidNamespace) continue;
        let observed;
        try { observed = readProcess(row.pid); }
        catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
        if (observed.startToken !== row.startToken || observed.ppid !== row.ppid
            || observed.pidNamespace !== row.pidNamespace) throw new Error('inventory process changed during snapshot');
        const exactAla = observed.argv[1] === selection.alaBinding.command;
        const exactWrapper = observed.argv[1] === workflowScript;
        const advertised = observed.argv.some(value => value === '--control-stdin' || value.startsWith('--control-stdin='));
        if (!exactAla && !exactWrapper) {
            if (advertised) throw new Error('unknown control-stdin producer advertisement');
            continue;
        }
        const executable = interpreter(observed), context = turnContext(observed.argv, exactWrapper);
        if (context.cwd !== expectedCwd) continue;
        if (exactWrapper) wrappers.push({ ...observed, context, executable });
        else candidates.push({ ...observed, context, executable, entrypoint: hashAlaEntrypoint(observed.pid) });
    }
    function producerProof(candidate) {
        if (resident) {
            const records = resident.filter(record => record.cwd === expectedCwd && record.sessionId === candidate.context.sessionId
                && record.turnId === candidate.context.turnId);
            if (records.length !== 1) throw new Error('missing or ambiguous trusted resident run');
            const record = records[0];
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.runId || '') || !['copilot', 'task'].includes(record.kind)) throw new Error('resident run identity mismatch');
            let launch = namespacePid(candidate.pid) === record.pid && candidate.startToken === record.pidStamp ? candidate : null;
            const chain = [], seen = new Set([candidate.pid]); let pid = candidate.ppid;
            while (rows.has(pid) && !seen.has(pid) && chain.length < 256) {
                seen.add(pid); const row = readProcess(pid), prior = rows.get(pid);
                if (row.startToken !== prior.startToken || row.ppid !== prior.ppid || row.pidNamespace !== prior.pidNamespace) throw new Error('resident service ancestry changed');
                chain.push(row);
                if (namespacePid(pid) === record.pid && row.startToken === record.pidStamp) {
                    if (launch) throw new Error('ambiguous resident launch incarnation');
                    launch = row;
                }
                if (row.pidNamespace === init.pidNamespace && namespacePid(pid) === record.servicePid) {
                    const script = '/code/server/main.mjs';
                    if (row.argv[1] !== script || !belowInit(row) || !launch || launch.pid === row.pid) throw new Error('wrong resident service or launch identity');
                    const executable = interpreter(row), entrypoint = hashEntrypoint(pid, script, selection.serviceSha256);
                    const rootChain = [row], roots = new Set([row.pid]); let ancestor = row;
                    while (ancestor.pid !== init.pid) {
                        if (!rows.has(ancestor.ppid) || roots.has(ancestor.ppid) || rootChain.length >= 256) throw new Error('resident service lost init ancestry');
                        ancestor = readProcess(ancestor.ppid); const original = rows.get(ancestor.pid);
                        if (ancestor.startToken !== original.startToken || ancestor.ppid !== original.ppid
                            || ancestor.pidNamespace !== init.pidNamespace) throw new Error('resident service init ancestry changed');
                        roots.add(ancestor.pid); rootChain.push(ancestor);
                    }
                    return { kind: record.kind === 'task' ? 'workflow' : 'copilot', script, row, chain, rootChain, launch, executable, entrypoint, record };
                }
                pid = row.ppid;
            }
            throw new Error('missing exact resident service ancestry');
        }
        const chain = [], seen = new Set([candidate.pid]), proofs = [];
        let pid = candidate.ppid;
        while (rows.has(pid) && !seen.has(pid) && chain.length < 256) {
            seen.add(pid);
            const row = readProcess(pid), prior = rows.get(pid);
            if (row.startToken !== prior.startToken || row.ppid !== prior.ppid || row.pidNamespace !== init.pidNamespace) throw new Error('producer ancestry changed');
            chain.push(row);
            for (const kind of ['copilot', 'workflow']) {
                const root = kind === 'workflow' ? selection.workflowCodeRoot || selection.codeRoot : selection.codeRoot;
                const script = root + '/server/' + (kind === 'copilot' ? 'robot-cli.mjs' : 'robot-task.mjs');
                if (row.argv[1] !== script) continue;
                const executable = interpreter(row);
                const value = flag => {
                    if (row.argv.filter(argument => argument === flag || argument.startsWith(flag + '=')).length !== 1) throw new Error('invalid producer arguments');
                    const offset = row.argv.indexOf(flag);
                    if (offset < 0 || !row.argv[offset + 1] || row.argv[offset + 1].startsWith('--')) throw new Error('invalid producer value');
                    return row.argv[offset + 1];
                };
                if (value(kind === 'copilot' ? '--dir' : '--cwd') !== expectedCwd
                    || kind === 'workflow' && value('--session-id') !== candidate.context.sessionId) throw new Error('producer context mismatch');
                if (kind === 'workflow' && !wrappers.some(wrapper => wrapper.pid === row.pid)) throw new Error('unqualified workflow producer');
                proofs.push({ kind, script, row, chain: [...chain], executable });
            }
            pid = row.ppid;
        }
        if (proofs.length !== 1) throw new Error('missing or ambiguous exact deployed producer ancestry');
        return proofs[0];
    }
    const candidateSessions = new Set(), wrapperSessions = new Set(), associated = new Set();
    for (const wrapper of wrappers) {
        if (wrapperSessions.has(wrapper.context.sessionId)) throw new Error('ambiguous workflow producer session');
        wrapperSessions.add(wrapper.context.sessionId);
    }
    for (const candidate of candidates) {
        if (candidateSessions.has(candidate.context.sessionId)) throw new Error('expected exactly one selected native-turn parent per session');
        candidateSessions.add(candidate.context.sessionId);
        candidate.producer = producerProof(candidate);
        if (candidate.producer.kind === 'workflow') associated.add(candidate.producer.row.pid);
    }
    if (resident && candidates.length !== resident.length) throw new Error('trusted resident run is missing its exact ALA process');
    function finalAla(candidate) {
        const current = hashAlaEntrypoint(candidate.pid);
        if (Object.keys(current.stat).some(key => current.stat[key] !== candidate.entrypoint.stat[key])
            || interpreter(candidate) !== candidate.executable) throw new Error('ALA entrypoint or interpreter changed during final fence');
        if (resident) {
            const proof = candidate.producer, currentService = hashEntrypoint(proof.row.pid, proof.script, selection.serviceSha256);
            if (Object.keys(currentService.stat).some(key => currentService.stat[key] !== proof.entrypoint.stat[key])
                || namespacePid(proof.launch.pid) !== proof.record.pid || namespacePid(proof.row.pid) !== proof.record.servicePid) throw new Error('resident identity changed during final fence');
        }
    }
    if (selection.kind === 'census') {
        if (candidates.length + wrappers.filter(wrapper => !associated.has(wrapper.pid)).length > 512) throw new Error('bounded native census exceeded');
        const census = candidates.map(candidate => {
            const producer = candidate.producer;
            for (const row of [init, candidate, ...producer.chain, ...(producer.rootChain || [])]) if (!same(row, readProcess(row.pid))) throw new Error('census identity changed during final fence');
            finalAla(candidate);
            if (interpreter(producer.row) !== producer.executable) throw new Error('producer executable changed during final fence');
            return { kind: 'ala-turn', ...identity(candidate), ...candidate.context, producerKind: producer.kind,
                entrypoint: selection.alaBinding.command, sha256: candidate.entrypoint.sha256,
                ...(resident ? { runId: producer.record.runId, launch: identity(producer.launch) } : {}) };
        });
        for (const wrapper of wrappers) if (!associated.has(wrapper.pid)) {
            if (!same(init, readProcess(init.pid)) || !same(wrapper, readProcess(wrapper.pid))
                || interpreter(wrapper) !== wrapper.executable) throw new Error('pending producer changed during final fence');
            census.push({ kind: 'producer-pending', ...identity(wrapper), script: workflowScript, ...wrapper.context });
        }
        if (!same(init, readProcess(init.pid))) throw new Error('census init changed during final fence');
        return census.sort((a, b) => a.pid - b.pid);
    }
    const selectedCandidates = selection ? candidates.filter(row => row.context.sessionId === selection.sessionId && row.context.turnId === selection.turnId) : candidates;
    if (selectedCandidates.length !== 1) throw new Error('expected exactly one selected native-turn parent');
    const ala = selectedCandidates[0];
    const producer = ala.producer;
    if (producer.kind !== selection.kind) throw new Error('selected producer kind mismatch');
    if (ala.pid === init.pid) throw new Error('native-turn parent cannot be container init');
    function ancestry(pid) {
        const chain = [], seen = new Set();
        while (rows.has(pid) && !seen.has(pid) && chain.length < 256) {
            if (pid === ala.pid) return chain;
            seen.add(pid);
            const row = rows.get(pid);
            chain.push(row);
            pid = row.ppid;
        }
        return null;
    }
    const matches = [];
    for (const row of rows.values()) {
        if (row.pid === ala.pid) continue;
        const chain = ancestry(row.pid);
        if (!chain) continue;
        // A selected chain disappearing is a broken proof, not an unrelated
        // disappearing inventory entry that can be ignored.
        const observed = readProcess(row.pid);
        if (observed.startToken !== row.startToken || observed.ppid !== row.ppid
            || observed.pidNamespace !== row.pidNamespace) throw new Error('native inventory changed during snapshot');
        const executable = io.readlinkSync('/proc/' + row.pid + '/exe');
        if (typeof executable !== 'string' || executable.length > 4096 || !executable.startsWith('/')) throw new Error('invalid process executable');
        if (/(?:^|\/)bwrap$/.test(executable)) continue;
        const script = /(?:^|\/)(?:node|nodejs|bun)$/.test(executable) && observed.argv[1] === native.realpath;
        if (executable !== native.realpath && !script) continue;
        const proof = chain.map(member => {
            const stable = readProcess(member.pid);
            if (stable.startToken !== member.startToken || stable.ppid !== member.ppid
                || stable.pidNamespace !== member.pidNamespace) throw new Error('native ancestry changed during snapshot');
            if (member.pid === row.pid && !same(observed, stable)) throw new Error('native argv changed during snapshot');
            return stable;
        });
        const sha256 = hashExecutable(row.pid);
        matches.push({ row: observed, executable, scriptPath: script ? native.realpath : null, sha256, proof });
    }
    if (matches.length !== 1) throw new Error('expected exactly one frozen native CLI process');
    const selected = matches[0];
    hashExecutable(selected.row.pid);
    for (const row of [init, ala, ...selected.proof, ...(producer?.chain || []), ...(producer?.rootChain || [])]) {
        if (!same(row, readProcess(row.pid))) throw new Error('native identity changed during final fence');
    }
    if (io.readlinkSync('/proc/' + selected.row.pid + '/exe') !== selected.executable) throw new Error('native executable changed during final fence');
    if (producer && io.readlinkSync('/proc/' + producer.row.pid + '/exe') !== producer.executable) throw new Error('producer executable changed during final fence');
    finalAla(ala);
    return { containerInit: identity(init), ala: { ...identity(ala), ...ala.context,
        entrypoint: selection.alaBinding.command, sha256: ala.entrypoint.sha256 },
        ...(resident ? { runId: producer.record.runId, launch: identity(producer.launch), serviceAncestry: producer.rootChain.map(identity) } : {}),
        ...(producer ? { producer: { ...identity(producer.row), kind: producer.kind, script: producer.script }, producerAncestry: producer.chain.map(identity) } : {}),
        native: { ...identity(selected.row), executable: native.realpath, actualExecutable: selected.executable,
            scriptPath: selected.scriptPath, sha256: selected.sha256 }, ancestry: selected.proof.map(identity) };
}

export const NATIVE_PROCESS_SNAPSHOT_SOURCE = `
import fs from 'node:fs';
import crypto from 'node:crypto';
${validateNativeAlaBinding.toString()}
${collectNativeProcessSnapshot.toString()}
${residentProcReadBridge.toString()}
if (!/^[1-9][0-9]*$/.test(process.argv[1] || '')) throw new Error('invalid exact init PID argument');
const selection = process.argv[4] ? JSON.parse(process.argv[4]) : null;
const bridge = residentProcReadBridge(fs, selection?.procReadProofs);
const identity = await collectNativeProcessSnapshot(Number(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3], bridge.io, selection);
process.stdout.write(JSON.stringify(selection?.procReadProofs ? { identity, ownerInit: bridge.identity(1), procReads: [...bridge.used] } : identity));
`;

// Inspect only process identity, argv and the selected public executable. Never
// read process environments, homes, credential files, logs or managed sources.
export function normalizeNativeProcessError(error, { env = process.env } = {}) {
    const own = key => {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(error, key);
            return descriptor && 'value' in descriptor ? descriptor.value : undefined;
        } catch { return undefined; }
    };
    const rawCode = own('code'), rawSignal = own('signal'), rawKilled = own('killed');
    let code = Number.isSafeInteger(rawCode) || typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'unavailable';
    let signal = typeof rawSignal === 'string' && /^SIG[A-Z0-9]{1,29}$/.test(rawSignal) ? rawSignal : 'unavailable';
    const killed = typeof rawKilled === 'boolean' ? rawKilled : 'unavailable';
    const rawStderr = own('stderr');
    let stderr = '[stderr unavailable]';
    try {
        if (typeof rawStderr === 'string') {
            stderr = rawStderr.length > 128 * 1024 || Buffer.byteLength(rawStderr) > 128 * 1024
                ? '[stderr omitted: input exceeds 128 KiB]' : rawStderr || '[stderr empty]';
        } else if (Buffer.isBuffer(rawStderr)) {
            const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get.call(rawStderr);
            if (byteLength > 128 * 1024) stderr = '[stderr omitted: input exceeds 128 KiB]';
            else {
                const copy = Buffer.alloc(byteLength);
                Uint8Array.prototype.set.call(copy, rawStderr);
                stderr = copy.toString('utf8') || '[stderr empty]';
            }
        }
        const safeEnv = Object.create(null);
        for (const name of Object.getOwnPropertyNames(env)) {
            const descriptor = Object.getOwnPropertyDescriptor(env, name);
            if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') safeEnv[name] = descriptor.value;
        }
        const secrets = collectSecrets(safeEnv), redact = createRedactor(secrets);
        if (typeof code === 'string' && redact(code) !== code) code = 'unavailable';
        if (redact(signal) !== signal) signal = 'unavailable';
        stderr = redactTraceText(redact(stderr));
        const residue = text => findSecretLeaks(text, secrets).length || findTraceCredentialResidue(text).length;
        if (residue(stderr)) stderr = '[REDACTED:RESIDUE]';
        const bytes = Buffer.from(stderr, 'utf8');
        if (bytes.length > 4096) {
            const marker = '\n[stderr middle omitted]\n';
            let head = 512;
            while ((bytes[head] & 0xc0) === 0x80) head -= 1;
            let tail = bytes.length - (4096 - head - Buffer.byteLength(marker));
            while ((bytes[tail] & 0xc0) === 0x80) tail += 1;
            stderr = bytes.subarray(0, head).toString('utf8') + marker + bytes.subarray(tail).toString('utf8');
        } else stderr = bytes.toString('utf8');
        if (residue(stderr)) stderr = '[REDACTED:RESIDUE]';
    } catch {
        stderr = '[REDACTED:RESIDUE]';
        if (typeof code === 'string') code = 'unavailable';
        signal = 'unavailable';
    }
    const status = `code=${code}; signal=${signal}; killed=${killed}`;
    const safe = new Error(`Native process evidence subprocess failed (${status}).`);
    delete safe.stack;
    Object.assign(safe, { name: 'NativeProcessEvidenceError', code, signal, killed, stderr,
        cause: Object.freeze({ name: 'NativeProcessExit', message: `${status}\nstderr:\n${stderr}` }) });
    return safe;
}

export async function nativeProcessIdentity(evidence, runtime, native, directoryName, selection) {
    if (selection?.residentBinding) return residentNativeProcessIdentity(evidence, runtime, native, directoryName, selection);
    validateNativeAlaBinding(selection?.alaBinding);
    assert.match(directoryName, /^[A-Za-z0-9_-]+$/);
    const workspaceRoot = assertBoxWorkspacePath(evidence?.workspaceRoot);
    assert.equal(evidence.workspaceHash, workspaceHash(workspaceRoot));
    const cwd = path.posix.join(workspaceRoot, directoryName);
    assert.match(runtime?.containerId, /^[a-f0-9]{64}$/);
    assert.match(evidence?.outerContainerId, /^[a-f0-9]{64}$/);
    const before = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(before?.Id, runtime.containerId);
    assert.equal(before?.State?.Running, true);
    assert.ok(Number.isSafeInteger(before.State.Pid) && before.State.Pid > 1);
    assert.match(before.State.StartedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    const result = await execute('podman', ['exec', evidence.outerContainerId, '/usr/local/bin/node', '--input-type=module', '--eval',
        NATIVE_PROCESS_SNAPSHOT_SOURCE, String(before.State.Pid), JSON.stringify(native), cwd, JSON.stringify(selection || null)], {
        timeout: 30_000, maxBuffer: 65536, killSignal: 'SIGKILL',
    }).catch(error => { throw normalizeNativeProcessError(error); });
    const identity = JSON.parse(result.stdout);
    if (selection.kind === 'census') assertNativeProcessCensus(identity, { cwd, ...selection });
    else assertNativeProcessIdentity(identity, native, { initPid: before.State.Pid, cwd, ...selection });
    const after = inspectNestedContainer(evidence.outerContainerId, runtime.containerId);
    assert.equal(after?.Id, before.Id);
    assert.equal(after?.State?.Running, true);
    assert.equal(after?.State?.Pid, before.State.Pid);
    assert.equal(after?.State?.StartedAt, before.State.StartedAt);
    return identity;
}

export async function residentNativeProcessIdentity(evidence, runtime, native, directoryName, selection, {
    executeImpl = execute, inspect = inspectNestedContainer,
} = {}) {
    validateNativeAlaBinding(selection.alaBinding);
    assert.match(directoryName, /^[A-Za-z0-9_-]+$/u);
    const workspaceRoot = assertBoxWorkspacePath(evidence.workspaceRoot), cwd = path.posix.join(workspaceRoot, directoryName);
    assert.equal(evidence.workspaceHash, workspaceHash(workspaceRoot));
    const binding = selection.residentBinding;
    assert.equal(binding.controller.id, runtime.containerId);
    assert.equal(binding.execution.id, binding.owner.containerId);
    assert.notEqual(binding.execution.id, binding.controller.id);
    const fence = () => {
        const controller = processRuntimeFence(inspect(evidence.outerContainerId, runtime.containerId));
        const execution = processRuntimeFence(inspect(evidence.outerContainerId, binding.owner.containerId));
        assert.deepEqual(controller, binding.controller, 'RoboTeam process container generation, source or mounts changed.');
        assert.deepEqual(execution, binding.execution, 'RoboWork process container generation, source or mounts changed.');
    };
    fence();
    const run = async args => {
        const result = await executeImpl('podman', args, { timeout: 30000, maxBuffer: 65536, killSignal: 'SIGKILL' })
            .catch(error => { throw normalizeNativeProcessError(error); });
        return JSON.parse(result.stdout);
    };
    const read = () => run(['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', binding.owner.containerId,
        '/usr/local/bin/node', '--input-type=module', '--eval', buildResidentRunProgram({ expectedRepository: binding.repository,
            contractFiles: binding.contractFiles, contractHashes: binding.codeHashes, robotId: native.robotId, cwd })]);
    const metadata = await read();
    assert.deepEqual(metadata.codeHashes, binding.codeHashes);
    const controllerCensusCommand = ['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', runtime.containerId,
        '/usr/local/bin/node', '--input-type=module', '--eval', buildControllerProducerCensusProgram(1, {
            cwd, codeRoot: selection.codeRoot, workflowCodeRoot: selection.workflowCodeRoot,
            scriptSha256: binding.controllerHashes['server/robot-task.mjs'],
        })];
    const controllerCensus = await run(controllerCensusCommand);
    assertNativeProcessCensus(controllerCensus, { cwd, ...selection });
    assert.ok(controllerCensus.every(row => row.kind === 'producer-pending'), 'Controller census cannot assert native authority.');
    const retained = selection.retainedProofs || [];
    assert.ok(Array.isArray(retained) && retained.length <= 512);
    for (const proof of retained) assert.ok(retainedResidentProofs.has(proof), 'Continuity requires the original in-memory verified proof, never project or JSON authority.');
    assert.equal(new Set(retained.map(proof => proof.runId)).size, retained.length);
    const { residentBinding: _binding, retainedProofs: _retained, ...selected } = selection;
    const nativeSelection = { ...selected, residentRecords: metadata.records.filter(record => record.state !== 'starting'),
        serviceSha256: binding.codeHashes['server/main.mjs'] };
    const controllerProofs = new Map();
    const controllerCommands = new Map();
    for (const record of metadata.records) {
        const prior = retained.find(proof => proof.runId === record.runId);
        if (prior) {
            assert.deepEqual(record, prior.residentRecord, 'Reattachment must use the same authoritative resident run and owner.');
            assert.deepEqual(binding.execution, prior.executionRuntime, 'Reattachment changed RoboWork generation or mounts.');
            assert.notEqual(binding.controller.id, prior.controllerRuntime.id, 'Reattachment must prove the replacement RoboTeam generation.');
            assert.equal(record.kind, 'task');
        }
        const relative = `server/${record.kind === 'task' ? 'robot-task' : 'robot-cli'}.mjs`;
        const command = ['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', runtime.containerId,
            '/usr/local/bin/node', '--input-type=module', '--eval',
            buildControllerProducerProgram(1, record,
                { codeRoot: selection.codeRoot, workflowCodeRoot: selection.workflowCodeRoot,
                    scriptSha256: binding.controllerHashes[relative], ...(prior ? { attach: true } : {}) })];
        controllerCommands.set(record.runId, command);
        const proof = await run(command);
        assert.equal(proof.runId, record.runId);
        assert.equal(proof.containerInit.pid, 1);
        if (prior) {
            assert.equal(proof.attachRun, record.runId, 'Replacement producer must name the exact resident run.');
            assert.notDeepEqual(proof.containerInit, prior.controller.containerInit, 'Replacement controller process incarnation is unchanged.');
        } else assert.equal(proof.producer.startToken, record.producer.startStamp);
        assert.equal(proof.producer.sha256, binding.controllerHashes[relative]);
        assert.equal(proof.producer.script, `${record.kind === 'task' ? selection.workflowCodeRoot || selection.codeRoot : selection.codeRoot}/${relative}`);
        assert.equal(proof.producer.kind, record.kind === 'task' ? 'workflow' : 'copilot');
        assert.ok(Array.isArray(proof.producerAncestry) && proof.producerAncestry.length > 0 && proof.producerAncestry.length <= 256);
        for (const [index, row] of proof.producerAncestry.entries()) {
            assert.equal(row.pidNamespace, proof.containerInit.pidNamespace);
            assert.equal(index ? proof.producerAncestry[index - 1].ppid : proof.producer.pid, row.pid);
        }
        assert.equal(proof.producerAncestry.at(-1).ppid, proof.containerInit.pid);
        controllerProofs.set(record.runId, proof);
    }
    // The source and native process roots live in RoboWork's user namespace.
    // The outer Box cannot ptrace those roots even when their stat is visible.
    const procCommand = ['exec', evidence.outerContainerId, '/usr/local/bin/node', '--input-type=module', '--eval',
        buildBoxProcReadProgram(binding.execution.pid)];
    const procBefore = await run(procCommand);
    assert.equal(procBefore.init.boxPid, binding.execution.pid);
    assert.equal(procBefore.init.namespacePids.at(-1), 1);
    nativeSelection.procReadProofs = procBefore.processes;
    const observed = await run(['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', binding.owner.containerId,
        '/usr/local/bin/node', '--input-type=module', '--eval',
        NATIVE_PROCESS_SNAPSHOT_SOURCE, '1', JSON.stringify(native), cwd, JSON.stringify(nativeSelection)]);
    const identity = observed.identity;
    assert.deepEqual(observed.ownerInit, { pid: 1, ppid: 0, startToken: procBefore.init.startToken, pidNamespace: procBefore.init.pidNamespace });
    const procAfter = await run(procCommand);
    assert.deepEqual(procAfter.init, procBefore.init, 'RoboWork init changed during owner process reads.');
    assert.ok(Array.isArray(observed.procReads) && observed.procReads.length <= 512 && new Set(observed.procReads).size === observed.procReads.length);
    for (const pid of observed.procReads) {
        const first = procBefore.processes.find(row => row.pid === pid), last = procAfter.processes.find(row => row.pid === pid);
        assert.ok(first && last, 'Missing exact Box process-link incarnation.');
        assert.deepEqual(last, first, 'Box process-link namespace or incarnation changed during owner reads.');
    }
    if (selection.kind === 'census') {
        assertNativeProcessCensus(identity, { cwd, ...nativeSelection });
        for (const row of identity) assert.ok(controllerProofs.has(row.runId), 'Census is missing its exact controller proof.');
    } else {
        assertNativeProcessIdentity(identity, native, { initPid: 1, cwd, ...nativeSelection });
        assert.ok(controllerProofs.has(identity.runId), 'Native process has no exact controller proof.');
    }
    assert.deepEqual(await read(), metadata, 'Authoritative run identity changed during the two-container proof.');
    for (const [runId, command] of controllerCommands) {
        assert.deepEqual(await run(command), controllerProofs.get(runId), 'Exact controller producer changed before native proof settlement.');
    }
    assert.deepEqual(await run(controllerCensusCommand), controllerCensus, 'Controller pending-wrapper census changed during native proof settlement.');
    fence();
    const finish = row => {
        const record = metadata.records.find(value => value.runId === row.runId);
        const prior = retained.find(proof => proof.runId === row.runId);
        if (prior) {
            if (selection.kind === 'census') {
                for (const key of ['pid', 'ppid', 'startToken', 'pidNamespace', 'cwd', 'sessionId', 'turnId', 'entrypoint', 'sha256']) {
                    assert.deepEqual(row[key], prior.ala[key], 'The resident ALA process changed across controller restart.');
                }
                assert.deepEqual(row.launch, prior.launch);
            } else {
                for (const key of ['runId', 'containerInit', 'ala', 'launch', 'producer', 'producerAncestry', 'serviceAncestry', 'native', 'ancestry']) {
                    assert.deepEqual(row[key], prior[key], 'The native process or source identity changed across controller restart.');
                }
            }
        }
        return sealResidentProof({ ...row, controller: controllerProofs.get(row.runId), residentRecord: record,
            controllerRuntime: binding.controller, executionRuntime: binding.execution });
    };
    if (selection.kind === 'census') {
        const pending = controllerCensus.filter(row => ![...controllerProofs].some(([runId, proof]) => {
            const record = metadata.records.find(value => value.runId === runId);
            return row.cwd === record.cwd && row.sessionId === record.sessionId
                && ['pid', 'ppid', 'startToken', 'pidNamespace', 'script'].every(key => row[key] === proof.producer[key]);
        }));
        const starting = metadata.records.filter(record => record.state === 'starting').map(record => ({
            kind: 'resident-pending', runId: record.runId, robotId: record.robotId, cwd: record.cwd,
            sessionId: record.sessionId, turnId: record.turnId, ownerPrincipal: record.ownerPrincipal,
        }));
        assert.ok(identity.length + pending.length + starting.length <= 512, 'Bounded combined resident census exceeded.');
        return [...identity.map(finish), ...pending, ...starting];
    }
    return finish(identity);
}

export function assertNativeProcessIdentity(identity, native, expectedContext) {
    const alaBinding = validateNativeAlaBinding(expectedContext?.alaBinding);
    const residentInit = expectedContext?.residentRecords && expectedContext.initPid === 1;
    assert.ok(Number.isSafeInteger(expectedContext?.initPid) && (expectedContext.initPid > 1 || residentInit));
    assert.ok(typeof expectedContext.cwd === 'string' && path.posix.isAbsolute(expectedContext.cwd)
        && expectedContext.cwd !== '/' && path.posix.normalize(expectedContext.cwd) === expectedContext.cwd
        && !/[\u0000-\u001f\u007f]/.test(expectedContext.cwd));
    const processIdentity = (value, init = false) => {
        assert.ok(Number.isSafeInteger(value?.pid) && (value.pid > 1 || init && residentInit && value.pid === 1));
        assert.ok(Number.isSafeInteger(value.ppid) && value.ppid >= 0);
        assert.match(value.startToken, /^[1-9][0-9]{0,19}$/);
        assert.match(value.pidNamespace, /^pid:\[[1-9][0-9]{0,19}\]$/);
    };
    processIdentity(identity?.containerInit, true);
    for (const value of [identity?.ala, identity?.native]) processIdentity(value);
    assert.equal(identity.containerInit.pid, expectedContext?.initPid);
    assert.equal(identity.ala.cwd, expectedContext?.cwd);
    if (!expectedContext.residentRecords) assert.equal(identity.ala.pidNamespace, identity.containerInit.pidNamespace);
    assert.equal(identity.ala.entrypoint, alaBinding.command);
    assert.equal(identity.ala.sha256, alaBinding.hashes['bin/ala.mjs']);
    for (const key of ['sessionId', 'turnId']) {
        assert.ok(typeof identity.ala[key] === 'string' && identity.ala[key].length > 0
            && identity.ala[key].length <= 4096 && !identity.ala[key].startsWith('--')
            && !/[\u0000-\u001f\u007f]/.test(identity.ala[key]));
        if (expectedContext[key] !== undefined) assert.equal(identity.ala[key], expectedContext[key]);
    }
    if (expectedContext.kind && expectedContext.kind !== 'census') {
        processIdentity(identity.producer);
        assert.equal(identity.producer.kind, expectedContext.kind);
        const root = expectedContext.kind === 'workflow' ? expectedContext.workflowCodeRoot || expectedContext.codeRoot : expectedContext.codeRoot;
        assert.equal(identity.producer.script, expectedContext.residentRecords ? '/code/server/main.mjs'
            : `${root}/server/${expectedContext.kind === 'copilot' ? 'robot-cli.mjs' : 'robot-task.mjs'}`);
        assert.equal(identity.producer.pidNamespace, identity.containerInit.pidNamespace);
        assert.ok(Array.isArray(identity.producerAncestry) && identity.producerAncestry.length > 0);
        identity.producerAncestry.forEach((row, index) => {
            processIdentity(row);
            assert.equal(index ? identity.producerAncestry[index - 1].ppid : identity.ala.ppid, row.pid);
        });
        assert.equal(identity.producerAncestry.at(-1).pid, identity.producer.pid);
        if (expectedContext.residentRecords) {
            const records = expectedContext.residentRecords.filter(record => record.runId === identity.runId);
            assert.equal(records.length, 1, 'Native proof must identify exactly one trusted resident run.');
            assert.equal(records[0].sessionId, identity.ala.sessionId); assert.equal(records[0].turnId, identity.ala.turnId);
            processIdentity(identity.launch);
            assert.equal(records[0].pidStamp, identity.launch.startToken); assert.equal(records[0].cwd, identity.ala.cwd);
            const launchPath = [identity.ala, ...identity.producerAncestry];
            assert.ok(launchPath.some(row => ['pid', 'ppid', 'startToken', 'pidNamespace'].every(key => row[key] === identity.launch[key])),
                'Trusted launch must be ALA or an exact ancestor between ALA and the resident service.');
            assert.ok(Array.isArray(identity.serviceAncestry) && identity.serviceAncestry.length > 1 && identity.serviceAncestry.length <= 256);
            identity.serviceAncestry.forEach((row, index) => {
                processIdentity(row, index === identity.serviceAncestry.length - 1); assert.equal(row.pidNamespace, identity.containerInit.pidNamespace);
                if (index) assert.equal(identity.serviceAncestry[index - 1].ppid, row.pid);
            });
            assert.equal(identity.serviceAncestry[0].pid, identity.producer.pid);
            assert.equal(identity.serviceAncestry.at(-1).pid, identity.containerInit.pid);
        }
    }
    assert.notEqual(identity.ala.pid, identity.containerInit.pid);
    assert.notEqual(identity.ala.pid, identity.native.pid);
    assert.notEqual(identity.containerInit.pid, identity.native.pid);
    assert.equal(identity.native.sha256, native.sha256, 'The actual running native executable must match the frozen hash.');
    assert.equal(identity.native.executable, native.realpath);
    if (identity.native.scriptPath === null) assert.equal(identity.native.actualExecutable, native.realpath);
    else {
        assert.equal(identity.native.scriptPath, native.realpath);
        assert.match(identity.native.actualExecutable, /(?:^|\/)(?:node|nodejs|bun)$/);
    }
    assert.ok(Array.isArray(identity.ancestry) && identity.ancestry.length > 0 && identity.ancestry.length <= 256);
    const pids = new Set([identity.ala.pid]);
    identity.ancestry.forEach((row, index) => {
        processIdentity(row);
        assert.ok(!pids.has(row.pid));
        pids.add(row.pid);
        assert.equal(row.ppid, identity.ancestry[index + 1]?.pid ?? identity.ala.pid);
    });
    const first = identity.ancestry[0];
    for (const key of ['pid', 'ppid', 'startToken', 'pidNamespace']) assert.equal(first[key], identity.native[key]);
}

export function assertNativeProcessCensus(rows, expectedContext) {
    const binding = validateNativeAlaBinding(expectedContext?.alaBinding);
    assert.ok(Array.isArray(rows) && rows.length <= 512, 'Invalid bounded native census.');
    const pids = new Set(), sessions = new Set();
    let previous = 0;
    for (const row of rows) {
        assert.ok(row && typeof row === 'object' && !Array.isArray(row));
        assert.ok(['ala-turn', 'producer-pending'].includes(row.kind));
        const keys = ['kind', 'pid', 'ppid', 'startToken', 'pidNamespace', 'cwd', 'sessionId',
            ...(row.kind === 'ala-turn' ? ['turnId', 'producerKind', 'entrypoint', 'sha256', ...(expectedContext.residentRecords ? ['runId', 'launch'] : [])] : ['script'])];
        assert.deepEqual(Object.keys(row).sort(), keys.sort(), 'Unexpected native census authority fields.');
        assert.ok(Number.isSafeInteger(row.pid) && row.pid > 1 && row.pid > previous && !pids.has(row.pid));
        assert.ok(Number.isSafeInteger(row.ppid) && row.ppid >= 0);
        assert.match(row.startToken, /^[1-9][0-9]{0,19}$/); assert.match(row.pidNamespace, /^pid:\[[1-9][0-9]{0,19}\]$/);
        assert.equal(row.cwd, expectedContext.cwd); assert.match(row.sessionId, /^[A-Za-z0-9_-]{1,128}$/);
        assert.ok(!sessions.has(row.sessionId)); pids.add(row.pid); sessions.add(row.sessionId); previous = row.pid;
        if (row.kind === 'ala-turn') {
            assert.match(row.turnId, /^[A-Za-z0-9_-]{1,128}$/); assert.ok(['copilot', 'workflow'].includes(row.producerKind));
            assert.equal(row.entrypoint, binding.command); assert.equal(row.sha256, binding.hashes['bin/ala.mjs']);
            if (expectedContext.residentRecords) {
                assert.deepEqual(Object.keys(row.launch || {}).sort(), ['pid', 'pidNamespace', 'ppid', 'startToken']);
                assert.ok(Number.isSafeInteger(row.launch.pid) && row.launch.pid > 1 && Number.isSafeInteger(row.launch.ppid) && row.launch.ppid >= 0);
                assert.match(row.launch.startToken, /^[1-9][0-9]{0,19}$/u); assert.match(row.launch.pidNamespace, /^pid:\[[1-9][0-9]{0,19}\]$/u);
                const matches = expectedContext.residentRecords.filter(record => record.runId === row.runId
                    && record.sessionId === row.sessionId && record.turnId === row.turnId && record.pidStamp === row.launch?.startToken);
                assert.equal(matches.length, 1, 'Census row must bind one trusted resident run.');
            }
        } else {
            const root = expectedContext.workflowCodeRoot || expectedContext.codeRoot;
            assert.equal(row.script, `${root}/server/robot-task.mjs`);
        }
    }
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
