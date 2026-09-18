import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertResetUrl, passwordResetMessage } from '../lib/passwordResetMessage.mjs';

const LINK = 'https://account.example.test/service/auth/reset.html#token=Abc_-0123456789012345678901234567890123456';

test('the reset message carries the link, its expiry and a clear no-action note in text and HTML', () => {
    const message = passwordResetMessage({ resetUrl: LINK });
    assert.equal(message.subject, 'Reset your password');
    assert.match(message.text, /expires in 30 minutes/);
    assert.match(message.text, /If you did not ask for this, ignore this message; your password stays unchanged\./);
    assert.ok(message.text.includes(LINK));
    assert.match(message.html, /<a href="https:\/\/account\.example\.test\/service\/auth\/reset\.html#token=Abc_-0123456789012345678901234567890123456">Choose a new password<\/a>/);
    assert.match(message.html, /expires in 30 minutes/);
    const explicit = passwordResetMessage({ resetUrl: LINK, expiresInMinutes: 15 });
    assert.match(explicit.text, /expires in 15 minutes/);
    assert.match(explicit.html, /expires in 15 minutes/);
});

test('reset URLs must be absolute http(s) links without credentials and within the length bound', () => {
    for (const candidate of [undefined, '', 'not a url', 'ftp://example.test/reset#token=x', 'mailto:owner@example.test',
        'https://user:secret@example.test/reset#token=x', `https://example.test/${'a'.repeat(2048)}`, 42, null]) {
        assert.throws(() => assertResetUrl(candidate), /resetUrl is invalid/);
        assert.throws(() => passwordResetMessage({ resetUrl: candidate }), /resetUrl is invalid/);
    }
    assert.equal(assertResetUrl('http://127.0.0.1:7000/service/auth/reset.html#token=x'), 'http://127.0.0.1:7000/service/auth/reset.html#token=x');
});

test('the tool schema requires to and resetUrl, bounds the expiry and allows no extra properties', async () => {
    const tools = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8')).tools;
    const tool = tools.find((entry) => entry.name === 'email_send_password_reset');
    assert.ok(tool, 'the tool is declared');
    assert.deepEqual(tool.tags, ['internal']);
    assert.deepEqual(tool.inputSchema.required, ['to', 'resetUrl']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.resetUrl, { type: 'string', minLength: 1, maxLength: 2048 });
    assert.deepEqual(tool.inputSchema.properties.expiresInMinutes, { type: 'integer', minimum: 1 });
    assert.equal(tool.inputSchema.properties.to.minLength, 3);
});
