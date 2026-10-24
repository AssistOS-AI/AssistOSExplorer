import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { siblingPath } from '../../helpers/sibling-roots.mjs';

// The actual unchanged WebTTY browser client (Ploinky blob d497f20a232f675c53d32ccb5169ebc60f5aaad7) runs against an
// independent server process, so a blocked test process never pauses the server's replies.
const SESSION_ID = 'S'.repeat(32);
const VIEW_ID = 'V'.repeat(32);
const STREAM_PATH = `/webtty/sessions/${SESSION_ID}/stream?view=${VIEW_ID}`;
const INTENT_PATH = `/webtty/sessions/${SESSION_ID}/close-intents`;
const PRIOR_SECRET = 'private-fixture-value';
const NEW_SECRET = 'private-new-session';
const PRINCIPAL = { id: 'USER.Owner', roles: ['admin'] };
const refusalBody = (mode, requestPath) => (mode === 'sso'
    ? { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo: requestPath })}` }
    : { ok: false, error: 'not_found' });

if (process.argv.includes('--router-recovery-fixture-server')) {
    const client = fs.readFileSync(process.argv.at(-1));
    let mode = 'sso';
    let holdAt = 0;
    let holdHeaders = false;
    let holdIntentBody = false;
    let badProbe = false;
    let fault = false;
    let count = 0;
    const events = [];
    const held = new Set();
    const streams = new Set();
    const waiters = [];
    const record = (kind, more = {}) => { events.push({ kind, at: Date.now(), ...more }); };
    const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const resolveWaiters = () => {
        for (const waiter of [...waiters]) {
            if (count >= waiter.count) { json(waiter.res, 200, { count, events }); waiters.splice(waiters.indexOf(waiter), 1); }
        }
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/settings') {
            mode = url.searchParams.get('mode');
            holdAt = Number(url.searchParams.get('holdAt'));
            holdHeaders = url.searchParams.get('headers') === '1';
            holdIntentBody = url.searchParams.get('intentBody') === 'hold';
            badProbe = url.searchParams.get('probe') === 'bad';
            return json(res, 200, { ok: true });
        }
        if (url.pathname === '/state') return json(res, 200, { count, events });
        if (url.pathname === '/auth/token') {
            // The prior SSO session expired with the Router restart; a local JWT survives it.
            return mode === 'sso' ? json(res, 401, { ok: false, error: 'session_expired' }) : json(res, 200, { user: PRINCIPAL });
        }
        if (url.pathname === '/other') {
            res.writeHead(200, { 'content-type': 'text/html' });
            return res.end(`<script>window.otherSource=new EventSource(${JSON.stringify(STREAM_PATH)})</script>`);
        }
        if (url.pathname === '/wait') {
            const needed = Number(url.searchParams.get('count'));
            if (count >= needed) return json(res, 200, { count, events });
            waiters.push({ count: needed, res });
            return undefined;
        }
        if (url.pathname === '/fault') {
            fault = true;
            record('fault');
            for (const stream of streams) stream.socket.destroy();
            streams.clear();
            return json(res, 200, { ok: true });
        }
        if (url.pathname === '/cleanup-marker') { record('cleanup-complete'); return json(res, 200, { ok: true }); }
        if (url.pathname === '/webtty.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(client); }
        if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        if (url.pathname === '/webtty/') {
            res.writeHead(200, { 'content-type': 'text/html' });
            return res.end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${['directory', 'target', 'access', 'role', 'profile', 'status', 'status-dot', 'dimensions', 'message', 'terminal'].map((id) => `<div id="${id}"></div>`).join('')}<button id="kill">Kill</button><script>
window.Terminal=class{constructor(){this.options={};this.cols=80;this.rows=24;window.__terminal=this;}loadAddon(){}open(){}onData(){}reset(){}write(){}focus(){}};
window.FitAddon={FitAddon:class{fit(){}}};window.__ploinkyTakeWebttyHandoff=()=>({kind:'launch',value:'fixture-only'});
</script><script src="/webtty.js"></script></body></html>`);
        }
        if (url.pathname === '/webtty/sessions' && req.method === 'POST') {
            return json(res, 200, { session: { id: SESSION_ID, role: 'owner', closePolicy: 'keep', target: { kind: 'box', label: 'Fixture', access: 'rw', cwdDisplay: '/fixture' } }, view: { id: VIEW_ID } });
        }
        if (req.method === 'DELETE') { record('delete'); return json(res, mode === 'sso' ? 401 : 404, refusalBody(mode, req.url)); }
        if (url.pathname === INTENT_PATH) {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            let validBody = false;
            try { assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { view: VIEW_ID, policy: 'keep' }); validBody = true; } catch { /* recorded below */ }
            record('close-intent', { method: req.method, validBody, jsonType: req.headers['content-type'] === 'application/json', originMatches: req.headers.origin === `http://${req.headers.host}` });
            if (holdIntentBody) {
                // Headers arrive; the body never finishes. Only the server's own stop ends it.
                res.writeHead(mode === 'sso' ? 401 : 404, { 'content-type': 'application/json', 'content-length': '512' });
                res.write('{"ok"');
                held.add(res);
                return undefined;
            }
            return json(res, mode === 'sso' ? 401 : 404, refusalBody(mode, INTENT_PATH));
        }
        if (req.url === STREAM_PATH && req.method === 'GET') {
            if (req.headers['user-agent'] === 'node') {
                // The Node probes: the retired route answers the prior credential with its mode-specific body and a
                // renewed session with plain absence.
                const renewed = /private-new-session/.test(req.headers.cookie || '');
                record(renewed ? 'renewed-probe' : 'direct-probe', { priorCookieMatches: req.headers.cookie === `${mode === 'sso' ? 'ploinky_sso' : 'ploinky_jwt'}=${PRIOR_SECRET}`, acceptMatches: req.headers.accept === 'text/event-stream' });
                if (badProbe && !renewed) return json(res, 200, { ok: true });
                return renewed ? json(res, 404, { ok: false, error: 'not_found' }) : json(res, mode === 'sso' ? 401 : 404, refusalBody(mode, STREAM_PATH));
            }
            if (!fault) {
                record('original');
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                res.write(': initial stream\n\n');
                streams.add(res);
                return undefined;
            }
            count += 1;
            record(count === holdAt ? 'held-start' : 'refusal', { number: count });
            if (count === holdAt) {
                if (holdHeaders) {
                    res.writeHead(mode === 'sso' ? 401 : 404, { 'content-type': 'application/json' });
                    res.write(JSON.stringify(refusalBody(mode, STREAM_PATH)).slice(0, 10));
                }
                held.add(res);
                res.on('close', () => record('held-closed', { finished: res.writableFinished }));
                resolveWaiters();
                return undefined;
            }
            json(res, mode === 'sso' ? 401 : 404, refusalBody(mode, STREAM_PATH));
            resolveWaiters();
            return undefined;
        }
        record('unexpected', { method: req.method });
        res.writeHead(404);
        return res.end();
    });
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('message', (message) => {
        if (message !== 'stop') return;
        for (const response of [...held, ...streams]) response.destroy();
        for (const waiter of waiters) waiter.res.destroy();
        server.closeAllConnections();
        server.close(() => process.exit(0));
    });
} else {
    const { chromium } = await import('@playwright/test');
    const { expectedRouterRecoveryDiagnostics } = await import('./webtty-router-recovery.mjs');
    const clientPath = siblingPath('ploinky', 'cli', 'server', 'webtty', 'webtty.js');
    const here = fileURLToPath(import.meta.url);
    const serverExits = [];
    const bound = (promise, label, ms = 15_000) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline`)), ms); })]).finally(() => clearTimeout(timer));
    };

    async function startFixture(browser, mode, { holdAt = 0, holdHeaders = false, holdIntentBody = false, badProbe = false } = {}) {
        const child = fork(here, ['--router-recovery-fixture-server', clientPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const [{ port }] = await bound(once(child, 'message'), 'fixture server start');
        const origin = `http://127.0.0.1:${port}`;
        const api = async (path) => (await bound(fetch(origin + path, { signal: AbortSignal.timeout(15_000) }), `fixture ${path}`)).json();
        await api(`/settings?mode=${mode}&holdAt=${holdAt}&headers=${holdHeaders ? 1 : 0}&intentBody=${holdIntentBody ? 'hold' : 'normal'}&probe=${badProbe ? 'bad' : 'good'}`);
        const context = await browser.newContext();
        await context.addCookies([{ name: 'fixture_auth', value: 'private-fixture-value', url: origin }]);
        let stopped = false;
        const stop = async () => {
            if (stopped) return;
            stopped = true;
            await context.close();
            const exit = once(child, 'exit');
            child.send('stop');
            const [code, signal] = await bound(exit, 'fixture server stop');
            serverExits.push({ code, signal });
        };
        return { child, origin, api, context, stop };
    }

    const { attachPageDiagnostics } = await import('./fixtures.mjs');
    const { armRouterRecoveryObservation, captureRouterRecoveryAuthentication, acknowledgeRouterRecovery, finalizeRouterRecoveryFailure, RouterRecoveryProofError } = await import('./webtty-router-recovery.mjs');
    const { spawnSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const PINNED_CLIENT_SHA256 = '273258130933db8582430d46fe279e00baa0b2af3b9e0e9963573198cc2924f7';
    const loopbackCookie = (mode, value) => ({ name: mode === 'sso' ? 'ploinky_sso' : 'ploinky_jwt', value });

    test('the unchanged WebTTY client under test is the pinned blob', () => {
        assert.equal(createHash('sha256').update(fs.readFileSync(clientPath)).digest('hex'), PINNED_CLIENT_SHA256);
    });

    const closure = [];
    // One real scenario: independent fixture server, unchanged client and an unchanged control, actual diagnostics.
    async function scenario(t, { mode = 'sso', refusals = 1, held = false, backlog = false, armLate = false, holdIntentBody = false, badProbe = false, timeoutMs = 15_000 } = {}) {
        const browser = await chromium.launch({ headless: true });
        t.after(() => browser.close());
        const holdHeaders = held === 'headers';
        const wanted = refusals + (holdHeaders ? 1 : 0);
        const needed = held ? refusals + 1 : refusals;
        const target = await startFixture(browser, mode, { holdAt: held ? refusals + 1 : 0, holdHeaders, holdIntentBody, badProbe });
        const control = await startFixture(browser, mode);
        t.after(() => control.stop());
        t.after(async () => { await target.stop(); });
        const page = armLate ? await target.context.newPage() : null;
        const observation = await armRouterRecoveryObservation(target.context, { baseURL: target.origin, timeoutMs });
        t.after(async () => { closure.push({ label: t.name, ...(await observation.dispose()) }); });
        const terminal = page || await target.context.newPage();
        const diagnostics = attachPageDiagnostics(terminal, { outputPath() { throw new Error('Raw diagnostics flush is forbidden here.'); } }, 'recovery');
        const checkpoint = diagnostics.checkpoint('exact prior-epoch Router stream invalidation');
        const controlPage = await control.context.newPage();
        const connected = (candidate, origin) => candidate.waitForResponse((response) => response.url() === origin + STREAM_PATH && response.status() === 200);
        const targetConnected = connected(terminal, target.origin);
        const controlConnected = connected(controlPage, control.origin);
        await Promise.all([terminal.goto(`${target.origin}/webtty/`), controlPage.goto(`${control.origin}/webtty/`)]);
        await Promise.all([targetConnected, controlConnected]);
        await terminal.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
        if (!armLate) await observation.bind({ page: terminal, sessionId: SESSION_ID, viewId: VIEW_ID, mode });
        return { browser, target, control, terminal, observation, diagnostics, checkpoint, wanted, needed, mode, holdHeaders };
    }
    async function induceRefusals(s, { block = false } = {}) {
        const { target, control, terminal, wanted, needed } = s;
        if (block) {
            // The test process is blocked while the browser keeps refusing: Playwright callbacks arrive late and in a burst.
            const command = `const [a,b,n]=process.argv.slice(1);await Promise.all([fetch(a+'/fault'),fetch(b+'/fault')]);await Promise.all([fetch(a+'/wait?count='+n),fetch(b+'/wait?count='+n)]);`;
            const blocking = spawnSync(process.execPath, ['--input-type=module', '-e', command, target.origin, control.origin, String(needed)], { encoding: 'utf8', timeout: 15_000 });
            assert.equal(blocking.status, 0, 'the blocking child completed');
        } else {
            await Promise.all([target.api('/fault'), control.api('/fault')]);
            await Promise.all([target.api(`/wait?count=${needed}`), control.api(`/wait?count=${needed}`)]);
        }
        await terminal.waitForFunction((n) => window.__routerRecoveryNative.events.filter((e) => e.kind === 'error' && e.readyState === 2).length >= n, wanted);
    }
    // The complete recovery path through the helper, as the gate runs it.
    async function recover(s, { oldOracle = false } = {}) {
        const { target, control, terminal, observation, diagnostics, checkpoint, mode, needed } = s;
        const recovery = captureRouterRecoveryAuthentication({
            baseURL: target.origin, cookies: [loopbackCookie(mode, PRIOR_SECRET)], principal: PRINCIPAL, timeoutMs: 8_000,
        });
        await recovery.proveRestartedAuthentication();
        const trace = [];
        const result = await recovery.recoverAfterCleanup({
            streamPath: STREAM_PATH,
            verifyCleanup: async () => { trace.push('cleanup'); await target.api('/cleanup-marker'); },
            stopProducer: async () => {
                trace.push('stop');
                if (oldOracle) {
                    assert.throws(() => diagnostics.assertExact(checkpoint, expectedRouterRecoveryDiagnostics(target.origin, SESSION_ID, mode, VIEW_ID)),
                        /unexpected diagnostic event multiset/, 'the old four-event acknowledgement fails after independently observed refusals');
                }
                s.stop = await observation.stopAfterCleanup();
                // The unchanged control's next real retry is the quiet-window witness.
                await bound(control.api(`/wait?count=${needed + 1}`), 'control next retry');
            },
            closeTerminal: async () => {
                trace.push('close');
                const validation = await observation.validate();
                acknowledgeRouterRecovery(diagnostics, checkpoint, validation.signatures);
                assert.deepEqual(diagnostics.actionableEvents(), [], 'the exact derived set leaves nothing actionable');
                const closeCheckpoint = diagnostics.checkpoint('final native close');
                await terminal.close();
                diagnostics.acknowledgeExact(closeCheckpoint, []);
                s.validation = validation;
            },
            signIn: async () => { trace.push('sign-in'); if (mode === 'local') assert.fail('a surviving local JWT must not reauthenticate'); return PRINCIPAL; },
            readCookies: async () => [loopbackCookie('sso', NEW_SECRET)],
        });
        s.trace = trace;
        s.result = result;
        return result;
    }
    const serverEvents = async (s) => (await s.target.api('/state')).events;

    for (const mode of ['sso', 'local']) {
        for (const refusals of [1, 2]) {
            test(`${mode}: ${refusals} independently observed refusal(s) are acknowledged only after the pagehide stop`, { timeout: 120_000 }, async (t) => {
                const s = await scenario(t, { mode, refusals });
                await induceRefusals(s);
                await recover(s, { oldOracle: refusals === 2 });
                const events = await serverEvents(s);
                assert.deepEqual(s.trace, mode === 'sso' ? ['cleanup', 'stop', 'close', 'sign-in'] : ['cleanup', 'stop', 'close']);
                assert.equal(s.validation.summary.refusals, refusals);
                assert.equal(events.filter((e) => e.kind === 'close-intent').length, 1, 'exactly one close intent, none from the final native close');
                assert.equal(events.filter((e) => e.kind === 'close-intent' && e.validBody && e.jsonType && e.originMatches).length, 1);
                assert.equal(events.filter((e) => e.kind === 'delete' || e.kind === 'unexpected').length, 0);
                assert.equal(events.filter((e) => e.kind === 'direct-probe' && e.priorCookieMatches && e.acceptMatches).length, 1, 'one direct body probe with the prior credential');
                assert.equal(events.filter((e) => e.kind === 'renewed-probe').length, mode === 'sso' ? 1 : 0);
                assert.ok(events.find((e) => e.kind === 'cleanup-complete').at <= s.stop.before, 'independent cleanup precedes the pagehide dispatch');
            });
        }
    }

    test('sso: a held headerless request is the one in-flight stream cancelled by the stop, not a refusal', { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 1, held: true });
        await induceRefusals(s);
        await recover(s);
        assert.equal(s.validation.summary.refusals, 1);
        assert.equal(s.validation.summary.stopCancellations, 1);
        assert.deepEqual(s.validation.summary.outcomes.slice(-1), ['headerless-stop-cancellation']);
        assert.equal((await serverEvents(s)).filter((e) => e.kind === 'held-start').length, 1);
    });

    for (const [label, block] of [['held 401 header with an unfinished body', false], ['held 401 header with a blocked callback backlog', true]]) {
        test(`sso: a ${label} is a refusal whose abort is attached to the same request`, { timeout: 120_000 }, async (t) => {
            const s = await scenario(t, { mode: 'sso', refusals: 1, held: 'headers' });
            await induceRefusals(s, { block });
            await recover(s);
            assert.equal(s.validation.summary.refusals, 2, 'the completed refusal and the header-held refusal');
            assert.equal(s.validation.summary.stopCancellations, 0, 'a headerless cancellation earns no refusal count');
            assert.ok(s.validation.summary.refusalAborts >= 1);
        });
    }

    test('a callback backlog with several refusals still joins browser terminal times to the stop', { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 2 });
        await induceRefusals(s, { block: true });
        await recover(s);
        assert.equal(s.validation.summary.refusals, 2);
    });

    test('another frame issuing the identical stream URL is rejected as foreign', { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 1 });
        await s.terminal.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/other'; document.body.append(frame); });
        await s.terminal.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.otherSource?.readyState === EventSource.OPEN);
        await s.terminal.evaluate(() => document.querySelector('iframe').contentWindow.otherSource.close());
        await induceRefusals(s);
        await s.target.api('/cleanup-marker');
        await s.observation.stopAfterCleanup();
        await assert.rejects(s.observation.validate(), (error) => error instanceof RouterRecoveryProofError && `${error.stage}: ${error.classification}` === 'ownership: foreign-frame');
        s.diagnostics.closeWithoutAcknowledgement(s.checkpoint);
        assert.throws(() => s.diagnostics.closeWithoutAcknowledgement(s.checkpoint), /already consumed/, 'no checkpoint stays open');
    });

    test('a replaced document and a recorder armed after the terminal opened are rejected', { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 1 });
        await s.terminal.reload({ waitUntil: 'load' });
        await s.terminal.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
        await s.observation.stopAfterCleanup();
        await assert.rejects(s.observation.validate(), (error) => `${error.stage}: ${error.classification}` === 'binding: document-changed');
        s.diagnostics.closeWithoutAcknowledgement(s.checkpoint);
        const late = await scenario(t, { mode: 'sso', refusals: 1, armLate: true });
        await assert.rejects(late.observation.bind({ page: late.terminal, sessionId: SESSION_ID, viewId: VIEW_ID, mode: 'sso' }),
            (error) => `${error.stage}: ${error.classification}` === 'bind: page-not-armed');
        late.diagnostics.closeWithoutAcknowledgement(late.checkpoint);
    });

    test('a failed proof closes its checkpoint without acknowledgement, keeps events actionable and projects no private values', { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 1 });
        await induceRefusals(s);
        await s.target.api('/cleanup-marker');
        await s.observation.stopAfterCleanup();
        // A deliberately wrong signature set: nothing is acknowledged and the error carries no operand.
        const wrong = (await s.observation.validate()).signatures.slice(1);
        let thrown;
        try { acknowledgeRouterRecovery(s.diagnostics, s.checkpoint, wrong); } catch (error) { thrown = error; }
        assert.deepEqual([thrown?.stage, thrown?.classification], ['diagnostics', 'multiset-mismatch']);
        assert.ok(s.diagnostics.actionableEvents().length >= 6, 'every observed event stays actionable');
        s.diagnostics.closeWithoutAcknowledgement(s.checkpoint);
        assert.throws(() => s.diagnostics.closeWithoutAcknowledgement(s.checkpoint), /already consumed/, 'no checkpoint stays open');
        const projection = JSON.stringify(s.observation.project({ failure: thrown, milestones: { cleanupVerified: true } }));
        for (const sentinel of [SESSION_ID, VIEW_ID, 'returnTo', 'login', '127.0.0.1', encodeURIComponent(STREAM_PATH)]) assert.equal(projection.includes(sentinel), false);
        assert.match(projection, /"classification":"multiset-mismatch"/);
    });

    for (const deadline of [250, 3_000]) test(`a close-intent response that sends headers but never finishes its body ends at the existing ${deadline} ms deadline with a classified failure`, { timeout: 120_000 }, async (t) => {
        const s = await scenario(t, { mode: 'sso', refusals: 1, holdIntentBody: true, timeoutMs: deadline });
        await induceRefusals(s);
        await s.target.api('/cleanup-marker');
        const started = Date.now();
        await assert.rejects(s.observation.stopAfterCleanup(), (error) => error instanceof RouterRecoveryProofError && `${error.stage}: ${error.classification}` === 'stop: settle-deadline');
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= deadline * 0.8 && elapsed < deadline + 800, `the failure came at the deadline, not later (${elapsed} ms of ${deadline})`);
        // A validation after the failed settlement is still a prompt, classified refusal (the intent has no terminal yet), never a hang.
        await assert.rejects(s.observation.validate(), (error) => error instanceof RouterRecoveryProofError && `${error.stage}: ${error.classification}` === 'join: timing');
        const projection = s.observation.project({ failure: new RouterRecoveryProofError('stop', 'settle-deadline') });
        assert.ok(projection.requests.length >= 3 && projection.requests.some((r) => r.role === 'intent' && r.status === 401));
        s.diagnostics.closeWithoutAcknowledgement(s.checkpoint);
        const closed = await s.observation.dispose();
        assert.equal(closed.cdpDetachFailed, 0);
        await s.terminal.close();
        assert.equal((await serverEvents(s)).filter((e) => e.kind === 'close-intent').length, 1);
        // The held response is released by the server's own stop; its exit code is checked by the closure test.
    });

    for (const failing of ['cleanup', 'probe']) {
        test(`a ${failing} failure before the stop ends the owned producer, keeps a snapshot, closes the checkpoints and preserves the primary error`, { timeout: 120_000 }, async (t) => {
            const s = await scenario(t, { mode: 'sso', refusals: 1, badProbe: failing === 'probe' });
            await induceRefusals(s);
            const trace = [];
            const recovery = captureRouterRecoveryAuthentication({ baseURL: s.target.origin, cookies: [loopbackCookie('sso', PRIOR_SECRET)], principal: PRINCIPAL, timeoutMs: 8_000 });
            await recovery.proveRestartedAuthentication();
            let primary = null;
            try {
                await recovery.recoverAfterCleanup({
                    streamPath: STREAM_PATH,
                    verifyCleanup: async () => { trace.push('cleanup'); if (failing === 'cleanup') throw new Error('PRIMARY-CLEANUP-FAILURE'); await s.target.api('/cleanup-marker'); },
                    stopProducer: async () => { trace.push('stop'); await s.observation.stopAfterCleanup(); },
                    closeTerminal: async () => { trace.push('close'); },
                    signIn: async () => { trace.push('sign-in'); return PRINCIPAL; },
                    readCookies: async () => [loopbackCookie('sso', NEW_SECRET)],
                });
            } catch (error) {
                primary = error;
            }
            assert.match(primary?.message || '', failing === 'cleanup' ? /PRIMARY-CLEANUP-FAILURE/ : /retired stream route must refuse the prior credential/);
            assert.deepEqual(trace, ['cleanup'], 'nothing after the failure ran, in particular no stop and no re-login');
            const countBefore = (await s.target.api('/state')).count;
            const attached = [];
            const result = await finalizeRouterRecoveryFailure({
                observation: s.observation,
                persist: async (finalization) => { trace.push('persist'); attached.push(s.observation.project({ milestones: { cleanupVerified: false }, finalization })); },
                closeCheckpoints: () => { trace.push('close-checkpoints'); s.diagnostics.closeWithoutAcknowledgement(s.checkpoint); },
                report: () => assert.fail('no finalization step may fail here'),
            });
            trace.push('teardown-authentication');
            assert.deepEqual(result.sequence, ['stop-producer', 'persist', 'close-checkpoints', 'dispose']);
            assert.deepEqual(trace, ['cleanup', 'persist', 'close-checkpoints', 'teardown-authentication']);
            assert.deepEqual(result.failures, []);
            // The producer is stopped before the teardown authentication: the client shows its stopped state and the
            // unchanged control keeps retrying while the target does not.
            assert.equal(result.finalization.producerStopped, true);
            assert.equal(await s.terminal.evaluate(() => document.getElementById('status').textContent), 'Disconnected');
            await bound(s.control.api(`/wait?count=${s.needed + 2}`), 'control retries');
            assert.equal((await s.target.api('/state')).count, countBefore, 'the target no longer retries');
            const events = await serverEvents(s);
            assert.equal(events.filter((e) => e.kind === 'close-intent').length, 1, 'the client sent its one close intent');
            // A non-empty sanitized snapshot, labelled as failure cleanup and not as backend-cleanup evidence.
            assert.ok(attached[0].requests.length >= 3 && attached[0].requests.every((r) => !('url' in r)));
            assert.equal(attached[0].failureFinalization.kind, 'failure-cleanup');
            assert.equal(attached[0].failureFinalization.backendCleanupEvidence, false);
            assert.equal(attached[0].milestones.cleanupVerified, false);
            assert.ok(attached[0].failureFinalization.snapshotRequests >= 3);
            assert.equal(JSON.stringify(attached[0]).includes(SESSION_ID) || JSON.stringify(attached[0]).includes(VIEW_ID), false);
            // The checkpoints are closed without acknowledgement: events stay actionable and none is left open.
            assert.throws(() => s.diagnostics.closeWithoutAcknowledgement(s.checkpoint), /already consumed/);
            assert.ok(s.diagnostics.actionableEvents().length >= 4, 'the observed events remain actionable');
            assert.ok((await s.observation.dispose()).listenersRemoved >= 4);
        });
    }

    test('resource closure: listeners, CDP sessions, servers and browsers are all released', () => {
        assert.ok(closure.length >= 8, `observed scenarios disposed (${closure.length})`);
        for (const entry of closure) {
            assert.ok(entry.listenersRemoved >= 4, `${entry.label}: listeners removed`);
            assert.equal(entry.cdpDetachFailed, 0, `${entry.label}: CDP sessions detached or closed with their page`);
        }
        assert.ok(serverExits.length >= 16 && serverExits.every((exit) => exit.code === 0 && exit.signal === null), 'every fixture server exited cleanly');
    });
}
