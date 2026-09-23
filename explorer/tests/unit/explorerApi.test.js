import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolResult, ensureSuccess, ToolError } from '../../services/infrastructure/explorerApi.js';

test('parseToolResult handles content json block', () => {
    const payload = {
        content: [{ type: 'json', json: { ok: true, value: 42 } }]
    };
    assert.deepEqual(parseToolResult(payload), { ok: true, value: 42 });
});

test('parseToolResult handles text json', () => {
    const payload = { text: '{"ok":true,"items":[1,2]}' };
    assert.deepEqual(parseToolResult(payload), { ok: true, items: [1, 2] });
});

test('ensureSuccess throws ToolError on Error text', () => {
    const payload = { text: 'Error: something went wrong' };
    assert.throws(() => ensureSuccess(payload), (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'tool_error');
        return true;
    });
});

test('ensureSuccess preserves MCP execution errors', () => {
    const payload = {
        content: [{ type: 'text', text: 'MCP error -32600: Invocation rejected' }]
    };
    assert.throws(() => ensureSuccess(payload), (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'tool_error');
        assert.equal(err.message, 'MCP error -32600: Invocation rejected');
        return true;
    });
});

test('ensureSuccess throws ToolError on ok false', () => {
    const payload = { text: '{"ok":false,"error":"bad"}' };
    assert.throws(() => ensureSuccess(payload), (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'tool_error');
        return true;
    });
});

let authTestModuleId = 0;

async function authFailureHarness(t, errors) {
    const previousWindow = globalThis.window;
    const alerts = [];
    const redirects = [];
    const failures = [...errors];
    const user = { id: 'persisted-administrator', roles: ['admin'] };
    const failCall = async () => { throw failures.shift(); };
    const location = {
        origin: 'http://localhost:8080',
        pathname: '/explorer/',
        search: '?view=list',
        hash: '#workspace-monitor-dashboard',
        assign: (url) => redirects.push(url),
    };
    globalThis.window = {
        location,
        assistOS: { user },
        alert: (message) => alerts.push(message),
        webSkel: {
            appServices: {
                getClient: () => ({ callTool: failCall }),
                callTool: failCall,
            },
        },
    };
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const moduleUrl = new URL('../../services/infrastructure/explorerApi.js', import.meta.url);
    moduleUrl.searchParams.set('authTest', String(++authTestModuleId));
    const api = await import(moduleUrl.href);
    return {
        api,
        alerts,
        redirects,
        user,
        returnTo: `${location.pathname}${location.search}${location.hash}`,
    };
}

const toolCallers = {
    callAgentTool: (api) => api.callAgentTool('workspaceMonitorAgent', 'workspace_monitor_snapshot_get', {}),
    callExplorerTool: (api) => api.callExplorerTool('list_directory', {}, { withLoader: false }),
};
const missingMcpSessionMessages = [
    'Missing or invalid MCP session',
    'MCP request failed: HTTP 400 - {"error":"Missing or invalid MCP session"}',
    'MCP request failed: HTTP 401 - {"error":"Missing or invalid MCP session"}',
];

for (const [callerName, call] of Object.entries(toolCallers)) {
    for (const message of missingMcpSessionMessages) {
        test(`${callerName} preserves browser authentication after ${message}`, async (t) => {
            const error = new Error(message);
            const harness = await authFailureHarness(t, [error]);

            await assert.rejects(call(harness.api), (caught) => caught === error);

            assert.deepEqual(harness.alerts, []);
            assert.deepEqual(harness.redirects, []);
            assert.equal(error.sessionExpiredHandled, undefined);
            assert.equal(window.assistOS.user, harness.user);
            assert.deepEqual(window.assistOS.user.roles, ['admin']);
        });
    }

    test(`${callerName} preserves concurrent MCP failures without a login redirect`, async (t) => {
        const errors = missingMcpSessionMessages.map((message) => new Error(message));
        const harness = await authFailureHarness(t, errors);

        const results = await Promise.allSettled(errors.map(() => call(harness.api)));

        assert.deepEqual(results.map((result) => result.status), errors.map(() => 'rejected'));
        for (const [index, result] of results.entries()) {
            assert.equal(result.reason, errors[index]);
            assert.equal(result.reason.sessionExpiredHandled, undefined);
        }
        assert.deepEqual(harness.alerts, []);
        assert.deepEqual(harness.redirects, []);
    });

    test(`${callerName} preserves permission denials without a login redirect`, async (t) => {
        const error = new Error('MCP request failed: HTTP 403 - {"error":"admin_required"}');
        const harness = await authFailureHarness(t, [error]);

        await assert.rejects(call(harness.api), (caught) => caught === error);

        assert.deepEqual(harness.alerts, []);
        assert.deepEqual(harness.redirects, []);
        assert.equal(error.sessionExpiredHandled, undefined);
    });

    test(`${callerName} redirects expired browser sessions back to the monitor route`, async (t) => {
        const error = new Error('MCP request failed: HTTP 401 - {"error":"not_authenticated"}');
        const harness = await authFailureHarness(t, [error]);

        await assert.rejects(call(harness.api), (caught) => caught === error);

        assert.deepEqual(harness.alerts, ['Your session has expired. Redirecting to the login page.']);
        assert.deepEqual(harness.redirects, [`/auth/login?returnTo=${encodeURIComponent(harness.returnTo)}`]);
        assert.equal(error.sessionExpiredHandled, true);
    });

    test(`${callerName} replaces an expired session's MCP return target with the monitor route`, async (t) => {
        const error = new Error(`MCP request failed: HTTP 401 - ${JSON.stringify({
            error: 'not_authenticated',
            login: '/auth/login?returnTo=%2FworkspaceMonitorAgent%2Fmcp&agent=workspaceMonitorAgent',
        })}`);
        const harness = await authFailureHarness(t, [error]);

        await assert.rejects(call(harness.api), (caught) => caught === error);

        assert.equal(harness.alerts.length, 1);
        assert.deepEqual(harness.redirects, [`/auth/login?returnTo=${encodeURIComponent(harness.returnTo)}`]);
        assert.equal(error.sessionExpiredHandled, true);
    });
}
