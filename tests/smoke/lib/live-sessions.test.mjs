import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { chromium, request } from '@playwright/test';
import { foreignAccount, assertLivePrincipals, assertNoNativeRefusal, workload, assertExecutionFile,
    parseSse, executionText, assertOrderedFrames, validateNativeEvidence, activeTurnProcesses,
    requiresCopilotSourceVerification, observeFinitePageWork, assertNativeProcessIdentity,
    liveRequest, openWatch, LIVE_BASE, replayApplicationMatches } from './live-sessions.mjs';

const ordinary = id => ({ canonicalId: id, canonicalUsername: `${id}@example.test`, roles: ['user'] });
const admin = { ...ordinary('admin'), roles: ['admin'] };
const foreignEnv = {
    SMOKE_LIVE_SESSIONS_FOREIGN_LOGIN_EMAIL: 'foreign@example.test',
    SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'password',
    SMOKE_LIVE_SESSIONS_FOREIGN_ACCOUNT_PASSWORD: 'private-fixture-password',
};

test('mutation sends the validated Origin and CSRF proof through actual APIRequestContext transport', async t => {
    const mutations = [];
    let origin;
    const server = http.createServer(async (incoming, response) => {
        response.setHeader('content-type', 'application/json');
        if (incoming.url === '/auth/token?agent=roboTeamAgent') {
            response.end(JSON.stringify({ browserMutation: { routeKey: 'roboTeamAgent', origin, csrfToken: 'fixture-csrf-proof' } }));
            return;
        }
        let body = '';
        for await (const chunk of incoming) body += chunk.toString();
        mutations.push({ method: incoming.method, origin: incoming.headers.origin,
            csrf: incoming.headers['x-ploinky-browser-csrf-token'], body, path: incoming.url });
        response.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    let context;
    t.after(async () => {
        try { await context?.dispose(); }
        finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
    context = await request.newContext({ baseURL: origin });
    const browserOrigin = origin;
    const page = { request: context, url: () => `${browserOrigin}/fixture` };
    const response = await liveRequest(page, 'fixture_run', 'stop', { method: 'POST', body: {},
        headers: { Origin: 'http://untrusted.invalid', 'X-Ploinky-Browser-CSRF-Token': 'untrusted-proof' } });
    assert.equal(response.status(), 200);
    assert.deepEqual(mutations, [{ method: 'POST', origin, csrf: 'fixture-csrf-proof', body: '{}', path: `${LIVE_BASE}/fixture_run/stop` }]);
    origin = 'http://foreign.invalid';
    await assert.rejects(liveRequest(page, 'fixture_run', 'stop', { method: 'POST', body: {} }));
    assert.equal(mutations.length, 1, 'a foreign proof origin must fail before mutation dispatch');
});

test('Watch selects one output container even when production output spans share its CSS class', async t => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`<div role="dialog" aria-label="Live Sessions">
        <button data-session-id="${LIVE_BASE}:fixture_run" data-session-action="attach">Watch</button>
        <div id="liveSessionsFrame"><pre class="live-session-output"><span class="live-session-output">same marker</span><span class="live-session-assistant">same marker</span></pre></div>
        <form class="live-session-message-form"></form>
    </div>`);
    const watch = await openWatch(page, 'fixture_run');
    assert.equal(await watch.output.count(), 1);
    assert.equal(await watch.output.evaluate(element => element.tagName), 'PRE');
    assert.equal(await watch.output.textContent(), 'same markersame marker');
    const applied = await watch.output.locator(':scope > span').evaluateAll(spans => spans.map(span => ({
        text: span.textContent || '', style: span.className.replace(/^live-session-/, ''),
    })));
    assert.equal(replayApplicationMatches([
        { event: 'output', id: '1', data: { text: 'same marker', style: 'output' } },
        { event: 'output', id: '2', data: { text: 'same marker', style: 'assistant' } },
    ], applied), true);
    await page.locator('#liveSessionsFrame').evaluate(frame => frame.append(frame.querySelector('pre').cloneNode(true)));
    await assert.rejects(openWatch(page, 'fixture_run'), /strict mode violation|exactly one output container/);
});

test('foreign account requires explicit validated method-specific inputs without echoing secrets', () => {
    assert.equal(foreignAccount(foreignEnv).signInMethod, 'password');
    for (const key of Object.keys(foreignEnv)) {
        const env = { ...foreignEnv }; delete env[key];
        assert.throws(() => foreignAccount(env), error => !error.message.includes('private-fixture-password'));
    }
    assert.throws(() => foreignAccount({ ...foreignEnv, SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'invalid' }));
    assert.throws(() => foreignAccount({ ...foreignEnv, SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'totp' }));
    assert.throws(() => foreignAccount({ ...foreignEnv, SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'emailCode' }));
    assert.equal(foreignAccount({ ...foreignEnv, SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'emailCode', SMOKE_EMAIL_CODE_COMMAND: 'fixture' }).signInMethod, 'emailCode');
});

test('role oracle refuses duplicate accounts, administrators posing as owners, guests and self-registered accounts', () => {
    assertLivePrincipals(admin, ordinary('owner'), ordinary('foreign'));
    for (const owner of [admin, { ...ordinary('owner'), roles: ['guest', 'user'] },
        { ...ordinary('owner'), roles: ['selfRegistered'] }, { ...ordinary('owner'), roles: ['admin', 'user'] }]) {
        assert.throws(() => assertLivePrincipals(admin, owner, ordinary('foreign')));
    }
    assert.throws(() => assertLivePrincipals(admin, ordinary('owner'), ordinary('owner')));
    assert.throws(() => assertLivePrincipals(admin, ordinary('owner'), { ...ordinary('foreign'), canonicalUsername: 'owner@example.test' }));
});

test('first native/provider refusal fails immediately instead of permitting fallback', () => {
    for (const text of ['[input error] unavailable', 'Not logged in', 'invalid API key', 'insufficient_quota',
        'rate limit reached', 'provider error', 'All models in tier exhausted', 'bwrap: denied']) {
        assert.throws(() => assertNoNativeRefusal(text), /do not retry or substitute/);
    }
    assert.doesNotThrow(() => assertNoNativeRefusal('LS_EXEC_ordinary_execution'));
});

test('real workload commands produce independently computed files, Unicode and literal HTML in external state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-workload-'));
    fs.chmodSync(root, 0o700);
    try {
        const work = workload('fixture_safe');
        assert.ok(!work.prompt.includes(work.first), 'the expected execution digest is absent from the prompt');
        assert.ok(!work.message.includes(work.second), 'receipt echo cannot contain the expected computed marker');
        for (const [command, filename, challenge, expected] of [
            [work.initialCommand, work.firstFile, work.initial, work.first],
            [work.ownerCommand, work.secondFile, work.followup, work.second],
        ]) {
            const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 10_000 });
            assert.equal(stdout.trim(), expected);
            assertExecutionFile(path.join(root, filename), challenge, expected);
        }
        assert.match(work.second, /雪_🙂_<img /);
        assert.throws(() => workload("unsafe'input"));
        const link = path.join(root, 'symlink');
        fs.symlinkSync(path.join(root, work.firstFile), link);
        assert.throws(() => assertExecutionFile(link, work.initial, work.first));
        assert.throws(() => assertExecutionFile(path.join(root, work.firstFile), work.followup, work.first));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SSE parser retains partial frames and excludes receipt/status echoes from execution evidence', () => {
    const first = parseSse(': heartbeat\r\n\r\nevent: output\r\nid: 1\r\ndata: {"text":"雪🙂","style":"assistant"}\r\n\r\nevent: out');
    assert.equal(first.remainder, 'event: out');
    assert.deepEqual(first.frames, [{ event: 'output', id: '1', data: { text: '雪🙂', style: 'assistant' } }]);
    const next = parseSse(first.remainder + 'put\nid: 2\ndata: {"text":"accepted marker","style":"user"}\n\nevent: output\nid: 3\ndata: {"text":"status marker","style":"status"}\n\n');
    assert.equal(executionText([...first.frames, ...next.frames]), '雪🙂');
    assert.equal(executionText(next.frames), '');
    assertOrderedFrames([...first.frames, ...next.frames]);
    assert.throws(() => assertOrderedFrames([first.frames[0], first.frames[0]]), /without duplicate/);
    assert.throws(() => assertOrderedFrames([]));
    assert.throws(() => parseSse('event: output\ndata: malformed\n\n'));
});

