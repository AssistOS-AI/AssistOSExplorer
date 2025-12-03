/**
 * Shared test utilities for CLI tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function createTempDir(prefix = 'test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTempDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
