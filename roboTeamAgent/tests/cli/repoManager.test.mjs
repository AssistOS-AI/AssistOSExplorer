import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    addRepo,
    ensureAgentLibLinkForRepo,
    ensureAgentLibLinksForRepos,
    resolveAgentLibDir,
    updateRepos,
} from '../achilles-cli/src/lib/repoManager.mjs';

describe('repoManager achillesAgentLib links', () => {
    let tempDir;
    let previousAgentLibDir;
    let previousPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-repos-'));
        previousAgentLibDir = process.env.ACHILLES_AGENT_LIB_DIR;
        previousPath = process.env.PATH;
        const fakeAgentLibDir = path.join(tempDir, 'runtime-agent-lib');
        fs.mkdirSync(fakeAgentLibDir, { recursive: true });
        fs.writeFileSync(path.join(fakeAgentLibDir, 'package.json'), '{"name":"achillesAgentLib"}\n');
        process.env.ACHILLES_AGENT_LIB_DIR = fakeAgentLibDir;
    });

    afterEach(() => {
        if (previousAgentLibDir === undefined) {
            delete process.env.ACHILLES_AGENT_LIB_DIR;
        } else {
            process.env.ACHILLES_AGENT_LIB_DIR = previousAgentLibDir;
        }
        process.env.PATH = previousPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates achillesAgentLib symlink for a repo', () => {
        const repoPath = path.join(tempDir, '.achilles-cli', 'repos', 'WebAdminSkills');
        fs.mkdirSync(repoPath, { recursive: true });

        const result = ensureAgentLibLinkForRepo(repoPath);
        const linkPath = path.join(repoPath, 'node_modules', 'achillesAgentLib');

        assert.equal(result.status, 'linked');
        assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
        assert.equal(path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)), resolveAgentLibDir());
    });

    it('replaces stale achillesAgentLib symlink', () => {
        const repoPath = path.join(tempDir, '.achilles-cli', 'repos', 'WebAdminSkills');
        const nodeModulesDir = path.join(repoPath, 'node_modules');
        const linkPath = path.join(nodeModulesDir, 'achillesAgentLib');
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.symlinkSync('/tmp/nonexistent-achilles-lib', linkPath, 'dir');

        const result = ensureAgentLibLinkForRepo(repoPath);

        assert.equal(result.status, 'linked');
        assert.equal(path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)), resolveAgentLibDir());
    });

    it('preserves a real achillesAgentLib directory', () => {
        const repoPath = path.join(tempDir, '.achilles-cli', 'repos', 'WebAdminSkills');
        const realPackageDir = path.join(repoPath, 'node_modules', 'achillesAgentLib');
        fs.mkdirSync(realPackageDir, { recursive: true });
        fs.writeFileSync(path.join(realPackageDir, 'package.json'), '{}\n');

        const result = ensureAgentLibLinkForRepo(repoPath);

        assert.equal(result.status, 'preserved');
        assert.equal(fs.lstatSync(realPackageDir).isDirectory(), true);
        assert.equal(fs.lstatSync(realPackageDir).isSymbolicLink(), false);
    });

    it('repairs all cloned repos under .achilles-cli/repos', () => {
        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoB'), { recursive: true });

        const results = ensureAgentLibLinksForRepos(tempDir);

        assert.deepEqual(results.map((entry) => entry.repo).sort(), ['RepoA', 'RepoB']);
        for (const repoName of ['RepoA', 'RepoB']) {
            assert.equal(
                fs.lstatSync(path.join(tempDir, '.achilles-cli', 'repos', repoName, 'node_modules', 'achillesAgentLib')).isSymbolicLink(),
                true,
            );
        }
    });

    it('links existing repos when addRepo returns exists', () => {
        const repoPath = path.join(tempDir, '.achilles-cli', 'repos', 'WebAdminSkills');
        fs.mkdirSync(repoPath, { recursive: true });

        const result = addRepo('https://example.invalid/WebAdminSkills.git', 'WebAdminSkills', tempDir);

        assert.equal(result.status, 'exists');
        assert.equal(
            fs.lstatSync(path.join(repoPath, 'node_modules', 'achillesAgentLib')).isSymbolicLink(),
            true,
        );
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

        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoB'), { recursive: true });

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

        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoOk'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoFailA'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.achilles-cli', 'repos', 'RepoFailB'), { recursive: true });

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