test('replay application matches independent event order while preserving identical tool and assistant text', () => {
    const frames = [
        { event: 'output', id: '10', data: { text: 'same execution marker\n', style: 'output' } },
        { event: 'status', id: '', data: { status: 'running' } },
        { event: 'output', id: '11', data: { text: 'same execution marker\n', style: 'assistant' } },
        { event: 'output', id: '12', data: { text: 'same execution marker\n', style: 'assistant' } },
    ];
    const applied = frames.filter(frame => frame.event === 'output').map(frame => ({ ...frame.data }));
    assert.equal(replayApplicationMatches(frames, applied), true, 'all three distinct events must be applied, including repeated text/style');
    assert.equal(replayApplicationMatches(frames, [applied[0], ...applied]), false, 'applying a replay event twice must fail');
    assert.equal(replayApplicationMatches(frames, applied.slice(1)), false, 'omitting a legitimate repeated event must fail');
    assert.equal(replayApplicationMatches(frames, [applied[1], applied[0], applied[2]]), false, 'event style/order must be preserved');
    assert.equal(replayApplicationMatches(frames, [...applied, { ...applied[2], text: 'changed' }]), false);
    assert.throws(() => replayApplicationMatches([frames[0], frames[0]], [applied[0], applied[0]]), /without duplicate/);
});

