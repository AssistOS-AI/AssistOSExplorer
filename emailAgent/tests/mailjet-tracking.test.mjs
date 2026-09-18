import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = mkdtempSync(join(tmpdir(), 'emailagent-mailjet-'));
process.env.EMAILAGENT_SETTINGS_KEY = 'mailjet-tracking-unit-key';
process.env.EMAILAGENT_SETTINGS_FILE = join(folder, 'settings.enc.json');

const { saveSettings } = await import('../lib/settings.mjs');
const { sendText } = await import('../lib/mailjet.mjs');

await saveSettings({ MAILJET_API_KEY: 'mj-fixture-key', MAILJET_API_SECRET: 'mj-fixture-secret', MAILJET_FROM_EMAIL: 'sender@example.test' });

async function capturedMessage(input) {
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.mailjet.com/v3.1/send');
        body = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ Messages: [{ To: [{ MessageID: 42 }] }] }) };
    };
    try {
        await sendText(input);
    } finally {
        globalThis.fetch = original;
    }
    return body.Messages[0];
}

test('sendText leaves tracking to the account unless per-message tracking is requested', async () => {
    const plain = await capturedMessage({ to: 'owner@example.test', subject: 'Hello', text: 'Hello.' });
    assert.equal(Object.hasOwn(plain, 'TrackClicks'), false);
    assert.equal(Object.hasOwn(plain, 'TrackOpens'), false);
    const untracked = await capturedMessage({ to: 'owner@example.test', subject: 'Hello', text: 'Hello.', trackClicks: 'disabled', trackOpens: 'disabled' });
    assert.deepEqual([untracked.TrackClicks, untracked.TrackOpens], ['disabled', 'disabled']);
    await assert.rejects(sendText({ to: 'owner@example.test', subject: 'Hello', text: 'Hello.', trackClicks: 'off' }), /trackClicks is invalid/);
});

test('the password reset tool sends its message with click and open tracking disabled', async () => {
    const capture = join(folder, 'request.json');
    const stub = `globalThis.fetch = async (url, options) => { (await import('node:fs')).writeFileSync(${JSON.stringify(capture)}, options.body);
        return { ok: true, status: 200, json: async () => ({ Messages: [{ To: [{ MessageID: 7 }] }] }) }; };`;
    const envelope = {
        name: 'email_send_password_reset',
        input: { to: 'owner@example.test', resetUrl: 'https://account.example.test/service/auth/reset.html#token=Abc_-0123456789012345678901234567890123456' },
        metadata: { invocation: { iss: 'ploinky-router', sub: 'agent:AssistOSExplorer/userPersistoAgent',
            actor: { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] },
            caller: { kind: 'agent', id: 'agent:AssistOSExplorer/userPersistoAgent', roles: [] } } },
    };
    const output = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`,
            fileURLToPath(new URL('../tools/email_tool.mjs', import.meta.url))], { env: { ...process.env, TOOL_NAME: '' } },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
        child.stdin.end(JSON.stringify(envelope));
    });
    assert.equal(JSON.parse(output).providerMessageId, '7');
    const [message] = JSON.parse(readFileSync(capture, 'utf8')).Messages;
    assert.deepEqual([message.TrackClicks, message.TrackOpens], ['disabled', 'disabled']);
    assert.match(message.HTMLPart, /reset\.html#token=/);
});
