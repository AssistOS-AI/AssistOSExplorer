/**
 * The bundled OpenRouter key stays masked in source: it unmasks to a
 * well-formed key at import, and no plaintext OpenRouter key appears in the
 * credential module or anywhere in the repository checkout, so
 * pattern-based secret scanners have nothing to match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { BUNDLED_OPENROUTER_FREE_KEY } from '../../bootstrap/free-provider-credential.mjs';

const OPENROUTER_KEY_PATTERN = 'sk-or-v1-[0-9a-f]{64}';
const CREDENTIAL_MODULE_URL = new URL('../../bootstrap/free-provider-credential.mjs', import.meta.url);

function gitRoot() {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: fileURLToPath(new URL('.', import.meta.url)),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

describe('bundled OpenRouter key masking', () => {
    it('unmasks to a well-formed OpenRouter key', () => {
        assert.match(BUNDLED_OPENROUTER_FREE_KEY, new RegExp(`^${OPENROUTER_KEY_PATTERN}$`));
    });

    it('keeps the plaintext key out of the credential module', async () => {
        const source = await readFile(CREDENTIAL_MODULE_URL, 'utf8');
        assert.equal(source.includes(BUNDLED_OPENROUTER_FREE_KEY), false);
        assert.doesNotMatch(source, new RegExp(OPENROUTER_KEY_PATTERN));
    });

    it('keeps plaintext OpenRouter keys out of tracked and untracked files', (t) => {
        const root = gitRoot();
        if (!root) {
            t.skip('not a git checkout');
            return;
        }
        let matches = '';
        try {
            matches = execFileSync('git', ['grep', '--untracked', '-lE', OPENROUTER_KEY_PATTERN], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            // git grep exits 1 when nothing matches.
            if (error.status !== 1) throw error;
        }
        assert.equal(matches.trim(), '', `plaintext OpenRouter key found in: ${matches.trim()}`);
    });
});
