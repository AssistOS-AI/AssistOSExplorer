import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installLiveSkills } from '../server/live-skill-install.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { alaSkillMountArguments } from '../copilot/src/lib/execution/alaSkillMounts.mjs';

// Use the same linked installation as production, including non-sibling checkouts.
const { packageRoot } = await resolveAlaInstallation();
const loadAla = file => import(pathToFileURL(path.join(packageRoot, 'src', file)).href);
const { runProcess } = await loadAla('coding-agents/process.mjs');
const { canStartBubblewrap, canMountPrivateProc } = await loadAla('coding-agents/sandbox.mjs');
const { parseArguments } = await loadAla('arguments.mjs');
const { resolveFolderMounts } = await loadAla('coding-agents/folders.mjs');
const { ignoredMountTargets } = await loadAla('coding-agents/ignored-paths.mjs');

async function fixture(t, { projectSkills = true } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-session-skills-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project');
    const local = path.join(cwd, '.agents/skills/local');
    await fs.mkdir(cwd, { recursive: true });
    if (projectSkills) {
        await fs.mkdir(local, { recursive: true });
        await fs.writeFile(path.join(local, 'SKILL.md'), 'project skill');
    }
    const sources = await Promise.all(['first', 'second'].map(async name => {
        const source = path.join(root, name, 'skills/example');
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, 'SKILL.md'), name);
        return source;
    }));
    const entries = sources.map(sourcePath => [{ name: 'example', sourcePath, enabled: true }]);
    const client = { listRepositories: async () => [], install: () => { throw new Error('Shared links must not be installed'); } };
    const input = index => ({ sessionId: randomUUID(), cwd, client, robot: { id: `robot-${index}` }, policyId: `policy-${index}`,
        service: { workspaceRoot: root, policies: { read: async () => ({ mode: 'live', policyVersion: 1 }) },
            live: { resolve: async () => ({ entries: entries[index], diagnostics: [] }) } } });
    return { root, cwd, local, sources, entries, input };
}

