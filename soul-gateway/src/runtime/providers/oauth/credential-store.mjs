import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../../security/encryption.mjs';

export class OAuthCredentialStore {
  constructor({ baseDir, encryptionKey, log }) {
    this._baseDir = baseDir;
    this._encryptionKey = encryptionKey;
    this._log = log;
  }

  async allocatePath(providerId, externalAccountId = null, fallbackName = null) {
    const dir = join(this._baseDir, sanitizePathSegment(providerId || 'provider'));
    await mkdir(dir, { recursive: true });
    const fileName = `${sanitizePathSegment(externalAccountId || fallbackName || randomUUID())}.json.enc`;
    return join(dir, fileName);
  }

  async write(path, payload) {
    await mkdir(dirname(path), { recursive: true });
    const serialized = JSON.stringify(payload);
    const encrypted = encrypt(serialized, this._encryptionKey);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    const content = JSON.stringify(encrypted);
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, path);
  }

  async read(path) {
    if (!path) return null;
    try {
      const raw = await readFile(path, 'utf8');
      const encrypted = JSON.parse(raw);
      return JSON.parse(decrypt(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        this._encryptionKey,
      ));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this._log.error('oauth_credentials_read_failed', { path, error: err.message });
      throw err;
    }
  }

  async delete(path) {
    if (!path) return;
    try {
      await rm(path, { force: true });
    } catch (err) {
      this._log.warn('oauth_credentials_delete_failed', { path, error: err.message });
    }
  }
}

function sanitizePathSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'account';
}
