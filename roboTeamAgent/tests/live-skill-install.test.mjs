import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installLiveSkills } from '../server/live-skill-install.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { alaSkillMountArguments, skillOverlayTargets } from '../copilot/src/lib/execution/alaSkillMounts.mjs';

// Use the same linked installation as production, including non-sibling checkouts.
const { packageRoot } = await resolveAlaInstallation();
const loadAla = file => import(pathToFileURL(path.join(packageRoot, 'src', file)).href);
const { runProcess } = await loadAla('coding-agents/process.mjs');
const { canStartBubblewrap, canMountPrivateProc } = await loadAla('coding-agents/sandbox.mjs');
const { parseArguments } = await loadAla('arguments.mjs');
const { pinDirectory, pinFolderMounts, resolveFolderMounts } = await loadAla('coding-agents/folders.mjs');
const { ignoredMountTargets } = await loadAla('coding-agents/ignored-paths.mjs');

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

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

// A skill link names its sandbox mount target; the mount supplies the source the sandbox shows there.
async function viewed(snapshot, name, file = 'SKILL.md') {
    const target = await fs.readlink(path.join(snapshot.skillsDirectory, name));
    const mount = snapshot.mounts.find(entry => entry.target === target);
    assert.ok(mount, `Skill link ${name} has no mount for ${target}`);
    return fs.readFile(path.join(mount.source, file), 'utf8');
}

test('concurrent robot sessions publish separate links and preserve the working folder', async t => {
    const { cwd, local, sources, entries, input } = await fixture(t);
    const first = input(0), second = input(1);
    const [a, b] = await Promise.all([installLiveSkills(first), installLiveSkills(second)]);
    assert.notEqual(a.skillsDirectory, b.skillsDirectory);
    assert.equal(a.skillsDirectory, path.join(cwd, '.roboteam/sessions', first.sessionId, 'skills'));
    assert.equal(await viewed(a, 'example'), 'first');
    assert.equal(await viewed(b, 'example'), 'second');
    assert.equal(await fs.readlink(path.join(a.skillsDirectory, 'example')), a.mounts.find(mount => mount.source === sources[0]).target);
    assert.ok(a.mounts.some(mount => mount.source === local));
    assert.deepEqual(await fs.readdir(path.join(cwd, '.agents/skills')), ['local']);
    await assert.rejects(fs.lstat(path.join(cwd, '.agents/.roboteam-links.json')), { code: 'ENOENT' });
    entries[0] = [];
    await installLiveSkills(first);
    assert.deepEqual(await fs.readdir(a.skillsDirectory), ['local']);
    assert.equal(await viewed(b, 'example'), 'second');
    assert.equal(await fs.readFile(path.join(local, 'SKILL.md'), 'utf8'), 'project skill');
});

test('robot selection overrides a project name only in its session, including non-repository sources', async t => {
    const { cwd, input } = await fixture(t);
    await fs.mkdir(path.join(cwd, '.agents/skills/example'));
    await fs.writeFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'project example');
    const prepared = await installLiveSkills(input(0));
    assert.equal(await viewed(prepared, 'example'), 'first');
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'utf8'), 'project example');
});

test('project skill links that leave the working folder are dropped with a diagnostic', async t => {
    const { root, cwd, local, input } = await fixture(t);
    const inner = path.join(cwd, 'tools/inner');
    await fs.mkdir(inner, { recursive: true });
    const targets = { sibling: path.join(root, 'sibling'), ploinky: path.join(root, '.ploinky'), data: path.join(root, '.data/x'),
        self: cwd, session: path.join(cwd, '.roboteam/sessions/other'), private: path.join(cwd, '.roboteam') };
    for (const target of Object.values(targets).filter(target => target !== cwd && target !== path.join(cwd, '.roboteam'))) await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(cwd, '.roboteam'), { recursive: true });
    for (const [name, target] of Object.entries(targets)) await fs.symlink(target, path.join(cwd, '.agents/skills', name), 'dir');
    await fs.symlink(inner, path.join(cwd, '.agents/skills/inner'), 'dir');
    const prepared = await installLiveSkills(input(0));
    const names = await fs.readdir(prepared.skillsDirectory);
    assert.deepEqual(names.sort(), ['example', 'inner', 'local']);
    for (const name of Object.keys(targets)) {
        assert.ok(!names.includes(name), `Escaping link was published: ${name}`);
        assert.ok(prepared.diagnostics.some(item => item.source === name && item.state === 'invalid'
            && item.message === 'Project skill link leaves the working folder'), `Missing diagnostic: ${name}`);
    }
    const mounted = prepared.mounts.map(mount => mount.source);
    assert.deepEqual(mounted.filter(source => !inside(cwd, source) && !source.endsWith('/skills/example')), []);
    assert.ok(!mounted.includes(cwd) && !mounted.some(source => source.startsWith(path.join(cwd, '.roboteam'))));
    assert.ok(mounted.includes(inner) && mounted.includes(local));
});

