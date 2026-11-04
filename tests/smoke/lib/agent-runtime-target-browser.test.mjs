import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const productionPath = fileURLToPath(new URL('../../../explorer/shared/ui/agent-runtime-loader/agent-runtime-wait-route.js', import.meta.url));
const sourcePath = process.env.AGENT_RUNTIME_PROBE_SOURCE || productionPath;

async function fixture(t) {
    const source = await fs.readFile(sourcePath, 'utf8');
    const modalSource = await fs.readFile(new URL('../../../explorer/web-components/modals/expanded-modal/expanded-modal.js', import.meta.url), 'utf8');
    const events = [];
    const timers = new Set();
    const record = (kind, detail = {}) => events.push({ kind, at: Date.now(), ...detail });
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        if (path === '/probe.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            res.end(source);
        } else if (path === '/modal.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            res.end(`import { probeAgentRuntimeTarget, probeAgentRuntimeTargetAndMcp } from '/probe.js';
                const ensureMarketplaceAgentRunning = async () => ({ running: true });
                const probeAgentRuntimeRouteStability = async () => {};
                const probeAgentRuntimeMcp = async () => {};
                const assistosSDK = {};
                const waitForAgentRuntimeAvailability = async config => config.operation();
                ${modalSource.replace(/^import[\s\S]*?;\n/gm, '')}`);
        } else if (path === '/target') {
            const mode = url.searchParams.get('mode');
            const detail = { dest: req.headers['sec-fetch-dest'], mode: req.headers['sec-fetch-mode'], url: req.url };
            record('server-request', detail);
            res.on('finish', () => record('server-finish', detail));
            res.on('close', () => record('server-close', { ...detail, complete: res.writableFinished }));
            if (mode === 'headers') return;
            if (mode === 'redirect') { res.writeHead(302, { location: '/login' }); res.end(); return; }
            if (mode === 'same-path') { res.writeHead(302, { location: '/target?mode=empty' }); res.end(); return; }
            if (mode === 'status') { res.writeHead(Number(url.searchParams.get('status'))); res.end(); return; }
            res.writeHead(200, { 'content-type': 'text/html' });
            if (mode === 'empty') { res.end(); return; }
            if (mode === 'large') {
                const chunk = Buffer.alloc(64 * 1024, 32);
                let sent = 0;
                const write = () => {
                    while (!res.destroyed && sent < 256) {
                        sent += 1;
                        if (!res.write(chunk)) { res.once('drain', write); return; }
                    }
                    if (!res.destroyed) { record('server-bytes', { bytes: sent * chunk.length }); res.end(); }
                };
                write();
                return;
            }
            res.write('<!doctype html><title>Ready</title>');
            if (mode === 'endless') return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (mode === 'drop') res.destroy();
                else res.end('<p>Complete</p>');
            }, 300);
            timers.add(timer);
        } else {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>Probe fixture</title>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const kind of ['requestfinished', 'requestfailed']) {
        page.on(kind, request => record(kind, { url: request.url(), type: request.resourceType(), failure: request.failure() }));
    }
    page.on('console', message => record('console', { type: message.type(), text: message.text() }));
    page.on('pageerror', error => record('pageerror', { message: error.message }));
    t.after(async () => {
        await browser.close();
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        t.diagnostic(JSON.stringify({ sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'), events }));
        assert.deepEqual(events.filter(event => event.kind === 'pageerror'), [], 'fixture has no unexpected page errors');
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    return { page, events, origin };
}

test('successful readiness GET completes before iframe navigation', async t => {
    const { page, events, origin } = await fixture(t);
    await page.evaluate(async () => {
        const { probeAgentRuntimeTarget } = await import('/probe.js');
        await probeAgentRuntimeTarget(new URL('/target?purpose=readiness', location.origin));
        const frame = document.createElement('iframe');
        frame.src = '/target?purpose=iframe';
        document.body.append(frame);
        await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    });
    await page.waitForTimeout(100);
    const readiness = `${origin}/target?purpose=readiness`;
    const navigation = `${origin}/target?purpose=iframe`;
    assert.deepEqual(events.filter(event => event.kind === 'requestfailed'), [], 'readiness GET must finish without ERR_ABORTED');
    assert.ok(events.some(event => event.kind === 'requestfinished' && event.url === readiness), 'readiness fetch finished');
    assert.ok(events.some(event => event.kind === 'requestfinished' && event.url === navigation), 'iframe navigation finished');
    const requests = events.filter(event => event.kind === 'server-request');
    assert.deepEqual(requests.map(event => [event.dest, event.mode]), [['empty', 'cors'], ['iframe', 'navigate']]);
    assert.ok(events.findIndex(event => event.kind === 'server-finish' && event.dest === 'empty')
        < events.findIndex(event => event.kind === 'server-request' && event.dest === 'iframe'), 'readiness EOF precedes iframe navigation');
    assert.equal(events.filter(event => event.kind === 'pageerror').length, 0);
});

test('Chromium streams 16 MiB sequentially without aggregate body APIs and accepts an empty response twice', async t => {
    const { page, events } = await fixture(t);
    const result = await page.evaluate(async () => {
        const { probeAgentRuntimeTarget } = await import('/probe.js');
        const samples = [];
        for (const mode of ['large', 'empty', 'empty']) {
            let bytes = 0;
            let active = false;
            let released = false;
            let requestSignal;
            await probeAgentRuntimeTarget(new URL(`/target?mode=${mode}`, location.origin), async (url, options) => {
                requestSignal = options.signal;
                const response = await fetch(url, options);
                for (const name of ['text', 'arrayBuffer', 'blob', 'json']) response[name] = () => { throw new Error(`aggregate API ${name}`); };
                const getReader = response.body.getReader.bind(response.body);
                response.body.getReader = () => {
                    const reader = getReader();
                    return {
                        async read() {
                            if (active) throw new Error('concurrent reads');
                            active = true;
                            const chunk = await reader.read();
                            bytes += chunk.value?.byteLength || 0;
                            active = false;
                            return chunk;
                        },
                        releaseLock() { reader.releaseLock(); released = !response.body.locked; },
                    };
                };
                return response;
            });
            samples.push({ bytes, released, aborted: requestSignal.aborted });
        }
        return samples;
    });
    assert.deepEqual(result, [
        { bytes: 16 * 1024 * 1024, released: true, aborted: false },
        { bytes: 0, released: true, aborted: false },
        { bytes: 0, released: true, aborted: false },
    ]);
    assert.equal(events.filter(event => event.kind === 'requestfailed').length, 0);
});

test('hanging headers and endless bodies abort at the owned deadline and close the server request', async t => {
    const { page, events } = await fixture(t);
    const results = await page.evaluate(async () => {
        const { probeAgentRuntimeTarget } = await import('/probe.js');
        return Promise.all(['headers', 'endless'].map(async mode => {
            const started = performance.now();
            try {
                await probeAgentRuntimeTarget(new URL(`/target?mode=${mode}`, location.origin));
                document.body.append(document.createElement('iframe'));
                return { unexpectedSuccess: true };
            } catch (error) {
                return { mode, elapsed: performance.now() - started, code: error.code, message: error.message, status: error.status || null };
            }
        }));
    });
    await page.waitForTimeout(150);
    for (const result of results) {
        assert.equal(result.code, 'agent_not_ready');
        assert.match(result.message, /timed out/);
        assert.equal(result.status, null);
        assert.ok(result.elapsed >= 4900 && result.elapsed < 6500, JSON.stringify(result));
        const request = events.find(event => event.kind === 'server-request' && event.url === `/target?mode=${result.mode}`);
        const closed = events.find(event => event.kind === 'server-close' && event.url === request.url);
        assert.ok(closed && !closed.complete && closed.at - request.at < 6500, JSON.stringify(events));
    }
    assert.equal(await page.locator('iframe').count(), 0);
    const failed = events.filter(event => event.kind === 'requestfailed');
    assert.equal(failed.length, 2, 'both deliberately stalled fetches fail');
    assert.ok(failed.every(event => event.failure.errorText === 'net::ERR_ABORTED'));
});

test('dropped bodies, redirects and HTTP refusals keep their classifications', async t => {
    const { page, events } = await fixture(t);
    const results = await page.evaluate(async () => {
        const { probeAgentRuntimeTarget } = await import('/probe.js');
        const results = [];
        for (const query of ['mode=drop', 'mode=redirect', 'mode=same-path', ...[400, 401, 403, 404, 422, 502, 503, 504].map(status => `mode=status&status=${status}`)]) {
            const target = new URL(`/target?${query}`, location.origin);
            try { results.push({ query, sameTarget: await probeAgentRuntimeTarget(target) === target }); }
            catch (error) { results.push({ query, code: error.code || null, status: error.status || null, cause: error.cause?.name || null }); }
        }
        return results;
    });
    assert.deepEqual(results[0], { query: 'mode=drop', code: 'agent_not_ready', status: null, cause: 'TypeError' });
    assert.deepEqual(results[1], { query: 'mode=redirect', code: null, status: 401, cause: null });
    assert.deepEqual(results[2], { query: 'mode=same-path', sameTarget: true });
    for (const result of results.slice(3)) {
        const status = Number(new URLSearchParams(result.query).get('status'));
        assert.equal(result.status, status);
        assert.equal(result.code, status === 404 ? 'agent_not_ready' : null);
    }
    await page.waitForTimeout(100);
    const failures = events.filter(event => event.kind === 'requestfailed');
    assert.ok(failures.some(event => event.url.endsWith('/target?mode=drop') && event.failure.errorText === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'));
    assert.ok(failures.every(event => event.url.endsWith('/target?mode=drop')
        ? event.failure.errorText === 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'
        : (new URL(event.url).pathname === '/login' || new URL(event.url).searchParams.get('mode') === 'status')
            && event.failure.errorText === 'net::ERR_ABORTED'), 'only deliberately failed transports are present');
});

test('concurrent probes isolate caller cancellation while another request completes', async t => {
    const { page, events } = await fixture(t);
    const result = await page.evaluate(async () => {
        const { probeAgentRuntimeTarget } = await import('/probe.js');
        const caller = new AbortController();
        const reason = new Error('closed one panel');
        let headers;
        const received = new Promise(resolve => { headers = resolve; });
        const first = probeAgentRuntimeTarget(new URL('/target?mode=endless', location.origin), async (...args) => {
            const response = await fetch(...args); headers(); return response;
        }, { signal: caller.signal }).catch(error => error === reason);
        const second = probeAgentRuntimeTarget(new URL('/target?purpose=independent', location.origin));
        await received;
        caller.abort(reason);
        return { first: await first, second: (await second).search };
    });
    await page.waitForTimeout(100);
    assert.deepEqual(result, { first: true, second: '?purpose=independent' });
    assert.equal(events.filter(event => event.kind === 'requestfailed').length, 1);
    assert.ok(events.some(event => event.kind === 'server-finish' && event.url === '/target?purpose=independent'));
});

test('production modal close and reload before and at EOF cannot mount a stale iframe; generic iframe mounts once', async t => {
    const { page } = await fixture(t);
    const result = await page.evaluate(async () => {
        const { ExpandedModal } = await import('/modal.js');
        const results = [];
        for (const action of ['close', 'reload', 'eof-close', 'eof-reload', 'generic']) {
            const element = document.createElement('div');
            document.body.append(element);
            element.setAttribute('data-agent-ref', action === 'generic' ? '' : 'webmeet/webmeetAgent');
            const modal = new ExpandedModal(element, () => {});
            modal.body = element;
            modal.mode = 'iframe';
            modal.setState = () => {};
            const atEof = action.startsWith('eof-');
            modal.frameUrl = () => atEof ? '/target?purpose=eof-race' : '/target?mode=endless';
            modal.isFrameReady = () => true;
            modal.syncFrameHeader = () => {};
            modal.ensureAgentRuntime = async () => ({ running: true });
            let headerReady;
            const headers = new Promise(resolve => { headerReady = resolve; });
            const nativeFetch = window.fetch;
            const cancel = () => {
                modal.frameUrl = () => '/target?mode=endless';
                if (action.endsWith('close')) modal.afterUnload();
                else void modal.reloadContent();
            };
            window.fetch = async (...args) => {
                const response = await nativeFetch(...args);
                headerReady();
                if (atEof && String(args[0]).includes('purpose=eof-race')) {
                    const getReader = response.body.getReader.bind(response.body);
                    response.body.getReader = () => {
                        const reader = getReader();
                        return {
                            async read() {
                                const chunk = await reader.read();
                                if (chunk.done) cancel();
                                return chunk;
                            },
                            releaseLock: () => reader.releaseLock(),
                        };
                    };
                }
                return response;
            };
            const pending = modal.startFrameContent();
            if (action !== 'generic') {
                await headers;
                if (!atEof) cancel();
            }
            await pending;
            results.push({ action, frames: element.querySelectorAll('iframe').length });
            modal.afterUnload();
            window.fetch = nativeFetch;
            element.remove();
        }
        return results;
    });
    assert.deepEqual(result, ['close', 'reload', 'eof-close', 'eof-reload', 'generic'].map(action => ({ action, frames: action === 'generic' ? 1 : 0 })));
});
