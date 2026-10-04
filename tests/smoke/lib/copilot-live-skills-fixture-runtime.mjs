// Shipped only to the verified RoboTeam runtime. Actions are finite and confined to one run's paths.
export async function operateLiveSkillsFixture({ action, fixture, workspaceRoot, expectedRepository, contractHashes }, {
    codeRoot = '/code', dataRoot = '/data', service: suppliedService, runGit,
    emit = value => console.log(JSON.stringify(value)),
} = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { pathToFileURL } = await import('node:url');
    const { execFileSync } = await import('node:child_process');
    const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
    assert.ok(['prepare', 'seed-defaults', 'remove-links', 'remove-folders'].includes(action), 'Unknown fixture action.');
    assert.match(fixture.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(path.isAbsolute(workspaceRoot) && path.normalize(workspaceRoot) === workspaceRoot && workspaceRoot !== '/');
    assert.equal(fs.realpathSync(workspaceRoot), workspaceRoot);
    assert.equal(fixture.folder, `copilot-live-skills-${fixture.runId}`);
    assert.equal(fixture.workspace, `${workspaceRoot}/${fixture.folder}`);
    assert.equal(fixture.repositoryName, `copilot-live-source-${fixture.runId}`);
    assert.equal(fixture.repositoryRoot, `${workspaceRoot}/${fixture.repositoryName}`);
    assert.equal(fixture.robotName, `copilot-live-${fixture.runId}`);
    assert.ok(expectedRepository && expectedRepository.startsWith(`${workspaceRoot}/`));
    assert.ok(contractHashes && Object.keys(contractHashes).length > 0);
    for (const [file, digest] of Object.entries(contractHashes)) {
        assert.ok(/^[a-zA-Z0-9/.-]+\.mjs$/.test(file) && !file.split('/').includes('..'));
        const source = `${expectedRepository}/roboTeamAgent/${file}`;
        assert.equal(fs.realpathSync(source), source);
        assert.equal(fs.realpathSync(`${codeRoot}/${file}`), source);
        assert.equal(hash(fs.readFileSync(source)), digest, 'Fixture operation source differs from the verified checkout.');
    }
    const markerName = '.set2-live-fixture_codex.json';
    const ownership = { version: 1, runId: fixture.runId, workspace: fixture.workspace, repositoryRoot: fixture.repositoryRoot, robotName: fixture.robotName };
    function readRegular(file, root, limit = 1024 * 1024) {
        assert.ok(file.startsWith(`${root}/`));
        assert.equal(fs.realpathSync(file), file, 'Fixture metadata must remain canonical.');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(fd);
            assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limit);
            return fs.readFileSync(fd);
        } finally { fs.closeSync(fd); }
    }
    const json = (file, root) => JSON.parse(readRegular(file, root));
    function ownedPaths() {
        for (const root of [fixture.repositoryRoot, fixture.workspace]) {
            assert.equal(fs.realpathSync(root), root, 'Owned fixture folder was replaced.');
            assert.ok(fs.lstatSync(root).isDirectory());
            assert.deepEqual(json(`${root}/${markerName}`, root), ownership, 'Fixture ownership marker differs.');
        }
    }
    function quiescent() {
        const directory = `${fixture.workspace}/.roboteam/sessions`;
        if (!fs.existsSync(directory)) return;
        assert.equal(fs.realpathSync(directory), directory);
        for (const name of fs.readdirSync(directory)) {
            assert.match(name, /^[a-f0-9-]{36}\.json$/);
            const session = json(`${directory}/${name}`, fixture.workspace);
            assert.notEqual(session.skillExecution?.active, true, 'Fixture has active execution.');
            assert.ok(!(session.turns || []).some(turn => !turn.status || turn.status === 'pending'), 'Fixture has unfinished native turns.');
        }
    }
    if (action === 'prepare') {
        assert.equal(fixture.robotId, null, 'Prepare before creating the owned robot.');
        for (const root of [fixture.repositoryRoot, fixture.workspace]) assert.equal(fs.lstatSync(root, { throwIfNoEntry: false }), undefined, 'Fixture path already exists.');
        const git = runGit || ((args) => execFileSync('git', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }));
        assert.match(git(['--version']), /^git version /);
        for (const root of [fixture.repositoryRoot, fixture.workspace]) {
            fs.mkdirSync(root, { mode: 0o700 });
            fs.writeFileSync(`${root}/${markerName}`, JSON.stringify(ownership) + '\n', { flag: 'wx', mode: 0o600 });
        }
        git(['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', '--template=', '--initial-branch=set2-fixture', '--', fixture.repositoryRoot]);
        assert.equal(git(['-C', fixture.repositoryRoot, 'rev-parse', '--show-toplevel']).trim(), fixture.repositoryRoot);
        fs.mkdirSync(`${fixture.workspace}/.receipts`, { mode: 0o700 });
        return emit({ ownership, git: { root: fixture.repositoryRoot, committed: false }, prepared: true });
    }
    ownedPaths();
    if (action === 'remove-folders') {
        quiescent();
        if (fixture.robotId) assert.equal(fs.lstatSync(`${dataRoot}/robots/${fixture.robotId}/metadata.json`, { throwIfNoEntry: false }), undefined,
            'Delete the owned robot before removing its folders.');
        const projectFile = `${dataRoot}/projects/${hash(fixture.workspace)}.json`;
        if (fs.existsSync(projectFile)) {
            assert.deepEqual(json(projectFile, dataRoot), { cwd: fixture.workspace }, 'Owned project registry reference changed.');
            fs.unlinkSync(projectFile);
        }
        for (const root of [fixture.workspace, fixture.repositoryRoot]) fs.rmSync(root, { recursive: true });
        return emit({ removed: [fixture.workspace, fixture.repositoryRoot] });
    }
    assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
    const robotRoot = `${dataRoot}/robots/${fixture.robotId}`;
    assert.equal(fs.realpathSync(robotRoot), robotRoot, 'Owned robot storage must remain canonical.');
    let service = suppliedService;
    if (!service) {
        const { RobotStore } = await import(pathToFileURL(`${codeRoot}/server/robot-store.mjs`).href);
        const { RobotSkillsets } = await import(pathToFileURL(`${codeRoot}/server/robot-skillsets.mjs`).href);
        const robotStore = new RobotStore({ dataDir: dataRoot });
        service = new RobotSkillsets({ robotStore, workspaceRoot });
    }
    const robot = await service.robotStore.get(fixture.robotId);
    assert.equal(robot?.id, fixture.robotId);
    assert.equal(robot.name, fixture.robotName);
    assert.deepEqual(robot.codingAgents, ['codex'], 'The owned robot must be Codex-only.');
    const registered = (robot.skillsets || []).filter(repo => repo.name === fixture.repositoryName);
    if (action === 'seed-defaults') {
        assert.equal(registered.length, 1);
        assert.equal(registered[0].source, fixture.repositoryRoot);
        assert.match(registered[0].generation, /^[a-f0-9-]{36}$/);
        assert.equal(await service.policies.scope(), workspaceRoot, 'Fixture source and execution require the admitted workspace scope.');
        const policyId = `defaults-${hash(JSON.stringify(workspaceRoot))}`;
        const directory = service.policies.directory(robot.id);
        if (fs.existsSync(directory)) {
            assert.equal(fs.realpathSync(directory), directory);
            assert.deepEqual(fs.readdirSync(directory), [], 'Refuse an existing owned robot policy.');
        }
        assert.equal(await service.policies.read(robot.id, policyId), null, 'Refuse an existing owned defaults policy.');
        const policy = await service.policies.ensure(robot, policyId, { input: { skillSets: [fixture.repositoryName], skills: [] }, useDefaults: false });
        assert.equal(policy.mode, 'live');
        assert.deepEqual(policy.selectors, { skillSets: [fixture.repositoryName], skills: [] });
        assert.deepEqual(policy.bindings[fixture.repositoryName], { source: fixture.repositoryRoot, generation: registered[0].generation });
        assert.deepEqual(policy.excludedSkills, []);
        assert.equal(policy.policyVersion, 1);
        return emit({ robotId: robot.id, source: registered[0].source, generation: registered[0].generation,
            policyId, policyVersion: policy.policyVersion, policySha256: hash(policy), seeded: true });
    }
    quiescent();
    // Remove links only while registration still proves their original run-owned source.
    assert.equal(registered.length, 1);
    assert.equal(registered[0].source, fixture.repositoryRoot);
    const file = `${fixture.workspace}/.agents/.roboteam-links.json`;
    const links = fs.existsSync(file) ? json(file, fixture.workspace) : [];
    assert.ok(Array.isArray(links));
    for (const link of links) {
        assert.equal(path.dirname(link.destination), `${fixture.workspace}/.agents/skills`);
        assert.ok(fs.lstatSync(link.destination).isSymbolicLink());
        assert.equal(fs.readlinkSync(link.destination), link.linkTarget, 'Owned link was retargeted.');
    }
    const client = service.repositoriesClient || await (await import(pathToFileURL(`${codeRoot}/server/repository-client.mjs`).href)).repositoryClient();
    const result = links.length ? await client.remove(links.map(link => link.destination)) : { conflicts: [] };
    assert.deepEqual(result.conflicts, [], 'Owned skill removal conflicts with existing files.');
    return emit({ removedLinks: links.map(link => link.destination) });
}
