import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from '../config.mjs';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = config.encryptionKey;
  if (!hex || hex.length < 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, enc]);
}

export function decrypt(buf) {
  const key = getKey();
  if (typeof buf === 'string') buf = Buffer.from(buf, 'hex');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function generateApiKey() {
  return 'sk-soul-' + randomBytes(32).toString('hex');
}
