import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { builtInSkillsDir } from '../../copilot/src/lib/skills/cliSkillRoots.mjs';

const resolverUrl = new URL('../../copilot/src/lib/skills/cliSkillRoots.mjs', import.meta.url).href;

describe('Ploinky marketplace skill root discovery', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    function fixture(repositories = []) {
        const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-skill-roots-')));
        tempDirs.push(workspaceRoot);
        const client = path.join(workspaceRoot, 'ploinky', 'Agent', 'client', 'RepositoryClient.mjs');
        fs.mkdirSync(path.dirname(client), { recursive: true });
        fs.writeFileSync(client, `export function createRepositoryClient() {
            return { listRepositories: async () => ${JSON.stringify(repositories)} };
        }\n`);
        return workspaceRoot;
    }

    function writeSkill(root) {
        fs.mkdirSync(path.join(root, 'probe'), { recursive: true });
        fs.writeFileSync(path.join(root, 'probe', 'SKILL.md'), '---\nname: probe\ndescription: Probe skill.\n---\nProbe.\n');
    }

    function resolveRoots(workspaceRoot, skillRoots = []) {
        const script = `const { resolveSkillCatalogRoots } = await import(${JSON.stringify(resolverUrl)});
            console.log(JSON.stringify(await resolveSkillCatalogRoots(${JSON.stringify(workspaceRoot)},
                { skillRoots: ${JSON.stringify(skillRoots)} })));`;
        return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8', cwd: workspaceRoot,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                PLOINKY_CWD: workspaceRoot, WORKSPACE_PATH: workspaceRoot },
        }));
    }

    it('does not scan workspace, authoring or legacy managed checkout directories', () => {
        const workspaceRoot = fixture();
        for (const relative of ['skills', '.agents/skills', '.ploinky/repos/research-pack/achilles-skills']) {
            writeSkill(path.join(workspaceRoot, relative));
        }
        assert.deepEqual(resolveRoots(workspaceRoot), [{ path: builtInSkillsDir, builtIn: true }]);
    });

    it('deduplicates explicit roots while retaining their external classification and order', () => {
        const workspaceRoot = fixture();
        const root = path.join(workspaceRoot, 'selected');
        writeSkill(root);
        assert.deepEqual(resolveRoots(workspaceRoot, [root, path.join(root, '..', 'selected'), builtInSkillsDir]), [
            { path: builtInSkillsDir, builtIn: true }, { path: root, builtIn: false },
        ]);
    });

    it('uses local marketplace skill repositories and ignores remote, unrelated and empty roots', () => {
        const source = fixture();
        const skills = path.join(source, 'skills');
        const legacy = path.join(source, 'achilles-skills');
        writeSkill(skills);
        writeSkill(legacy);
        const empty = path.join(source, 'empty');
        fs.mkdirSync(path.join(empty, 'skills'), { recursive: true });
        const remote = path.join(source, 'remote');
        const unrelated = path.join(source, 'unrelated');
        writeSkill(path.join(remote, 'skills'));
        writeSkill(path.join(unrelated, 'skills'));
        const workspaceRoot = fixture([
            { source: remote, origin: 'remote', kind: 'skills' },
            { source: unrelated, origin: 'workspace', kind: 'agent' },
            { source: empty, origin: 'workspace', kind: 'skills' },
            { source, origin: 'workspace', kind: 'mixed' },
            { source, origin: 'workspace', kind: 'skills' },
        ]);
        assert.deepEqual(resolveRoots(workspaceRoot, [skills]), [
            { path: builtInSkillsDir, builtIn: true },
            { path: skills, builtIn: false }, { path: legacy, builtIn: false },
        ]);
    });
});
