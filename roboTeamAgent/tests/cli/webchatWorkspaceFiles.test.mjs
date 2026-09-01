import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    __testables,
    createWebchatWorkspaceFileIndex,
} from '../achilles-cli/src/lib/webchatWorkspaceFiles.mjs';

function makeWorkingDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-workspace-files-'));
}

test('workspace file scan returns safe project files and skips runtime trees and symlinks', async () => {
    const root = makeWorkingDir();
    const outside = makeWorkingDir();
    try {
        fs.mkdirSync(path.join(root, 'docs'));
        fs.writeFileSync(path.join(root, 'README.md'), 'readme');
        fs.writeFileSync(path.join(root, 'docs', 'report.md'), 'report');
        for (const ignored of ['.achilles-cli', '.data', '.git', '.ploinky', 'node_modules']) {
            fs.mkdirSync(path.join(root, ignored));
            fs.writeFileSync(path.join(root, ignored, 'ignored.txt'), 'ignored');
        }
        fs.mkdirSync(path.join(root, 'private.secrets'));
        fs.writeFileSync(path.join(root, 'private.secrets', 'token.txt'), 'secret');
        fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
        try {
            fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'linked.txt'));
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        }

        assert.deepEqual(
            await __testables.collectWorkspaceFiles(root),
            ['docs/report.md', 'README.md'],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('workspace file index emits an initial snapshot and only changed deltas afterwards', async () => {
    let scanned = ['README.md', 'src/index.mjs'];
    const output = [];
    const index = createWebchatWorkspaceFileIndex({
        workingDir: '/workspace',
        write: (value) => output.push(JSON.parse(value)),
        refreshIntervalMs: 60000,
        scan: async () => scanned,
    });
    try {
        await index.start();
        assert.deepEqual(output, [{
            __webchatWorkspaceFiles: 1,
            version: 1,
            indexVersion: 1,
            reset: true,
            files: ['README.md', 'src/index.mjs'],
        }]);

        await index.refresh();
        assert.equal(output.length, 1);

        scanned = ['README.md', 'reports/final.md'];
        await index.refresh();
        assert.deepEqual(output[1], {
            __webchatWorkspaceFiles: 1,
            version: 1,
            indexVersion: 2,
            reset: false,
            added: ['reports/final.md'],
            removed: ['src/index.mjs'],
        });
        assert.deepEqual(index.snapshot(), {
            version: 2,
            files: ['README.md', 'reports/final.md'],
        });
    } finally {
        index.stop();
    }
});

test('response refresh runs a new scan after an overlapping periodic refresh', async () => {
    const output = [];
    let releasePeriodic;
    let scanCount = 0;
    const index = createWebchatWorkspaceFileIndex({
        workingDir: '/workspace',
        refreshIntervalMs: 60000,
        write: (value) => output.push(JSON.parse(value)),
        scan: async () => {
            scanCount += 1;
            if (scanCount === 1) return ['before.md'];
            if (scanCount === 2) {
                return new Promise((resolve) => {
                    releasePeriodic = () => resolve(['before.md']);
                });
            }
            return ['before.md', 'created-by-turn.md'];
        },
    });
    try {
        await index.start();
        const periodicRefresh = index.refresh();
        await Promise.resolve();
        const responseRefresh = index.refresh({ afterCurrent: true });
        releasePeriodic();
        await Promise.all([periodicRefresh, responseRefresh]);

        assert.equal(scanCount, 3);
        assert.deepEqual(output.at(-1), {
            __webchatWorkspaceFiles: 1,
            version: 1,
            indexVersion: 2,
            reset: false,
            added: ['created-by-turn.md'],
            removed: [],
        });
    } finally {
        index.stop();
    }
});