test('project skill links that lead nowhere are skipped with a diagnostic and never stop the turn', async t => {
    const { cwd, local, input } = await fixture(t);
    const skills = path.dirname(local);
    await fs.symlink(path.join(cwd, 'missing'), path.join(skills, 'dangling'));
    await fs.writeFile(path.join(cwd, 'plain-file'), 'not a directory');
    await fs.symlink(path.join(cwd, 'plain-file', 'child'), path.join(skills, 'through-file'));
    await fs.symlink(path.join(skills, 'looping'), path.join(skills, 'looping'));
    const snapshot = await installLiveSkills(input(0));
    assert.deepEqual(snapshot.diagnostics.map(entry => entry.source).sort(), ['dangling', 'looping', 'through-file']);
    for (const entry of snapshot.diagnostics) {
        assert.equal(entry.state, 'invalid'); assert.equal(entry.message, 'Project skill link cannot be resolved');
    }
    const installed = await fs.readdir(snapshot.skillsDirectory);
    assert.ok(installed.includes('local'));
    for (const name of ['dangling', 'looping', 'through-file']) assert.ok(!installed.includes(name), name);
});

test('a project skills path that is not a directory leaves the session with no project skills', async t => {
    const { cwd, input } = await fixture(t, { projectSkills: false });
    await fs.mkdir(path.join(cwd, '.agents'));
    await fs.writeFile(path.join(cwd, '.agents', 'skills'), 'not a directory');
    assert.ok(await installLiveSkills(input(0)));
    await fs.rm(path.join(cwd, '.agents', 'skills'));
    await fs.symlink(path.join(cwd, '.agents', 'skills'), path.join(cwd, '.agents', 'skills'));
    assert.ok(await installLiveSkills(input(1)));
});

async function overlayLayouts(cwd) {
    const agents = path.join(cwd, '.agents/skills'), claude = path.join(cwd, '.claude/skills'), shared = path.join(cwd, 'shared'), outside = path.join(path.dirname(cwd), 'outside');
    return [
        ['plain project', async () => {}, [agents, claude], []],
        ['.claude/skills -> ../.agents/skills', async () => { await fs.mkdir(agents, { recursive: true }); await fs.mkdir(path.dirname(claude)); await fs.symlink('../.agents/skills', claude); }, [agents], []],
        ['.claude -> .agents', async () => { await fs.mkdir(path.dirname(agents)); await fs.symlink('.agents', path.join(cwd, '.claude')); }, [agents], []],
        ['.agents/skills -> ../shared', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(shared); await fs.symlink('../shared', agents); }, [shared, claude], []],
        ['.agents -> shared', async () => { await fs.mkdir(path.join(shared, 'skills'), { recursive: true }); await fs.symlink('shared', path.join(cwd, '.agents')); }, [path.join(shared, 'skills'), claude], []],
        ['link leaving the folder', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(outside, { recursive: true }); await fs.symlink(outside, agents); }, [claude], ['.agents/skills']],
        ['link into private data', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(path.join(cwd, '.roboteam/x'), { recursive: true }); await fs.symlink('../.roboteam/x', agents); }, [claude], ['.agents/skills']],
        ['dangling link', async () => { await fs.mkdir(path.dirname(claude)); await fs.symlink('missing', claude); }, [agents], ['.claude/skills']],
        ['looping link', async () => { await fs.mkdir(path.dirname(claude)); await fs.symlink('skills', claude); }, [agents], ['.claude/skills']],
        ['file in the way', async () => { await fs.writeFile(path.join(cwd, '.claude'), 'x'); }, [agents], ['.claude/skills']],
        ['.agents/skills -> ../.claude, a real .claude', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(path.dirname(claude)); await fs.symlink('../.claude', agents); }, [claude], ['.agents/skills']],
        ['.claude/skills -> ../.agents, a real .agents', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(path.dirname(claude)); await fs.symlink('../.agents', claude); }, [agents], ['.claude/skills']],
        ['.agents/skills -> ../a, .claude/skills -> ../a/b', async () => { await fs.mkdir(path.dirname(agents)); await fs.mkdir(path.dirname(claude)); await fs.mkdir(path.join(cwd, 'a/b'), { recursive: true }); await fs.symlink('../a', agents); await fs.symlink('../a/b', claude); }, [path.join(cwd, 'a/b')], ['.agents/skills']],
        ['file at the target', async () => { await fs.mkdir(path.dirname(claude)); await fs.writeFile(claude, 'x'); }, [agents], ['.claude/skills']],
    ];
}

