import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
    addRepo,
    updateRepos,
} from '../roboTeamAgent/copilot/src/lib/repoManager.mjs';

describe('repoManager', () => {
    let tempDir;
    let previousPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-repos-'));
        previousPath = process.env.PATH;
    });

    afterEach(() => {
        process.env.PATH = previousPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });


    it('rejects a symlinked owned repositories directory before scanning or mutation', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-repos-outside-'));
        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli'), { recursive: true });
        fs.symlinkSync(outside, path.join(tempDir, '.data', 'achilles-cli', 'repos'), 'dir');
        try {
            assert.throws(
                () => addRepo('https://example.invalid/blocked.git', 'blocked', tempDir),
                /repositories directory must not be a symbolic link/,
            );
            assert.deepEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('keeps an existing repository and its dependencies unchanged without a legacy agent library', () => {
        const repoPath = path.join(tempDir, '.data', 'achilles-cli', 'repos', 'Existing');
        fs.mkdirSync(path.join(repoPath, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'node_modules', 'keep.txt'), 'user dependency');
        const result = addRepo('file:///missing.git', 'Existing', tempDir);
        assert.equal(result.status, 'exists');
        assert.equal(fs.readFileSync(path.join(repoPath, 'node_modules', 'keep.txt'), 'utf8'), 'user dependency');
        assert.deepEqual(fs.readdirSync(path.join(repoPath, 'node_modules')), ['keep.txt']);
    });

    it('clones a real local repository without installing a legacy skill runtime', () => {
        const origin = path.join(tempDir, 'origin.git');
        execFileSync('git', ['init', '--bare', '--quiet', origin]);
        const result = addRepo(origin, 'Cloned', tempDir);
        assert.equal(result.status, 'cloned');
        assert.equal(fs.statSync(path.join(result.path, '.git')).isDirectory(), true);
        assert.equal(fs.existsSync(path.join(result.path, 'node_modules')), false);
    });

    it('treats shell syntax in repository URLs as data rather than host commands', () => {
        const marker = path.join(tempDir, 'must-not-exist');
        assert.throws(() => addRepo(`file:///missing"; touch "${marker}"; #`, 'Literal', tempDir));
        assert.equal(fs.existsSync(marker), false);
    });

    it('updates all cloned repos with git pull', () => {
        const fakeBin = path.join(tempDir, 'bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(
            path.join(fakeBin, 'git'),
            '#!/bin/sh\necho "Already up to date."\n',
            { mode: 0o755 },
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;

        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli', 'repos', 'RepoA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli', 'repos', 'RepoB'), { recursive: true });

        const result = updateRepos(tempDir);

        assert.equal(result.status, 'updated');
        assert.deepEqual(result.updated.map((entry) => entry.name).sort(), ['RepoA', 'RepoB']);
    });

    it('aggregates git pull failures by repository', () => {
        const fakeBin = path.join(tempDir, 'bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(
            path.join(fakeBin, 'git'),
            [
                '#!/bin/sh',
                'case "$PWD" in',
                '  *RepoFailA) echo "first failure" >&2; exit 1 ;;',
                '  *RepoFailB) echo "second failure" >&2; exit 1 ;;',
                '  *) echo "Already up to date."; exit 0 ;;',
                'esac',
                '',
            ].join('\n'),
            { mode: 0o755 },
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;

        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli', 'repos', 'RepoOk'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli', 'repos', 'RepoFailA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.data', 'achilles-cli', 'repos', 'RepoFailB'), { recursive: true });

        assert.throws(
            () => updateRepos(tempDir),
            (error) => {
                assert.match(error.message, /^failed to update repos:/);
                assert.match(error.message, /RepoFailA: first failure/);
                assert.match(error.message, /RepoFailB: second failure/);
                assert.deepEqual(error.updated.map((entry) => entry.name), ['RepoOk']);
                return true;
            },
        );
    });
});
