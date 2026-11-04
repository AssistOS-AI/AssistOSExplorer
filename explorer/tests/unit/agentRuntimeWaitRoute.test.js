import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForAgentRuntimeAvailability } from '../../shared/ui/agent-runtime-loader/agent-runtime-loader.js';

import {
    buildAgentRuntimeWaitUrl,
    parseAgentRuntimeWaitRoute,
    probeAgentRuntimeMcp,
    probeAgentRuntimeRouteStability,
    probeAgentRuntimeTarget,
    probeAgentRuntimeTargetAndMcp,
    resolveAgentRuntimeTarget
} from '../../shared/ui/agent-runtime-loader/agent-runtime-wait-route.js';

const ORIGIN = 'http://localhost:8080';

test('RoboTeam dashboard waits through an inactive service response before navigation', async () => {
    const targetUrl = resolveAgentRuntimeTarget({
        agentRef: 'AchillesIDE/roboTeamAgent', target: '/base-agent-additional-server/roboTeamAgent/3001/',
    }, ORIGIN);
    let attempts = 0;
    let waits = 0;
    let runtimeReads = 0;
    const result = await waitForAgentRuntimeAvailability({
        agentRef: 'AchillesIDE/roboTeamAgent', label: 'RoboTeam',
        readRuntime: async () => {
            runtimeReads += 1;
            return { active: true, running: runtimeReads > 1, status: runtimeReads > 1 ? 'running' : 'starting' };
        },
        wait: async () => {
            waits += 1;
            assert.equal(attempts, waits - 1, 'the route is not probed until its runtime is running');
            assert.ok(waits <= 2, 'runtime and route readiness must converge');
        },
        operation: () => probeAgentRuntimeTarget(targetUrl, async () => {
            attempts += 1;
            return { ok: attempts > 1, status: attempts > 1 ? 200 : 503, redirected: false };
        }),
    });
    assert.equal(result, targetUrl);
    assert.equal(attempts, 2);
    assert.equal(waits, 2);
});

test('builds and parses the RoboTeam additional-service waiting route', () => {
    const targetUrl = '/base-agent-additional-server/roboTeamAgent/3001/';
    const waitingUrl = buildAgentRuntimeWaitUrl({
        agentRef: 'AchillesIDE/roboTeamAgent', label: 'RoboTeam', targetUrl,
    }, ORIGIN);
    const parsed = parseAgentRuntimeWaitRoute(waitingUrl.hash, ORIGIN);
    assert.equal(parsed.agentRef, 'AchillesIDE/roboTeamAgent');
    assert.equal(parsed.targetUrl.toString(), `${ORIGIN}${targetUrl}`);
});

test('additional-service targets stay on the same origin and exact agent with a valid port', () => {
    for (const target of [
        '/base-agent-additional-server/otherAgent/3001/',
        '/base-agent-additional-server/roboTeamAgentOther/3001/',
        '/base-agent-additional-server/roboTeamAgent/0/',
        '/base-agent-additional-server/roboTeamAgent/65536/',
        '/base-agent-additional-server/roboTeamAgent/not-a-port/',
        '/base-agent-additional-server/roboTeamAgent/3001',
        '/base-agent-additional-server/roboTeamAgent/3001/../../otherAgent/3001/',
        'https://example.test/base-agent-additional-server/roboTeamAgent/3001/',
        '/base-agent-additional-server/roboTeamAgent/3001/#fragment',
    ]) {
        assert.throws(() => resolveAgentRuntimeTarget({ agentRef: 'AchillesIDE/roboTeamAgent', target }, ORIGIN),
            /target is invalid/, target);
    }
});

test('builds and parses a same-agent Explorer waiting route', () => {
    const waitingUrl = buildAgentRuntimeWaitUrl({
        agentRef: 'webmeet/webmeetAgent',
        label: 'WebMeet',
        targetUrl: '/webmeetAgent/roomLoader.html?roomId=room_123'
    }, ORIGIN);
    const parsed = parseAgentRuntimeWaitRoute(waitingUrl.hash, ORIGIN);

    assert.equal(waitingUrl.pathname, '/explorer/index.html');
    assert.equal(parsed.agentRef, 'webmeet/webmeetAgent');
    assert.equal(parsed.label, 'WebMeet');
    assert.equal(parsed.targetUrl.toString(), `${ORIGIN}/webmeetAgent/roomLoader.html?roomId=room_123`);
});

