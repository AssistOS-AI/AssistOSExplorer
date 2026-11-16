import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const LEGACY_ROOT = '/data/credentials/';

// The mount changed, not the encrypted files. Rewrite only the known old
// namespace, before auth services can cache account records or refresh tokens.
export async function migrateOAuthCredentialPaths({ pool, baseDir, store, log }) {
    const root = path.resolve(baseDir);
    if (`${root}/` === LEGACY_ROOT) return { migrated: 0, missing: 0 };
    const client = await pool.connect();
    let migrated = 0;
    let missing = 0;
    try {
        await client.query('BEGIN IMMEDIATE');
        const { rows } = await client.query(
            'SELECT id, credentials_path FROM provider_accounts WHERE credentials_path IS NOT NULL'
        );
        for (const account of rows) {
            const previous = account.credentials_path;
            if (!previous.startsWith(LEGACY_ROOT)) continue;
            const suffix = previous.slice(LEGACY_ROOT.length);
            if (suffix.includes('\\') || suffix.includes('\0')
                || suffix.split('/').some(part => !part || part === '.' || part === '..')) {
                throw new Error('Unsafe legacy OAuth credential path');
            }
            const target = path.join(root, suffix);
            try {
                const stat = await lstat(target);
                if (!stat.isFile() || stat.nlink !== 1 || await realpath(target) !== target) {
                    throw new Error('OAuth credential migration requires a regular file without links');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                missing++;
                continue;
            }
            // Confirm that the current encryption key can still read the file.
            // Do not rewrite ciphertext or create a replacement credential.
            if (!await store.read(target)) throw new Error('OAuth credential migration could not read the relocated file');
            const result = await client.query(
                'UPDATE provider_accounts SET credentials_path = $1 WHERE id = $2 AND credentials_path = $3',
                [target, account.id, previous]
            );
            migrated += result.rowCount;
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    if (migrated) log.info('oauth_credential_paths_migrated', { count: migrated });
    if (missing) log.warn('oauth_credential_migration_files_missing', { count: missing });
    return { migrated, missing };
}
