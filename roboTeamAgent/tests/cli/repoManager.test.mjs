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
} from '../achilles-cli/src/lib/repoManager.mjs';

describe('repoManager achillesAgentLib links', () => {
    let tempDir;
    let previousAgentLibDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-repos-'));
        previousAgentLibDir = process.env.ACHILLES_AGENT_LIB_DIR;
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
});