test('rejects cross-origin and cross-agent targets', () => {
    assert.throws(
        () => resolveAgentRuntimeTarget({
            agentRef: 'webmeet/webmeetAgent',
            target: 'https://example.test/webmeetAgent/roomLoader.html'
        }, ORIGIN),
        /target is invalid/
    );
    assert.throws(
        () => resolveAgentRuntimeTarget({
            agentRef: 'webmeet/webmeetAgent',
            target: '/onlyOffice/index.html'
        }, ORIGIN),
        /target is invalid/
    );
});

test('runtime target probe exposes transient HTTP status to the shared loader', async () => {
    const targetUrl = new URL('/webmeetAgent/roomLoader.html', ORIGIN);
    await assert.rejects(
        () => probeAgentRuntimeTarget(targetUrl, async () => ({ ok: false, status: 404 })),
        (error) => error.status === 404 && error.code === 'agent_not_ready'
    );

    let bodyRead = false;
    const result = await probeAgentRuntimeTarget(targetUrl, async () => ({
        ok: true,
        status: 200,
        redirected: false,
        body: new ReadableStream({ start(controller) { bodyRead = true; controller.close(); } })
    }));
    assert.equal(result, targetUrl);
    assert.equal(bodyRead, true);
});

test('readiness drains sequential chunks to EOF, releases the lock and leaves completed requests un-aborted', async () => {
    const caller = new AbortController();
    const target = new URL('/webmeetAgent/roomLoader.html?room=one', ORIGIN);
    let finish;
    let reads = 0;
    let pending = false;
    let released = false;
    let options;
    const reader = {
        async read() {
            assert.equal(pending, false, 'only one read at a time');
            pending = true;
            reads += 1;
            if (reads === 3) await new Promise(resolve => { finish = resolve; });
            pending = false;
            return reads === 3 ? { done: true } : { done: false, value: new Uint8Array(1024) };
        },
        releaseLock() { released = true; },
    };
    const response = { ok: true, status: 200, body: { getReader: () => reader } };
    for (const name of ['text', 'arrayBuffer', 'blob', 'json']) response[name] = () => assert.fail(`aggregate ${name} used`);
    let settled = false;
    const probe = probeAgentRuntimeTarget(target, async (url, init) => {
        assert.equal(url, target.toString());
        options = init;
        return response;
    }, { signal: caller.signal }).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(reads, 3);
    finish();
    assert.equal(await probe, target);
    assert.equal(released, true);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'include');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.accept, 'text/html');
    assert.equal(options.signal.aborted, false);
    caller.abort();
    assert.equal(options.signal.aborted, false, 'caller listener detached after success');
});

test('readiness accepts null and zero-byte bodies', async () => {
    for (const body of [null, new ReadableStream({ start(controller) { controller.close(); } })]) {
        const target = new URL('/webmeetAgent/empty', ORIGIN);
        assert.equal(await probeAgentRuntimeTarget(target, async () => ({ ok: true, body })), target);
        if (body) assert.equal(body.locked, false);
    }
});

test('settled probes clear their deadline and detach caller listeners on success and failure', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const status of [200, 403]) {
        const caller = new AbortController();
        let listeners = 0;
        const signal = {
            get reason() { return caller.signal.reason; },
            throwIfAborted: () => caller.signal.throwIfAborted(),
            addEventListener(...args) { listeners += 1; caller.signal.addEventListener(...args); },
            removeEventListener(...args) { listeners -= 1; caller.signal.removeEventListener(...args); },
        };
        let ownedSignal;
        const probe = probeAgentRuntimeTarget(new URL('/webmeetAgent/empty', ORIGIN), async (url, options) => {
            ownedSignal = options.signal;
            return { ok: status === 200, status, body: null };
        }, { signal });
        if (status === 200) await probe;
        else await assert.rejects(probe, error => error.status === status);
        assert.equal(listeners, 0);
        t.mock.timers.tick(5000);
        assert.equal(ownedSignal.aborted, status !== 200);
        if (status !== 200) assert.notEqual(ownedSignal.reason.code, 'agent_not_ready', 'cleared deadline cannot replace failure cancellation');
    }
});

