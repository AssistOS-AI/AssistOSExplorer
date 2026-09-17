import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUTH_CODE_PURPOSES, authCodeMessage } from '../lib/authCodeMessage.mjs';

test('sign-in codes keep the generic message and template variables', () => {
    assert.deepEqual(authCodeMessage({ code: '123456' }), {
        subject: 'Your authentication code',
        text: 'Your authentication code is: 123456',
        variables: { code: '123456' },
    });
    assert.deepEqual(authCodeMessage({ code: '123456', purpose: '' }).variables, { code: '123456' });
});

test('signup verification wording never implies an existing account and passes the purpose to templates', () => {
    const message = authCodeMessage({ code: '654321', purpose: 'signup-verification' });
    assert.equal(message.subject, 'Verify your email to finish creating your account');
    assert.equal(message.text, 'Use this code to verify your email address: 654321. Your account is created only after you enter this code on the sign-up page. '
        + 'If you did not start a sign-up, ignore this message. Never share this code.');
    assert.deepEqual(message.variables, { code: '654321', purpose: 'signup-verification' });
    assert.doesNotMatch(message.text, /your account (has been|was) created|welcome/i);
});

test('an unsupported purpose fails closed and the tool schema allows only the signup purpose', async () => {
    for (const purpose of ['login', 'register', 'SIGNUP-VERIFICATION', 42]) {
        assert.throws(() => authCodeMessage({ code: '123456', purpose }), /Unsupported authentication code purpose/);
    }
    const tools = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8')).tools;
    const schema = tools.find((tool) => tool.name === 'email_send_auth_code').inputSchema;
    assert.deepEqual(schema.properties.purpose, { type: 'string', enum: [...AUTH_CODE_PURPOSES] });
    assert.deepEqual(schema.required, ['to', 'code']);
    assert.equal(schema.additionalProperties, false);
});
