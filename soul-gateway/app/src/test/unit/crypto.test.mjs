import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';
import { TEST_ENCRYPTION_KEY } from '../helpers/fixtures.mjs';

config.encryptionKey = TEST_ENCRYPTION_KEY;

const { sha256, encrypt, decrypt, generateApiKey } = await import('../../utils/crypto.mjs');

describe('crypto', () => {
  describe('sha256', () => {
    it('returns a 64-char hex string', () => {
      const hash = sha256('hello');
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      assert.equal(sha256('test'), sha256('test'));
    });

    it('produces different hashes for different inputs', () => {
      assert.notEqual(sha256('a'), sha256('b'));
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips a string', () => {
      const plain = 'sk-soul-abc123';
      const encrypted = encrypt(plain);
      assert.ok(Buffer.isBuffer(encrypted));
      assert.equal(decrypt(encrypted), plain);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const plain = 'same-input';
      const a = encrypt(plain);
      const b = encrypt(plain);
      assert.ok(!a.equals(b));
    });

    it('round-trips through hex string', () => {
      const plain = 'hex-roundtrip';
      const encrypted = encrypt(plain);
      const hexStr = encrypted.toString('hex');
      assert.equal(decrypt(hexStr), plain);
    });

    it('handles empty string', () => {
      const encrypted = encrypt('');
      assert.equal(decrypt(encrypted), '');
    });

    it('handles unicode', () => {
      const plain = 'hello \u{1F600} world';
      assert.equal(decrypt(encrypt(plain)), plain);
    });
  });

  describe('generateApiKey', () => {
    it('starts with sk-soul- prefix', () => {
      const key = generateApiKey();
      assert.ok(key.startsWith('sk-soul-'));
    });

    it('has correct length (8 prefix + 64 hex chars)', () => {
      const key = generateApiKey();
      assert.equal(key.length, 8 + 64);
    });

    it('generates unique keys', () => {
      const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
      assert.equal(keys.size, 10);
    });
  });
});