test('readiness preserves caller abort reasons before fetch, during read, and at EOF', async () => {
    const target = new URL('/webmeetAgent/roomLoader.html', ORIGIN);
    const already = new AbortController();
    const reason = new Error('panel closed');
    already.abort(reason);
    await assert.rejects(probeAgentRuntimeTarget(target, () => assert.fail('aborted caller fetched'), { signal: already.signal }), error => error === reason);
    for (const atEof of [false, true]) {
        const caller = new AbortController();
        let body;
        const probe = probeAgentRuntimeTarget(target, async (url, { signal }) => {
            body = new ReadableStream({
                start(controller) {
                    if (atEof) { controller.close(); caller.abort(reason); }
                    else signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
                },
            });
            return { ok: true, body };
        }, { signal: caller.signal });
        if (!atEof) {
            await new Promise(resolve => setImmediate(resolve));
            caller.abort(reason);
        }
        await assert.rejects(probe, error => error === reason);
        assert.equal(body.locked, false);
    }
});

test('one five-second deadline covers hanging headers and endless response bodies', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const headers of [true, false]) {
        let ownedSignal;
        let body;
        const probe = probeAgentRuntimeTarget(new URL('/webmeetAgent/hang', ORIGIN), async (url, { signal }) => {
            ownedSignal = signal;
            if (headers) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            body = new ReadableStream({ start(controller) {
                signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
                controller.enqueue(new Uint8Array(1));
            } });
            return { ok: true, body };
        });
        const rejected = assert.rejects(probe, error => error.code === 'agent_not_ready' && /timed out/.test(error.message) && error.status === undefined);
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(4999);
        assert.equal(ownedSignal.aborted, false);
        t.mock.timers.tick(1);
        await rejected;
        assert.equal(ownedSignal.aborted, true);
        if (body) assert.equal(body.locked, false);
    }
});

test('read failures retain their cause, release locks and abort incomplete requests', async () => {
    const cause = new TypeError('socket terminated');
    const body = new ReadableStream({ start(controller) { controller.error(cause); } });
    let signal;
    await assert.rejects(probeAgentRuntimeTarget(new URL('/webmeetAgent/broken', ORIGIN), async (url, options) => {
        signal = options.signal;
        return { ok: true, body };
    }), error => error.code === 'agent_not_ready' && error.cause === cause);
    assert.equal(body.locked, false);
    assert.equal(signal.aborted, true);
});

test('readiness keeps HTTP and redirect classifications', async () => {
    const target = new URL('/webmeetAgent/roomLoader.html?room=one', ORIGIN);
    for (const status of [400, 401, 403, 404, 422, 502, 503, 504]) {
        await assert.rejects(probeAgentRuntimeTarget(target, async () => ({ ok: false, status })),
            error => error.status === status && (status === 404 ? error.code === 'agent_not_ready' : error.code === undefined));
    }
    await assert.rejects(probeAgentRuntimeTarget(target, async () => ({ ok: true, redirected: true, url: `${ORIGIN}/auth/login` })),
        error => error.status === 401 && /different session/.test(error.message));
    assert.equal(await probeAgentRuntimeTarget(target, async () => ({ ok: true, redirected: true, url: `${ORIGIN}${target.pathname}?different=query` })), target);
});

test('404 and gateway failures retry, permanent statuses stop and outer expiry stays unchanged', async () => {
    const target = new URL('/webmeetAgent/roomLoader.html', ORIGIN);
    for (const status of [404, 502, 503, 504, 400, 401, 403, 422]) {
        let calls = 0;
        const run = waitForAgentRuntimeAvailability({
            operation: () => probeAgentRuntimeTarget(target, async () => ({ ok: ++calls > 1, status })),
            wait: async () => {},
        });
        if ([400, 401, 403, 422].includes(status)) {
            await assert.rejects(run, error => error.status === status);
            assert.equal(calls, 1);
        } else {
            assert.equal(await run, target);
            assert.equal(calls, 2);
        }
    }
    let time = 0;
    let calls = 0;
    await assert.rejects(waitForAgentRuntimeAvailability({
        now: () => time, timeoutMs: 1000, pollIntervalMs: 250,
        wait: async ms => { time += ms; },
        operation: () => { calls += 1; return probeAgentRuntimeTarget(target, async () => ({ ok: false, status: 503 })); },
    }), error => error.status === 503);
    assert.equal(time, 1000);
    assert.equal(calls, 5);
});

