import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForAgentRuntimeAvailability } from '../../shared/ui/agent-runtime-loader/agent-runtime-loader.js';

import {
    buildAgentRuntimeWaitUrl,
    parseAgentRuntimeWaitRoute,
    probeAgentRuntimeMcp,
    probeAgentRuntimeRouteStability,
    probeAgentRuntimeTarget,
    resolveAgentRuntimeTarget
} from '../../shared/ui/agent-runtime-loader/agent-runtime-wait-route.js';

const ORIGIN = 'http://localhost:8080';

test('RoboTeam dashboard waits through an inactive service response before navigation', async () => {
    const targetUrl = resolveAgentRuntimeTarget({
        agentRef: 'AchillesCLI/roboTeamAgent', target: '/base-agent-additional-server/roboTeamAgent/3001/',
    }, ORIGIN);
    let attempts = 0;
    let waits = 0;
    let runtimeReads = 0;
    const result = await waitForAgentRuntimeAvailability({
        agentRef: 'AchillesCLI/roboTeamAgent', label: 'RoboTeam',
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
        agentRef: 'AchillesCLI/roboTeamAgent', label: 'RoboTeam', targetUrl,
    }, ORIGIN);
    const parsed = parseAgentRuntimeWaitRoute(waitingUrl.hash, ORIGIN);
    assert.equal(parsed.agentRef, 'AchillesCLI/roboTeamAgent');
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
        assert.throws(() => resolveAgentRuntimeTarget({ agentRef: 'AchillesCLI/roboTeamAgent', target }, ORIGIN),
            /target is invalid/, target);
    }
});

test('builds and parses a same-agent Explorer waiting route', () => {
    const waitingUrl = buildAgentRuntimeWaitUrl({
        agentRef: 'AchillesIDE/webmeetAgent',
        label: 'WebMeet',
        targetUrl: '/webmeetAgent/roomLoader.html?roomId=room_123'
    }, ORIGIN);
    const parsed = parseAgentRuntimeWaitRoute(waitingUrl.hash, ORIGIN);

    assert.equal(waitingUrl.pathname, '/explorer/index.html');
    assert.equal(parsed.agentRef, 'AchillesIDE/webmeetAgent');
    assert.equal(parsed.label, 'WebMeet');
    assert.equal(parsed.targetUrl.toString(), `${ORIGIN}/webmeetAgent/roomLoader.html?roomId=room_123`);
});

test('rejects cross-origin and cross-agent targets', () => {
    assert.throws(
        () => resolveAgentRuntimeTarget({
            agentRef: 'AchillesIDE/webmeetAgent',
            target: 'https://example.test/webmeetAgent/roomLoader.html'
        }, ORIGIN),
        /target is invalid/
    );
    assert.throws(
        () => resolveAgentRuntimeTarget({
            agentRef: 'AchillesIDE/webmeetAgent',
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

    let bodyCancelled = false;
    const result = await probeAgentRuntimeTarget(targetUrl, async () => ({
        ok: true,
        status: 200,
        redirected: false,
        body: { cancel: async () => { bodyCancelled = true; } }
    }));
    assert.equal(result, targetUrl);
    assert.equal(bodyCancelled, true);
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

    const result = await probeAgentRuntimeMcp('AchillesIDE/webmeetAgent', sdk);
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
        () => probeAgentRuntimeMcp('AchillesIDE/webmeetAgent', sdk),
        (error) => error.code === 'agent_not_ready' && /fetch failed/.test(error.message)
    );
});

test('runtime route probe requires one stable Router generation window', async () => {
    const generations = ['generation-1', 'generation-1'];
    const waits = [];
    const result = await probeAgentRuntimeRouteStability('AchillesIDE/webmeetAgent', {
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
        () => probeAgentRuntimeRouteStability('AchillesIDE/webmeetAgent', {
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
