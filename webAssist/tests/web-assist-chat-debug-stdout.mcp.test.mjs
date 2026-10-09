import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { PLOINKY_ROOT_PATH, guestGrant, toolEnvelope } from './fixtures/verified-grant.mjs';

// The real tool processes run with ACHILLES_DEBUG=1 from process start, so the
// agent library prints its debug banner to stdout before the JSON. Their real
// stdout (and stderr, as AgentServer appends it) goes through the widget
// parser. Inference is replaced by the preload stub.
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const STUB = pathToFileURL(path.join(agentRoot, 'tests/fixtures/agent-server-inference-stub.mjs')).href;
const WIDGET = '../IDE-plugins/web-assist-chat/web-assist-chat.js';
const SITE_ID = 'demo-site';

function runTool(script, envelope, { cwd, env }) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [`--import=${STUB}`, path.join(agentRoot, script), ...(script.endsWith('index.mjs') ? ['-mcp'] : [])], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify(envelope));
    });
}

// The shape AgentServer returns for a successful sync tool call.
function asToolResult({ stdout, stderr }) {
    const content = [{ type: 'text', text: stdout.length ? stdout : '(no output)' }];
    if (stderr.trim()) content.push({ type: 'text', text: `stderr:\n${stderr}` });
    return { content };
}

async function treeContains(root, needle) {
    const hits = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && (await fs.readFile(full, 'latin1')).includes(needle)) hits.push(full);
        }
    }
    return hits;
}

test('widget parses real debug-mode tool stdout and the secret stays out of cwd and debug logs (F1)', { timeout: 120000 }, async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    await ensureSiteAku({ siteId: SITE_ID });
    const cwd = path.join(sandbox.sandboxRoot, 'tool-cwd');
    const recordDir = path.join(sandbox.sandboxRoot, 'inference-records');
    await fs.mkdir(cwd);
    await fs.mkdir(recordDir);
    const env = {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: sandbox.sandboxRoot,
        TMPDIR: sandbox.sandboxRoot,
        ACHILLES_DEBUG: '1',
        WEBASSIST_DEBUG_DIR: path.join(cwd, 'debuglogs'),
        WEBASSIST_DATA_ROOT: sandbox.webAssistDataDir,
        WEBASSIST_TEST_INFERENCE_RECORD_DIR: recordDir,
        PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR || path.join(PLOINKY_ROOT_PATH, 'node_modules/achillesAgentLib'),
        PLOINKY_INVOCATION_AUTH_MODULE: pathToFileURL(path.join(PLOINKY_ROOT_PATH, 'Agent/lib/invocation-auth.mjs')).href,
    };
    const { WebAssistMcpChatClient } = await import(WIDGET);
    const widgetWith = (toolResult) => {
        const client = new WebAssistMcpChatClient({ validateTools: false });
        client.mcpClient = { callTool: async () => toolResult };
        return client;
    };

    const created = await runTool('src/index.mjs', toolEnvelope(await guestGrant(), { siteId: SITE_ID, message: 'F1-FIRST-TURN', json: true }), { cwd, env });
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /^\[AchillesAgentsLib\] Default LLM configuration:/m, 'debug banner precedes the JSON on stdout');
    const chat = await widgetWith(asToolResult(created)).invokeChat(SITE_ID, 'F1-FIRST-TURN');
    assert.equal(chat.responseText, 'Stubbed webAssist answer.');
    assert.match(chat.sessionId, /^session-/);
    assert.match(chat.sessionSecret, /^[A-Za-z0-9_-]{43}$/);
    const secret = chat.sessionSecret;
    assert.equal(created.stdout.split(secret).length - 1, 1, 'the creating stdout carries the secret once');

    const otherGuest = await guestGrant();
    const continued = await runTool('src/index.mjs', toolEnvelope(otherGuest, { siteId: SITE_ID, sessionId: chat.sessionId, sessionSecret: secret, message: 'F1-SECOND-TURN', json: true }), { cwd, env });
    assert.equal(continued.code, 0, continued.stderr);
    const second = await widgetWith(asToolResult(continued)).invokeChat(SITE_ID, 'F1-SECOND-TURN', chat.sessionId, secret);
    assert.equal(second.sessionId, chat.sessionId, 'the secret continued the session');
    assert.equal(second.sessionSecret, '');

    const read = await runTool('src/mcp/get-session-history.mjs', toolEnvelope(otherGuest, { siteId: SITE_ID, sessionId: chat.sessionId, sessionSecret: secret }, 'web_cli_history'), { cwd, env });
    assert.equal(read.code, 0, read.stderr);
    const history = await widgetWith(asToolResult(read)).invokeHistory(SITE_ID, chat.sessionId, secret);
    assert.deepEqual(history.history.map((entry) => entry.message), ['F1-FIRST-TURN', 'Stubbed webAssist answer.', 'F1-SECOND-TURN', 'Stubbed webAssist answer.']);

    for (const [label, text] of [['continued stdout', continued.stdout], ['history stdout', read.stdout], ['stderr', created.stderr + continued.stderr + read.stderr]]) {
        assert.equal(text.includes(secret), false, `${label} contains the secret`);
    }
    const debugFiles = await fs.readdir(path.join(cwd, 'debuglogs'));
    assert.ok(debugFiles.some((name) => name.startsWith('runtime-prompt-')), 'debug capture ran');
    assert.deepEqual(await treeContains(cwd, secret), [], 'cwd and debuglogs contain the secret');
    assert.deepEqual(await treeContains(recordDir, secret), [], 'inference input contains the secret');
    assert.deepEqual(await treeContains(sandbox.webAssistDataDir, secret), [], 'storage contains the secret');
});
