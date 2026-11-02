import assert from 'node:assert/strict';

export const FREE_COPILOT_MODEL = 'soul-gateway/openrouter-free/nvidia/nemotron-3-ultra-550b-a55b:free';
const BASE = '/base-agent-additional-server/roboTeamAgent/3001';

export function requiresFreeCopilotSetup(spec) {
    return /(?:^|\/)(?:\d+-copilot[^/]*|07-live-sessions|08-robowork-restart|70-copilot-semantic-routing)\.spec\.mjs$/u.test(spec);
}

export function requireFreeCopilotSetup(env = process.env) {
    assert.equal(env.SMOKE_ROBOWORK_MODEL_SETUP, '1', 'Every Copilot cohort requires SMOKE_ROBOWORK_MODEL_SETUP=1; no default-route fallback is permitted.');
}

// The deployment operator installs its private provider key before this setup.
// Only the normal authenticated controller mutation crosses this boundary.
export async function configureFreeCopilotRobot(page, robotId) {
    assert.match(robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
    const token = await page.request.get('/auth/token?mutationRoute=roboTeamAgent', { maxRedirects: 0 });
    assert.equal(token.status(), 200, 'Authenticated model setup requires the administrator mutation proof.');
    const { browserMutation: proof } = await token.json();
    assert.equal(proof?.routeKey, 'roboTeamAgent');
    assert.equal(proof?.origin, new URL(page.url()).origin);
    assert.ok(proof.csrfToken);
    const route = `${BASE}/api/robots/${robotId}/coding-agents`;
    const patched = await page.request.patch(route, { maxRedirects: 0,
        headers: { origin: proof.origin, 'x-ploinky-browser-csrf-token': proof.csrfToken },
        data: { codingAgents: ['opencode'], model: FREE_COPILOT_MODEL } });
    assert.equal(patched.status(), 200, 'Normal RoboTeam model PATCH failed; setup cannot fall back.');
    const result = await patched.json();
    assert.equal(result.ok, true);
    assert.equal(result.robot?.id, robotId);
    assert.deepEqual(result.robot?.codingAgents, ['opencode']);
    const readback = await page.request.get(route, { maxRedirects: 0 });
    assert.equal(readback.status(), 200);
    const config = await readback.json();
    assert.equal(config.ok, true);
    assert.equal(config.codingAgent, 'opencode');
    assert.equal(config.models?.opencode, FREE_COPILOT_MODEL, 'Persisted model differs from the required route.');
    return { robotId, route, method: 'PATCH', status: 200, backend: config.codingAgent, model: config.models.opencode };
}

export async function configureFreeCopilotRobots(page) {
    const response = await page.request.get(`${BASE}/api/robots`, { maxRedirects: 0 });
    assert.equal(response.status(), 200);
    const payload = await response.json();
    assert.equal(payload.ok, true); assert.equal(payload.canAdmin, true);
    assert.ok(Array.isArray(payload.robots) && payload.robots.length > 0 && payload.robots.length <= 512);
    assert.equal(payload.robots.filter(robot => robot.name === 'default').length, 1, 'Model setup requires the default robot too.');
    const receipts = [];
    for (const robot of payload.robots) receipts.push(await configureFreeCopilotRobot(page, robot.id));
    return receipts;
}

// CDP observes the Router's actual SSE event after each accepted submission.
// Initial configuration or a model chip alone cannot satisfy a turn's proof.
export async function observeFreeCopilotRoutes(context, testInfo, { attempts = [] } = {}) {
    // Manual multi-account fixtures share one test-owned attempt list. Observer
    // accounts do not submit turns; the whole model test still requires one.
    const sessions = [], pending = [], failures = [], listeners = [];
    const observe = page => {
        const attach = (async () => {
            const cdp = await context.newCDPSession(page);
            sessions.push(cdp);
            const streams = new Map();
            let current = null;
            cdp.on('Network.requestWillBeSent', event => {
                const url = new URL(event.request.url);
                if (url.pathname === '/webchat/stream' && url.searchParams.get('agent') === 'roboTeamAgent') {
                    streams.set(event.requestId, { origin: url.origin, tabId: url.searchParams.get('tabId'), pageInstanceId: url.searchParams.get('pageInstanceId') });
                }
            });
            const submitted = request => {
                const url = new URL(request.url());
                if (url.pathname !== '/webchat/input' || request.method() !== 'POST'
                    || url.searchParams.get('agent') !== 'roboTeamAgent') return;
                current = { attempt: attempts.length + 1, origin: url.origin, tabId: url.searchParams.get('tabId'),
                    pageInstanceId: url.searchParams.get('pageInstanceId'), accepted: false, routes: [] };
                if (!current.tabId || !current.pageInstanceId || url.origin !== new URL(page.url()).origin) {
                    failures.push(new Error('Copilot input must belong to the observed page, tab and page instance.'));
                }
                attempts.push(current);
                const entry = current;
                pending.push(request.response().then(response => {
                    assert.equal(response?.status(), 204, 'Copilot submission was not accepted.'); entry.accepted = true;
                }).catch(error => failures.push(error)));
            };
            page.on('request', submitted);
            listeners.push(() => page.off('request', submitted));
            cdp.on('Network.eventSourceMessageReceived', event => {
                if (!current || event.eventName !== 'runtime-state') return;
                try {
                    const stream = streams.get(event.requestId);
                    if (!stream || stream.origin !== current.origin || stream.tabId !== current.tabId || stream.pageInstanceId !== current.pageInstanceId) return;
                    const state = JSON.parse(event.data);
                    if (state.targetTabId !== current.tabId || state.targetPageInstanceId !== current.pageInstanceId) return;
                    assert.equal(state.backend, 'opencode', 'Actual Copilot backend changed.');
                    assert.equal(state.model, FREE_COPILOT_MODEL, 'Actual Copilot turn used another model route.');
                    current.routes.push({ backend: state.backend, model: state.model });
                } catch (error) { failures.push(error); }
            });
            await cdp.send('Network.enable');
        })().catch(error => failures.push(error));
        pending.push(attach);
    };
    context.on('page', observe);
    for (const page of context.pages()) observe(page);
    return async () => {
        context.off('page', observe);
        try {
            // Submissions can append response settlements while page hooks run.
            for (let index = 0; index < pending.length; index++) await pending[index];
            await testInfo.attach('copilot-model-route.json', { body: Buffer.from(JSON.stringify({ model: FREE_COPILOT_MODEL, attempts })),
                contentType: 'application/json' });
            if (failures.length) throw failures[0];
            assert.ok(attempts.some(attempt => attempt.accepted), 'Model tests require at least one accepted Copilot input and its actual route proof.');
            for (const attempt of attempts) {
                assert.equal(attempt.accepted, true);
                assert.ok(attempt.routes.length > 0, 'Accepted Copilot input has no actual post-submission model-route event.');
            }
        } finally {
            for (const remove of listeners) remove();
            for (const session of sessions) await session.detach().catch(() => {});
        }
    };
}
