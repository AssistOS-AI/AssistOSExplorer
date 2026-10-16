import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { initRobotLogViewer } from '../public/robot-log-viewer.js';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { authHeader, routerFetch as fetch } from './helpers/router-signed.mjs';

function fixture(load = async () => ({ logs: 'first line' })) {
    const output = { textContent: 'Loading…', scrollHeight: 1000, clientHeight: 100, scrollTop: 0 };
    const status = { textContent: '' };
    const timers = new Map();
    let timerId = 0;
    const viewer = initRobotLogViewer({ output, status, loadLogs: load, frame: callback => callback(),
        schedule(callback, delay) { assert.equal(delay, 1000); timers.set(++timerId, callback); return timerId; },
        cancel(id) { timers.delete(id); },
    });
    return { output, status, viewer, timers };
}

test('separate logs viewer follows new output but preserves scroll when reading older lines', async () => {
    let logs = '<script>plain log text</script>';
    const f = fixture(async () => ({ logs }));
    await f.viewer.start();
    assert.equal(f.output.textContent, logs);
    assert.equal(f.output.scrollTop, 1000);
    assert.equal(f.timers.size, 1);
    assert.match(f.status.textContent, /Live.*200 lines/);
    f.output.scrollTop = 50;
    logs = 'new line';
    await f.viewer.start();
    assert.equal(f.output.textContent, 'new line');
    assert.equal(f.output.scrollTop, 50);
    assert.equal(f.timers.size, 1);
    f.output.scrollTop = 900;
    logs = 'latest line';
    await f.viewer.start();
    assert.equal(f.output.scrollTop, 1000);
    f.viewer.pause();
    assert.equal(f.timers.size, 0);
});

test('empty output, refresh errors and manual recovery are visible without losing previous logs', async () => {
    let failing = false;
    const f = fixture(async () => {
        if (failing) throw new Error('not available');
        return { logs: '' };
    });
    await f.viewer.start();
    assert.equal(f.output.textContent, 'No container output yet.');
    failing = true;
    await f.viewer.start();
    assert.equal(f.timers.size, 0);
    assert.match(f.status.textContent, /not available.*Refresh to retry/);
    assert.equal(f.output.textContent, 'No container output yet.');
    failing = false;
    await f.viewer.start();
    assert.equal(f.timers.size, 1);
    assert.match(f.status.textContent, /Live/);
    f.viewer.pause();
    const unavailable = fixture(async () => { throw new Error('access denied'); });
    await unavailable.viewer.start();
    assert.equal(unavailable.output.textContent, 'Logs are unavailable.');
    assert.equal(unavailable.timers.size, 0);
});

test('polling avoids overlapping requests and ignores aborted or stale responses after page restore', async () => {
    const requests = [];
    const f = fixture(signal => new Promise(resolve => { requests.push({ signal, resolve }); }));
    const first = f.viewer.start();
    await f.viewer.start();
    assert.equal(requests.length, 1);
    f.viewer.pause();
    assert.equal(requests[0].signal.aborted, true);
    const restored = f.viewer.start();
    requests[0].resolve({ logs: 'stale' });
    await first;
    assert.equal(f.output.textContent, 'Loading…');
    requests[1].resolve({ logs: 'current' });
    await restored;
    assert.equal(f.output.textContent, 'current');
    assert.equal(f.timers.size, 1);
    const tick = [...f.timers.values()][0];
    tick();
    tick();
    assert.equal(requests.length, 3);
    f.viewer.pause();
    requests[2].resolve({ logs: 'closed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.output.textContent, 'current');
    assert.equal(f.timers.size, 0);
});

test('logs page provides refresh, close and dashboard navigation with polling tied to its own lifecycle', async () => {
    const html = await readFile(new URL('../public/robot-logs.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/robot-logs.js', import.meta.url), 'utf8');
    assert.match(html, /id="robotLogsOutput"[^>]*tabindex="0"/);
    for (const id of ['refreshLogsButton', 'closeLogsButton', 'robotsLink']) assert.ok(html.includes(`id="${id}"`));
    assert.match(html, /assistosExplorerTheme/);
    assert.match(source, /\/logs\?tail=200/);
    assert.match(source, /pagehide.*viewer\.pause\(\)/);
    assert.match(source, /pageshow.*viewer\.start\(\)/);
    assert.match(source, /window\.close\(\)/);
    assert.doesNotMatch(source, /innerHTML|method: 'POST'/);
});

test('robot logs page, scripts and existing logs API require authentication and never start a robot', async t => {
    const robot = { id: 'default-a5c466', name: 'default' };
    const calls = [];
    const server = createRoboTeamServer({
        robotStore: { get: async id => id === robot.id ? robot : null },
        runtimeManager: { logs: async (id, tail) => { calls.push({ id, tail }); return 'synthetic log'; } },
        robotModels: {}, skillsets: {}, internalToken: 'logs-test', publicBasePath: '/rt/',
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'x-ploinky-auth-info': authHeader('actor', []) };
    for (const relative of [`robots/${robot.id}/logs`, 'robot-logs.js', 'robot-log-viewer.js', `api/robots/${robot.id}/logs?tail=200`]) {
        const anonymous = await fetch(`${base}/${relative}`);
        assert.equal(anonymous.status, 401);
        await anonymous.text();
    }
    assert.equal(calls.length, 0);
    const page = await fetch(`${base}/robots/${robot.id}/logs`, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<base href="\/rt\/">[\s\S]*robotLogsOutput/);
    for (const file of ['robot-logs.js', 'robot-log-viewer.js']) {
        const script = await fetch(`${base}/${file}`, { headers });
        assert.equal(script.status, 200);
        assert.match(script.headers.get('content-type'), /javascript/);
        await script.text();
    }
    const result = await fetch(`${base}/api/robots/${robot.id}/logs?tail=200`, { headers });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).logs, 'synthetic log');
    assert.deepEqual(calls, [{ id: robot.id, tail: '200' }]);
    const missing = await fetch(`${base}/robots/missing-robot/logs`, { headers });
    assert.equal(missing.status, 404);
    await missing.text();
});