test('runtime MCP probe waits for a complete agent handshake', async () => {
    let requestedAgent = '';
    let listed = 0;
    const sdk = {
        getClient(agentName) {
            requestedAgent = agentName;
            return {
                async listTools() {
                    listed += 1;
                    return [];
                }
            };
        }
    };

    const result = await probeAgentRuntimeMcp('webmeet/webmeetAgent', sdk);
    assert.equal(result, 'webmeetAgent');
    assert.equal(requestedAgent, 'webmeetAgent');
    assert.equal(listed, 1);
});

test('runtime MCP probe exposes startup failures as retryable availability errors', async () => {
    const sdk = {
        getClient() {
            return {
                async listTools() {
                    throw new Error('fetch failed');
                }
            };
        }
    };

    await assert.rejects(
        () => probeAgentRuntimeMcp('webmeet/webmeetAgent', sdk),
        (error) => error.code === 'agent_not_ready' && /fetch failed/.test(error.message)
    );
});

test('runtime route probe requires one stable Router generation window', async () => {
    const generations = ['generation-1', 'generation-1'];
    const waits = [];
    const result = await probeAgentRuntimeRouteStability('webmeet/webmeetAgent', {
        origin: ORIGIN,
        settleMs: 2500,
        wait: async (delayMs) => waits.push(delayMs),
        fetchImpl: async (url, options) => ({
            ok: true,
            status: 200,
            async json() {
                const parsed = new URL(url);
                assert.equal(parsed.pathname, '/webmeetAgent/');
                assert.equal(options.headers['X-Ploinky-Agent-Startup-Probe'], '1');
                return {
                    state: 'ready',
                    generation: generations.shift()
                };
            }
        })
    });

    assert.equal(result, 'generation-1');
    assert.deepEqual(waits, [2500]);
});

test('runtime route probe retries when the Router generation changes', async () => {
    const generations = ['generation-1', 'generation-2'];
    await assert.rejects(
        () => probeAgentRuntimeRouteStability('webmeet/webmeetAgent', {
            origin: ORIGIN,
            wait: async () => {},
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                async json() {
                    return {
                        state: 'ready',
                        generation: generations.shift()
                    };
                }
            })
        }),
        (error) => error.code === 'agent_not_ready' && /still being updated/.test(error.message)
    );
});


test('runtime generation probe does not treat accepted startup or login HTML as ready', async () => {
    for (const response of [
        { ok: true, status: 202, json: async () => ({ state: 'starting', generation: 'g1' }) },
        { ok: true, status: 200, redirected: true, json: async () => ({ state: 'ready', generation: 'g1' }) },
        { ok: true, status: 200, json: async () => ({ browserMutation: { generation: 'g1' } }) },
    ]) {
        await assert.rejects(() => probeAgentRuntimeRouteStability('AchillesCLI/achilles-cli', {
            origin: ORIGIN, wait: async () => {}, fetchImpl: async () => response,
        }), error => error.code === 'agent_not_ready');
    }
});

test('concurrent target and MCP probes reject on the first failure without waiting for a hung sibling', async () => {
    const permanent = Object.assign(new Error('forbidden'), { status: 403 });
    const hang = () => new Promise(() => {});
    await assert.rejects(() => probeAgentRuntimeTargetAndMcp(async () => { throw permanent; }, hang), permanent);
    await assert.rejects(() => probeAgentRuntimeTargetAndMcp(hang, async () => { throw permanent; }), permanent);
    assert.equal(await probeAgentRuntimeTargetAndMcp(async () => 'target', async () => 'mcp'), 'target');
});

// ---- Two-mode route stability client (T-A1 .. T-A14) ----
const TOKEN = 'AbCdEf012345_-xy.1';
const ready = (extra = {}) => ({ state: 'ready', generation: 'G', ...extra });
const active = (token, activeForMs, mutation, generation = 'G') => ({ generation, activation: token, activeForMs, mutation });

async function runProbe(reads, options = {}) {
    const waits = [];
    let fetches = 0;
    const queue = [...reads];
    const outcome = await probeAgentRuntimeRouteStability('legacy-agents/tasksAgent', {
        origin: ORIGIN,
        settleMs: options.settleMs,
        wait: async (delayMs) => { waits.push(delayMs); options.onWait?.(delayMs); },
        fetchImpl: async () => {
            fetches += 1;
            const payload = typeof queue[0] === 'function' ? queue[0]() : queue.shift();
            if (typeof queue[0] === 'function') queue.shift();
            return { ok: true, status: 200, json: async () => ready(payload) };
        },
    }).then(value => ({ value }), error => ({ error }));
    return { ...outcome, waits, fetches };
}
const stillUpdating = error => error?.code === 'agent_not_ready' && /still being updated/.test(error.message);