test('concurrent robot sessions publish separate links and preserve the working folder', async t => {
    const { cwd, local, sources, entries, input } = await fixture(t);
    const first = input(0), second = input(1);
    const [a, b] = await Promise.all([installLiveSkills(first), installLiveSkills(second)]);
    assert.notEqual(a.skillsDirectory, b.skillsDirectory);
    assert.equal(a.skillsDirectory, path.join(cwd, '.roboteam/sessions', first.sessionId, 'skills'));
    assert.equal(await fs.readFile(path.join(a.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(b.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'second');
    assert.equal(await fs.readlink(path.join(a.skillsDirectory, 'example')), sources[0]);
    assert.ok(a.mounts.some(mount => mount.source === local));
    assert.deepEqual(await fs.readdir(path.join(cwd, '.agents/skills')), ['local']);
    await assert.rejects(fs.lstat(path.join(cwd, '.agents/.roboteam-links.json')), { code: 'ENOENT' });
    entries[0] = [];
    await installLiveSkills(first);
    assert.deepEqual(await fs.readdir(a.skillsDirectory), ['local']);
    assert.equal(await fs.readFile(path.join(b.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'second');
    assert.equal(await fs.readFile(path.join(local, 'SKILL.md'), 'utf8'), 'project skill');
});

test('robot selection overrides a project name only in its session, including non-repository sources', async t => {
    const { cwd, input } = await fixture(t);
    await fs.mkdir(path.join(cwd, '.agents/skills/example'));
    await fs.writeFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'project example');
    const prepared = await installLiveSkills(input(0));
    assert.equal(await fs.readFile(path.join(prepared.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'utf8'), 'project example');
});

test('bundled skills resolve to the workspace checkout', async t => {
    const { copilotSkillsRoot } = await import('../server/copilot-skillset.mjs');
    const { root, input, entries } = await fixture(t);
    const source = path.join(root, 'AchillesCLI');
    const skill = path.join(source, 'roboTeamAgent/copilot/src/skills/bash');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'current bundled skill');
    entries[0] = [{ builtin: true, name: 'bash', enabled: true, owner: await fs.realpath(copilotSkillsRoot),
        sourcePath: path.join(copilotSkillsRoot, 'bash') }];
    const request = input(0);
    request.client.listRepositories = async () => [{ name: 'AchillesCLI', source, origin: 'workspace' }];
    const prepared = await installLiveSkills(request);
    assert.equal(await fs.readFile(path.join(prepared.skillsDirectory, 'bash/SKILL.md'), 'utf8'), 'current bundled skill');
});

test('RoboTeam arguments use the real ALA parser and avoid redundant human-report mounts', async t => {
    const { root, cwd, input, entries } = await fixture(t);
    const humanReport = path.join(root, 'DocumentationSkills/skills/human-report');
    await fs.mkdir(humanReport, { recursive: true });
    await fs.writeFile(path.join(humanReport, 'SKILL.md'), 'required report');
    entries[0].push({ name: 'human-report', sourcePath: humanReport, enabled: true });
    const snapshot = await installLiveSkills(input(0));
    const args = ['--folder', root, ...alaSkillMountArguments({ snapshot, workspaceRoot: root, cwd }),
        '--ignore', path.join(cwd, '.roboteam')];
    assert.ok(!args.includes(humanReport), 'Read-only workspace already exposes human-report');
    const options = parseArguments(args);
    assert.deepEqual(options.instructionParts, []);
    const mounts = resolveFolderMounts(options.folders);
    assert.deepEqual(ignoredMountTargets(options.ignoredPaths,
        [{ source: cwd, target: cwd }, ...mounts], cwd), [path.join(cwd, '.roboteam')]);
    assert.ok(mounts.some(mount => mount.target.startsWith('/workspace/roboteam-skill-')),
        'Project skills retain their read-only relocated source');
    const aliased = alaSkillMountArguments({ snapshot, workspaceRoot: root, cwd, includeClaude: false });
    assert.ok(!aliased.includes(path.join(cwd, '.claude/skills')));
    const sameRoot = alaSkillMountArguments({ snapshot, workspaceRoot: cwd, cwd });
    assert.ok(sameRoot.includes(humanReport), 'Without a read-only parent, retain the source bind');
});

test('two Bubblewrap processes see their own skills while private configuration stays hidden', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const { root, cwd, input } = await fixture(t);
    const snapshots = await Promise.all([installLiveSkills(input(0)), installLiveSkills(input(1))]);
    await fs.writeFile(path.join(cwd, '.roboteam', 'secret.json'), 'private');
    const results = await Promise.all(snapshots.map(async snapshot => {
        const options = parseArguments(['--folder', root,
            ...alaSkillMountArguments({ snapshot, workspaceRoot: root, cwd })]);
        const folders = options.folders;
        return runProcess({ binary: process.execPath, cwd, args: ['-e', `
            const fs = require('node:fs');
            const read = name => fs.readFileSync('.agents/skills/' + name + '/SKILL.md', 'utf8');
            let writable = false;
            try { fs.writeFileSync('.agents/skills/local/SKILL.md', 'changed'); writable = true; } catch {}
            process.stdout.write(JSON.stringify({ example: read('example'), local: read('local'), writable,
                claude: fs.readFileSync('.claude/skills/example/SKILL.md', 'utf8'),
                privateFiles: fs.readdirSync('.roboteam'),
                sourceWritable: (() => { try { fs.writeFileSync(${JSON.stringify(path.join(root, 'first/skills/example'))}
                    + '/new', 'x'); return true; } catch { return false; } })() }));
        `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd, folders,
            ignoredPaths: [path.join(cwd, '.roboteam')] } });
    }));
    for (const [index, result] of results.entries()) {
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { example: index ? 'second' : 'first',
            local: 'project skill', claude: index ? 'second' : 'first', writable: false, privateFiles: [],
            sourceWritable: false });
    }
    assert.deepEqual(await fs.readdir(path.join(cwd, '.agents/skills')), ['local']);
    assert.equal(await fs.readFile(path.join(cwd, '.roboteam/secret.json'), 'utf8'), 'private');
});

test('generation in a fresh working folder exposes human-report with the real sandbox', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const { root, cwd, input, entries } = await fixture(t, { projectSkills: false });
    const source = path.join(root, 'DocumentationSkills/skills/human-report');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), 'required report');
    entries[0].push({ name: 'human-report', sourcePath: source, enabled: true });
    const snapshot = await installLiveSkills(input(0));
    const options = parseArguments(['--folder', root,
        ...alaSkillMountArguments({ snapshot, workspaceRoot: root, cwd })]);
    const result = await runProcess({ binary: process.execPath, cwd, args: ['-e', `
        const fs = require('node:fs');
        process.stdout.write(JSON.stringify({
            report: fs.readFileSync('.agents/skills/human-report/SKILL.md', 'utf8'),
            claude: fs.readFileSync('.claude/skills/human-report/SKILL.md', 'utf8'),
            privateFiles: fs.readdirSync('.roboteam')
        }));
    `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd,
        folders: options.folders, ignoredPaths: [path.join(cwd, '.roboteam')] } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        report: 'required report', claude: 'required report', privateFiles: []
    });
});

test('an existing Claude symlink sees the same session overlay without a duplicate bind', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const { root, cwd, input } = await fixture(t);
    await fs.symlink('.agents', path.join(cwd, '.claude'));
    const snapshot = await installLiveSkills(input(0));
    const options = parseArguments(['--folder', root,
        ...alaSkillMountArguments({ snapshot, workspaceRoot: root, cwd, includeClaude: false })]);
    const result = await runProcess({ binary: process.execPath, cwd, args: ['-e', `
        const fs = require('node:fs');
        process.stdout.write(fs.readFileSync('.claude/skills/example/SKILL.md', 'utf8'));
    `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd,
        folders: options.folders, ignoredPaths: [path.join(cwd, '.roboteam')] } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'first');
    assert.equal(await fs.readlink(path.join(cwd, '.claude')), '.agents');
});
