import assert from 'node:assert/strict';
import test from 'node:test';
import { SecretBox, VAULT_KEY_ENV, requireSecretBox, secretBoxFromEnvironment } from '../server/secret-box.mjs';

test('sealed secrets open only with the same key and differ on every seal', () => {
    const box = new SecretBox('test-vault-key-0123456789');
    const first = box.seal('hunter2'), second = box.seal('hunter2');
    assert.ok(SecretBox.isSealed(first));
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /hunter2/u);
    assert.equal(box.open(first), 'hunter2');
    assert.throws(() => new SecretBox('another-vault-key-0000').open(first), /cannot be decrypted/u);
    assert.throws(() => box.open('hunter2'), /not sealed/u);
    assert.equal(box.fingerprint('a'), new SecretBox('test-vault-key-0123456789').fingerprint('a'));
    assert.notEqual(box.fingerprint('a'), new SecretBox('another-vault-key-0000').fingerprint('a'));
    assert.throws(() => new SecretBox('short'), /at least 16/u);
});

test('the vault key leaves the environment when it is read', () => {
    const environment = { [VAULT_KEY_ENV]: 'test-vault-key-0123456789', OTHER: 'x' };
    assert.ok(secretBoxFromEnvironment(environment) instanceof SecretBox);
    assert.deepEqual(environment, { OTHER: 'x' });
    assert.equal(secretBoxFromEnvironment({}), null);
    assert.throws(() => requireSecretBox(null), error => error.statusCode === 503);
});