test('the session skills overlay decides before mounting: follow a link inside the folder, one mount per place, skip the rest', async t => {
    const probe = await fixture(t, { projectSkills: false });
    for (const [label] of await overlayLayouts(probe.cwd)) {
        const { cwd } = await fixture(t, { projectSkills: false });
        const [, setup, targets, skipped] = (await overlayLayouts(cwd)).find(([name]) => name === label);
        await setup();
        assert.deepEqual(await skillOverlayTargets(cwd), { targets, skipped }, label);
    }
});

test('every link layout runs with the session skills on real descriptor binds and a robot cannot stop the turn', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const probe = await fixture(t, { projectSkills: false });
    for (const [label] of await overlayLayouts(probe.cwd)) {
        const { cwd, input } = await fixture(t, { projectSkills: false });
        const [, setup] = (await overlayLayouts(cwd)).find(([name]) => name === label);
        await setup();
        const snapshot = await installLiveSkills(input(0));
        const { targets } = await skillOverlayTargets(cwd);
        const options = parseArguments(alaSkillMountArguments({ snapshot, cwd, targets }));
        const folders = pinFolderMounts(options.folders);
        const pin = pinDirectory(cwd);
        const result = await runProcess({ binary: process.execPath, cwd, args: ['-e', `
            const fs = require('node:fs');
            process.stdout.write(JSON.stringify(process.argv.slice(1).map(target => fs.readFileSync(target + '/example/SKILL.md', 'utf8'))));
        `, ...targets], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceFd: pin.fd, workspaceTarget: cwd,
            folders, ignoredPaths: [path.join(cwd, '.roboteam')] } });
        assert.equal(result.code, 0, `${label}: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), targets.map(() => 'first'), label);
    }
});

test('an invalid old skill installation record is ignored and never stops the turn', async t => {
    const { cwd, input } = await fixture(t);
    await fs.writeFile(path.join(cwd, '.agents/.roboteam-links.json'), '{ not json');
    assert.ok((await fs.readdir((await installLiveSkills(input(0))).skillsDirectory)).includes('local'));
    await fs.rm(path.join(cwd, '.agents/.roboteam-links.json'));
    await fs.mkdir(path.join(cwd, '.agents/.roboteam-links.json'));
    assert.ok(await installLiveSkills(input(1)));
});

test('bundled skills resolve to the workspace checkout', async t => {
    const { copilotSkillsRoot } = await import('../server/copilot-skillset.mjs');
    const { root, input, entries } = await fixture(t);
    const source = path.join(root, 'AchillesIDE');
    const skill = path.join(source, 'roboTeamAgent/copilot/src/skills/bash');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'current bundled skill');
    entries[0] = [{ builtin: true, name: 'bash', enabled: true, owner: await fs.realpath(copilotSkillsRoot),
        sourcePath: path.join(copilotSkillsRoot, 'bash') }];
    const request = input(0);
    request.client.listRepositories = async () => [{ name: 'AchillesIDE', source, origin: 'workspace' }];
    const prepared = await installLiveSkills(request);
    assert.equal(await viewed(prepared, 'bash'), 'current bundled skill');
});

test('RoboTeam arguments use the real ALA parser and mount every skill source, wherever it sits in the workspace', async t => {
    const { root, cwd, input, entries } = await fixture(t);
    const humanReport = path.join(root, 'DocumentationSkills/skills/human-report');
    await fs.mkdir(humanReport, { recursive: true });
    await fs.writeFile(path.join(humanReport, 'SKILL.md'), 'required report');
    entries[0].push({ name: 'human-report', sourcePath: humanReport, enabled: true });
    const snapshot = await installLiveSkills(input(0));
    const skillArguments = alaSkillMountArguments({ snapshot, cwd });
    const args = [...skillArguments, '--ignore', path.join(cwd, '.roboteam')];
    // No workspace folder is passed, so a source inside the workspace is reachable only through its own mount.
    assert.ok(!args.includes(root));
    for (const mount of snapshot.mounts) {
        const index = args.findIndex((value, at) => value === mount.source && args[at - 1] === '--folder');
        assert.notEqual(index, -1, `Skill source is not mounted: ${mount.source}`);
        assert.deepEqual(args.slice(index + 1, index + 3), ['at', mount.target]);
        assert.equal(args[index + 3], 'expose');
    }
    assert.ok(args.includes(humanReport), 'human-report is mounted like every other source');
    const options = parseArguments(args);
    assert.deepEqual(options.instructionParts, []);
    const mounts = resolveFolderMounts(options.folders);
    assert.deepEqual(ignoredMountTargets(options.ignoredPaths,
        [{ source: cwd, target: cwd }, ...mounts], cwd), [path.join(cwd, '.roboteam')]);
    assert.ok(mounts.some(mount => mount.target.startsWith('/workspace/roboteam-skill-')),
        'Project skills retain their read-only relocated source');
    const aliased = alaSkillMountArguments({ snapshot, cwd, targets: [path.join(cwd, '.agents/skills')] });
    assert.ok(!aliased.includes(path.join(cwd, '.claude/skills')));
    // A source that would sit at its own path inside a former workspace view is still mounted.
    const sameRoot = alaSkillMountArguments({ snapshot: { ...snapshot, mounts: [{ source: humanReport, target: humanReport }] }, workspaceRoot: root, cwd });
    assert.ok(sameRoot.some((value, at) => value === humanReport && sameRoot[at - 1] === '--folder' && sameRoot[at + 1] === 'at'));
});

test('two Bubblewrap processes see their own skills while private configuration stays hidden', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const { root, cwd, input } = await fixture(t);
    const snapshots = await Promise.all([installLiveSkills(input(0)), installLiveSkills(input(1))]);
    await fs.writeFile(path.join(cwd, '.roboteam', 'secret.json'), 'private');
    const results = await Promise.all(snapshots.map(async (snapshot, index) => {
        const options = parseArguments(alaSkillMountArguments({ snapshot, cwd }));
        const folders = options.folders;
        const target = snapshot.mounts.find(mount => mount.source === path.join(root, index ? 'second' : 'first', 'skills/example')).target;
        return runProcess({ binary: process.execPath, cwd, args: ['-e', `
            const fs = require('node:fs');
            const read = name => fs.readFileSync('.agents/skills/' + name + '/SKILL.md', 'utf8');
            let writable = false;
            try { fs.writeFileSync('.agents/skills/local/SKILL.md', 'changed'); writable = true; } catch {}
            process.stdout.write(JSON.stringify({ example: read('example'), local: read('local'), writable,
                claude: fs.readFileSync('.claude/skills/example/SKILL.md', 'utf8'),
                privateFiles: fs.readdirSync('.roboteam'),
                sourceWritable: (() => { try { fs.writeFileSync(${JSON.stringify(target)} + '/new', 'x'); return true; } catch { return false; } })(),
                workspaceSourcesVisible: ['first', 'second'].some(name => fs.existsSync(${JSON.stringify(root)} + '/' + name)) }));
        `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd, folders,
            ignoredPaths: [path.join(cwd, '.roboteam')] } });
    }));
    for (const [index, result] of results.entries()) {
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { example: index ? 'second' : 'first',
            local: 'project skill', claude: index ? 'second' : 'first', writable: false, privateFiles: [],
            sourceWritable: false, workspaceSourcesVisible: false });
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
    const options = parseArguments(alaSkillMountArguments({ snapshot, cwd }));
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
    const options = parseArguments(alaSkillMountArguments({ snapshot, cwd, targets: (await skillOverlayTargets(cwd)).targets }));
    const result = await runProcess({ binary: process.execPath, cwd, args: ['-e', `
        const fs = require('node:fs');
        process.stdout.write(fs.readFileSync('.claude/skills/example/SKILL.md', 'utf8'));
    `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd,
        folders: options.folders, ignoredPaths: [path.join(cwd, '.roboteam')] } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'first');
    assert.equal(await fs.readlink(path.join(cwd, '.claude')), '.agents');
});