function nativeFixture() {
    const runtime = { containerId: 'runtime', containerName: 'robo', instanceId: 'instance', enableGeneration: 3 };
    const release = { imageDigest: `sha256:${'a'.repeat(64)}`, repositories: { explorer: { commit: 'b'.repeat(40) } },
        liveBox: { box: { containerId: 'outer' } } };
    const generation = 'c'.repeat(64);
    const record = { schemaVersion: 1, robotId: 'default-123456', workspaceRoot: '/fixture', outerContainerId: 'outer', imageDigest: release.imageDigest,
        repositories: release.repositories, initialRoboTeam: runtime,
        native: { backend: 'claude', model: 'configured-model', effort: 'configured-effort', version: '1.2.3',
            cliVersion: '1.2.3 (Claude Code)', sha256: 'd'.repeat(64), generation, cacheRoot: '/cache',
            executablePath: '/cache/shell/bin/claude', realpath: `/cache/claude/generations/${generation}/bin/claude` } };
    const config = { codingAgent: 'claude', models: { claude: 'configured-model' }, efforts: { claude: 'configured-effort' } };
    return { record, options: { release, runtime, workspaceRoot: '/fixture', config } };
}

test('native evidence binds full source/Box/workspace/config/initial runtime and rejects substitutions', () => {
    const { record, options } = nativeFixture();
    validateNativeEvidence(record, options);
    for (const mutate of [
        value => { value.outerContainerId = 'another'; }, value => { value.imageDigest = 'other'; },
        value => { value.workspaceRoot = '/another'; }, value => { value.repositories.explorer.commit = 'moved'; },
        value => { value.initialRoboTeam.containerId = 'replaced'; }, value => { value.native.backend = 'codex'; },
        value => { value.native.model = 'fallback'; }, value => { value.native.effort = 'fallback'; },
        value => { value.native.version = ''; }, value => { value.native.cliVersion = 'synthetic'; },
        value => { value.native.sha256 = 'unhashed'; }, value => { value.native.realpath = '/native-fixture'; },
    ]) {
        const candidate = structuredClone(record); mutate(candidate);
        assert.throws(() => validateNativeEvidence(candidate, options));
    }
    const replacement = { ...options, runtime: { ...options.runtime, containerId: 'replacement' }, initial: false };
    validateNativeEvidence(record, replacement);
    assert.throws(() => validateNativeEvidence({ ...record, native: { ...record.native, model: 'fallback' } }, replacement));
});

test('observer execution oracle distinguishes turn workers from observer/read-only inspection processes', () => {
    const worker = '123 12 node ala --turn-id real --control-stdin --cwd /fixture';
    assert.deepEqual(activeTurnProcesses([worker, '22 1 node server/main.mjs', '23 1 node --eval inspect']), [worker]);
    assert.equal(activeTurnProcesses([worker, worker.replace('123 ', '124 ')]).length, 2);
    assert.deepEqual(activeTurnProcesses([]), []);
});

test('actual native process oracle rejects executable drift and incomplete/reused process identities', () => {
    const native = nativeFixture().record.native;
    const identity = { ala: { pid: 20, startToken: '123' },
        native: { pid: 21, startToken: '124', sha256: native.sha256, executable: native.realpath } };
    assertNativeProcessIdentity(identity, native);
    for (const mutate of [
        value => { value.native.sha256 = 'changed'; }, value => { value.native.executable = '/fixture/binary'; },
        value => { value.native.pid = value.ala.pid; }, value => { value.native.startToken = ''; },
        value => { value.ala.pid = -1; }, value => { delete value.ala; },
    ]) {
        const changed = structuredClone(identity); mutate(changed);
        assert.throws(() => assertNativeProcessIdentity(changed, native));
    }
});

test('canonical source gate selects the new production native suite and preserves ordinary Copilot selection', () => {
    for (const specs of [[], ['specs/05-copilot-folder-launch.spec.mjs'], ['specs/07-live-sessions.spec.mjs'],
        ['specs/01-webtty-core.spec.mjs', 'specs/07-live-sessions.spec.mjs']]) assert.equal(requiresCopilotSourceVerification(specs), true);
    assert.equal(requiresCopilotSourceVerification(['specs/01-webtty-core.spec.mjs']), false);
    assert.equal(requiresCopilotSourceVerification(['specs/06-copilot-live-skills.spec.mjs']), false);
});

test('page quiescence waits for finite bodies and render settlement, excluding confirmed live SSE only', async () => {
    const page = new EventEmitter();
    let rendered = true;
    page.evaluate = async () => rendered;
    const finite = observeFinitePageWork(page);
    const request = {};
    page.emit('request', request);
    page.emit('response', { ok: () => true, headers: () => ({ 'content-type': 'application/json' }), request: () => request });
    await assert.rejects(finite.settle(10), /did not quiesce/);
    page.emit('requestfinished', request);
    rendered = false;
    await assert.rejects(finite.settle(10), /did not quiesce/);
    rendered = true;
    await finite.settle(10);
    const stream = {};
    page.emit('request', stream);
    page.emit('response', { ok: () => true, headers: () => ({ 'content-type': 'text/event-stream; charset=utf-8' }), request: () => stream });
    await finite.settle(10);
    const refusedStream = {};
    page.emit('request', refusedStream);
    page.emit('response', { ok: () => false, headers: () => ({ 'content-type': 'text/event-stream' }), request: () => refusedStream });
    await assert.rejects(finite.settle(10), /did not quiesce/);
    page.emit('requestfailed', refusedStream);
    await finite.settle(10);
});
