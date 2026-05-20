import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectPloinkyRepoSkillRoots } from '../achilles-cli/src/index.mjs';

describe('Ploinky repo skill root discovery', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    it('discovers achilles-skills roots from workspace-managed Ploinky repos', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-skill-roots-'));
        tempDirs.push(workspaceRoot);
        const copilotSkillRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'copilot-agents', 'achilles-skills');
        const unrelatedRepoRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'plain-repo');
        fs.mkdirSync(copilotSkillRoot, { recursive: true });
        fs.mkdirSync(unrelatedRepoRoot, { recursive: true });

        const roots = collectPloinkyRepoSkillRoots(
            path.join(workspaceRoot, 'nested', 'project'),
            { PLOINKY_WORKSPACE_ROOT: workspaceRoot }
        );

        assert.deepEqual(roots, [copilotSkillRoot]);
    });

    it('deduplicates roots found through multiple workspace hints', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-skill-roots-'));
        tempDirs.push(workspaceRoot);
        const skillRoot = path.join(workspaceRoot, '.ploinky', 'repos', 'research-pack', 'achilles-skills');
        fs.mkdirSync(skillRoot, { recursive: true });

        const roots = collectPloinkyRepoSkillRoots(
            path.join(workspaceRoot, 'project'),
            {
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                PLOINKY_CWD: workspaceRoot,
                WORKSPACE_PATH: path.join(workspaceRoot, '.ploinky', 'agents', 'achilles-cli'),
            }
        );

        assert.deepEqual(roots, [skillRoot]);
    });
});