test('T-A1: an idle activation at least as old as the settle skips the wait', async () => {
    const r = await runProbe([active(TOKEN, 4000, 'idle'), active(TOKEN, 4010, 'idle')]);
    assert.equal(r.value, 'G');
    assert.deepEqual(r.waits, []);
    assert.equal(r.fetches, 2);
});

test('T-A2: an idle activation younger than the settle runs the forward wait', async () => {
    const r = await runProbe([active(TOKEN, 1000, 'idle'), active(TOKEN, 3500, 'idle')]);
    assert.equal(r.value, 'G');
    assert.deepEqual(r.waits, [2500]);
});

test('T-A3: a busy Router never skips, however old the activation', async () => {
    for (const mutation of ['busy', 'unknown-state']) {
        const r = await runProbe([active(TOKEN, 99999, mutation), active(TOKEN, 102499, 'idle')]);
        assert.equal(r.value, 'G', mutation);
        assert.deepEqual(r.waits, [2500], mutation);
    }
});

test('T-A4: skip mode rejects when the second read reports a mutation', async () => {
    for (const second of [active(TOKEN, 4100, 'busy'), active(TOKEN, 4100, 'weird'), active(TOKEN, 4100, null)]) {
        const r = await runProbe([active(TOKEN, 4000, 'idle'), second]);
        assert.ok(stillUpdating(r.error), JSON.stringify(second));
        assert.deepEqual(r.waits, []);
        assert.equal(r.fetches, 2);
    }
});

test('T-A5: forward mode rejects a changed activation even with an unchanged generation', async () => {
    const r = await runProbe([active('AbCdEf012345_-xy.1', 10, 'busy'), active('AbCdEf012345_-xy.2', 5, 'idle')]);
    assert.ok(stillUpdating(r.error));
    assert.deepEqual(r.waits, [2500]);
});

test('T-A6: an older Router without the fields keeps today forward check', async () => {
    const r = await runProbe([{ generation: 'G' }, { generation: 'G' }]);
    assert.equal(r.value, 'G');
    assert.deepEqual(r.waits, [2500]);
    const changed = await runProbe([{ generation: 'G' }, { generation: 'H' }]);
    assert.ok(stillUpdating(changed.error));
});

test('T-A7: malformed activation fields are treated as absent and run the forward check', async () => {
    const valid = active(TOKEN, 4000, 'idle');
    for (const bad of [
        { activation: 123 }, { activation: 'x'.repeat(200) + '.1' }, { activation: 'no-sequence' }, { activation: 'tok.0' },
        { activeForMs: -1 }, { activeForMs: 1.5 }, { activeForMs: '3000' }, { activeForMs: null }, { activeForMs: undefined },
        { activeForMs: Number.MAX_SAFE_INTEGER + 2 }, { mutation: 'IDLE' }, { mutation: null }, { mutation: undefined }, { mutation: 7 },
    ]) {
        const payload = { ...valid, ...bad };
        const r = await runProbe([payload, payload]);
        assert.equal(r.value, 'G', JSON.stringify(bad));
        assert.deepEqual(r.waits, [2500], JSON.stringify(bad));
    }
});

test('T-A8: an activation token that disappears on the second read rejects in both modes', async () => {
    const skipMode = await runProbe([active(TOKEN, 4000, 'idle'), { generation: 'G' }]);
    assert.ok(stillUpdating(skipMode.error));
    const forward = await runProbe([active(TOKEN, 10, 'busy'), { generation: 'G' }]);
    assert.ok(stillUpdating(forward.error));
    assert.deepEqual(forward.waits, [2500]);
});

test('T-A9: a zero settle never calls wait, in either mode', async () => {
    const forward = await runProbe([{ generation: 'G' }, { generation: 'G' }], { settleMs: 0 });
    assert.equal(forward.value, 'G');
    assert.deepEqual(forward.waits, []);
    const skip = await runProbe([active(TOKEN, 0, 'idle'), active(TOKEN, 3, 'idle')], { settleMs: 0 });
    assert.equal(skip.value, 'G');
    assert.deepEqual(skip.waits, []);
});

// A fake Router timeline (milliseconds) replaying a bystander agent during `ploinky restart tasksAgent`: the
// workspace lease is held until 6000, the first (drain) activation is X.1/G1 from 0, the second is X.2/G2 from 5905.
function restartRouter(clock) {
    return () => {
        const t = clock.now;
        const mutation = t < 6000 ? 'busy' : 'idle';
        if (t < 5905) return active('RouterNonce0123.1', t, mutation, 'G1');
        return active('RouterNonce0123.2', t - 5905, mutation, 'G2');
    };
}
async function bystanderOpen(clock, router, openAt) {
    clock.now = openAt;
    let mcpCalls = 0;
    const r = await runProbe([router, router], { onWait: ms => { clock.now += ms; } });
    if (r.value) mcpCalls += 1; // the modal probes MCP only after the route probe passes
    return { ...r, mcpCalls };
}

test('T-A10: bystander replay of the restart trace rejects the open at +4 s and passes the retry', async () => {
    const clock = { now: 0 };
    const router = restartRouter(clock);
    const first = await bystanderOpen(clock, router, 4000);
    assert.ok(stillUpdating(first.error), 'the open that spans the second activation is rejected');
    assert.equal(first.mcpCalls, 0);
    assert.deepEqual(first.waits, [2500], 'a busy Router forces the forward check');
    const retry = await bystanderOpen(clock, router, 7500);
    assert.equal(retry.value, 'G2');
    assert.equal(retry.mcpCalls, 1);
    assert.deepEqual(retry.waits, [2500], 'the 1.6 s old activation is still too young to skip');
});

test('T-A11: accepted residual, an open at +1 s passes the forward check on the first generation as today', async () => {
    const clock = { now: 0 };
    const r = await bystanderOpen(clock, restartRouter(clock), 1000);
    assert.equal(r.value, 'G1');
    assert.deepEqual(r.waits, [2500]);
});

test('T-A12: an activation exactly as old as the settle skips (boundary)', async () => {
    const exact = await runProbe([active(TOKEN, 2500, 'idle'), active(TOKEN, 2501, 'idle')]);
    assert.deepEqual(exact.waits, []);
    const below = await runProbe([active(TOKEN, 2499, 'idle'), active(TOKEN, 5000, 'idle')]);
    assert.deepEqual(below.waits, [2500]);
    const customSettle = await runProbe([active(TOKEN, 999, 'idle'), active(TOKEN, 1000, 'idle')], { settleMs: 1000 });
    assert.deepEqual(customSettle.waits, [1000]);
});

test('T-A13: graph-start bystander model stays in forward mode while busy and rejects a window spanning an activation', async () => {
    // Two activations 4 s apart under short separate leases; the Router reports busy until the workers settle.
    const clock = { now: 0 };
    const router = () => clock.now < 4000
        ? active('GraphNonce01234.1', clock.now, 'busy', 'G1')
        : active('GraphNonce01234.2', clock.now - 4000, clock.now < 9000 ? 'busy' : 'idle', 'G2');
    let maxActiveFor = 0;
    for (const openAt of [100, 1500, 3500, 3999]) {
        clock.now = openAt;
        const r = await runProbe([() => { maxActiveFor = Math.max(maxActiveFor, router().activeForMs); return router(); }, router],
            { onWait: ms => { clock.now += ms; } });
        assert.deepEqual(r.waits, [2500], `open at ${openAt} is forward`);
        if (openAt + 2500 >= 4000) assert.ok(stillUpdating(r.error), `open at ${openAt} spans the second activation`);
        else assert.equal(r.value, 'G1');
    }
    assert.ok(maxActiveFor >= 3500 && maxActiveFor < 4000, 'activeForMs reached 3500 and the open was still forward');
    clock.now = 4500;
    const later = await runProbe([router, router], { onWait: ms => { clock.now += ms; } });
    assert.equal(later.value, 'G2');
    assert.deepEqual(later.waits, [2500]);
});

test('T-A14: residual R3 (new in skip mode) a lease that appears after the second read is not seen', async () => {
    const clock = { now: 10_000 };
    let leaseHeld = false;
    const router = () => active(TOKEN, 8000 + (clock.now - 10_000), leaseHeld ? 'busy' : 'idle');
    const r = await runProbe([router, router]);
    assert.equal(r.value, 'G', 'skip mode resolves');
    assert.equal(r.fetches, 2);
    assert.deepEqual(r.waits, []);
    leaseHeld = true; // a mutation starting after the second read cannot be observed by this probe
    assert.equal(r.value, 'G');
    assert.equal(r.fetches, 2, 'no further read happens after the probe resolved');
});
