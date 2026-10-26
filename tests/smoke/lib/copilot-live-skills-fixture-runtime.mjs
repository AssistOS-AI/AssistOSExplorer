import { inspectSessionSkillLinks } from './copilot-live-skills.mjs';
// A cycle with the runtime module, which ships this function; only the function binding is used, at call time.
import { readLiveSkillsCodeHashes } from './copilot-live-skills-runtime.mjs';

// Shipped only to the verified RoboTeam runtime. Actions are finite and confined to one run's paths.
// `fsApi` reaches only the contract-hash read; offline tests use it to model a bind mount and macOS's missing /proc.
// `recovery: true` (remove-folders only) is the C5 recovery of a crashed run: see the recovery branch below. `procRoot` is a test seam.
export async function operateLiveSkillsFixture({ action, fixture, workspaceRoot, expectedRepository, contractHashes, recovery = false }, {
    codeRoot = '/code', dataRoot = '/data', procRoot = '/proc', service: suppliedService, runGit, fsApi,
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
    assert.ok(recovery === false || (recovery === true && action === 'remove-folders'), 'Only remove-folders has a recovery mode.');
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
    // Ploinky binds /code directly from the verified source, so /code is the same directory object under another name and a
    // realpath comparison cannot hold. The contract is checked by descriptor identity (dev/ino) and the bytes read through /code.
    assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles: Object.keys(contractHashes) }, { codeRoot, fsApi }),
        contractHashes, 'Fixture operation source differs from the verified checkout.');
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
    async function quiescent() {
        const project = `${fixture.workspace}/.agents`;
        if (fs.lstatSync(project, { throwIfNoEntry: false })) {
            assert.ok(fs.lstatSync(project).isDirectory());
            assert.equal(fs.realpathSync(project), project);
            assert.equal(fs.lstatSync(`${project}/.roboteam-links.json`, { throwIfNoEntry: false }), undefined, 'Legacy shared links are not owned session skills.');
            if (fs.lstatSync(`${project}/skills`, { throwIfNoEntry: false })) {
                assert.ok(fs.lstatSync(`${project}/skills`).isDirectory());
                assert.equal(fs.realpathSync(`${project}/skills`), `${project}/skills`);
                assert.deepEqual(fs.readdirSync(`${project}/skills`), [], 'Fixture project skills must remain empty.');
            }
        }
        const directory = `${fixture.workspace}/.roboteam/sessions`;
        const targets = [];
        if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return targets;
        assert.equal(fs.realpathSync(directory), directory);
        const names = fs.readdirSync(directory).sort(), directoryStat = fs.lstatSync(directory);
        for (const name of names) {
            assert.match(name, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            assert.ok(fs.lstatSync(`${directory}/${name}`).isDirectory());
            assert.equal(fs.realpathSync(`${directory}/${name}`), `${directory}/${name}`);
            const file = `${directory}/${name}/config.json`, before = readRegular(file, fixture.workspace);
            const session = JSON.parse(before);
            assert.equal(session.version, 2);
            assert.equal(session.sessionId, name);
            assert.equal(session.cwd, fixture.workspace);
            if (session.engine) assert.equal(session.engine.robotId, fixture.robotId, 'Session belongs to another robot.');
            assert.notEqual(session.skillExecution?.active, true, 'Fixture has active execution.');
            assert.ok(!(session.turns || []).some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status)), 'Fixture has unfinished native turns.');
            const installed = session.skillExecution
                ? await inspectSessionSkillLinks({ workspace: fixture.workspace, sessionId: name, execution: session.skillExecution }, { allowMissing: true }) : null;
            if (!installed) assert.equal(fs.lstatSync(`${directory}/${name}/skills`, { throwIfNoEntry: false }), undefined, 'Unowned session skills directory.');
            targets.push({ installed, recheck: () => {
                assert.equal(fs.realpathSync(directory), directory);
                const current = fs.lstatSync(directory);
                assert.ok(current.dev === directoryStat.dev && current.ino === directoryStat.ino, 'Session directory changed before cleanup.');
                assert.deepEqual(fs.readdirSync(directory).sort(), names, 'Session membership changed before cleanup.');
                assert.equal(hash(readRegular(file, fixture.workspace)), hash(before), 'Session metadata changed before cleanup.');
                installed?.recheck();
                if (!installed) assert.equal(fs.lstatSync(`${directory}/${name}/skills`, { throwIfNoEntry: false }), undefined, 'Unowned session skills appeared.');
            } });
        }
        // Every target is admitted before any deletion, including later active sessions.
        targets.forEach(target => target.recheck());
        return targets;
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
    if (recovery) {
        // A crashed run can leave unfinished turn records, so native quiescence is proven differently: the owned robot no longer exists
        // (its metadata is absent, by id when known and by name otherwise), and no process in this container has a cwd, or a command line
        // argument, inside either owned root or the robot's storage. Only roots that are present are removed, and each must still carry its
        // ownership marker; a present root without one is refused, which leaves its cleanup to an operator.
        const robots = `${dataRoot}/robots`;
        if (fixture.robotId) {
            assert.match(fixture.robotId, /^[a-z0-9][a-z0-9-]{2,63}$/);
            assert.equal(fs.lstatSync(`${robots}/${fixture.robotId}/metadata.json`, { throwIfNoEntry: false }), undefined, 'Delete the owned robot before recovering its folders.');
        }
        for (const name of fs.existsSync(robots) ? fs.readdirSync(robots) : []) {
            const file = `${robots}/${name}/metadata.json`;
            if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
            let metadata = null;
            try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { metadata = null; }
            assert.notEqual(metadata?.name, fixture.robotName, 'Delete the owned robot before recovering its folders.');
        }
        const watched = [fixture.workspace, fixture.repositoryRoot, ...(fixture.robotId ? [`${robots}/${fixture.robotId}`] : [])];
        const within = value => watched.some(root => value === root || value.startsWith(`${root}/`));
        for (const pid of fs.readdirSync(procRoot).filter(name => /^[0-9]+$/.test(name))) {
            let cwd = null, args = [];
            try { cwd = fs.readlinkSync(`${procRoot}/${pid}/cwd`); } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw new Error('A process cwd cannot be inspected; recovery of the owned folders is refused.');
            }
            try { args = fs.readFileSync(`${procRoot}/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean); } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw new Error('A process command line cannot be inspected; recovery of the owned folders is refused.');
            }
            assert.ok(!within(cwd) && !args.some(arg => within(arg) || watched.some(root => arg.includes(`=${root}`))),
                'A process still uses the owned folders or robot storage; recovery is refused.');
        }
        const present = [fixture.repositoryRoot, fixture.workspace].filter(root => fs.lstatSync(root, { throwIfNoEntry: false }) !== undefined);
        for (const root of present) {
            assert.equal(fs.realpathSync(root), root, 'Owned fixture folder was replaced.');
            assert.ok(fs.lstatSync(root).isDirectory());
            assert.deepEqual(json(`${root}/${markerName}`, root), ownership, 'Fixture ownership marker differs.');
        }
        const projectFile = `${dataRoot}/projects/${hash(fixture.workspace)}.json`;
        if (fs.existsSync(projectFile)) {
            assert.deepEqual(json(projectFile, dataRoot), { cwd: fixture.workspace }, 'Owned project registry reference changed.');
            fs.unlinkSync(projectFile);
        }
        for (const root of present) fs.rmSync(root, { recursive: true });
        return emit({ removed: present, recovery: true });
    }
    ownedPaths();
    if (action === 'remove-folders') {
        const targets = await quiescent();
        if (fixture.robotId) assert.equal(fs.lstatSync(`${dataRoot}/robots/${fixture.robotId}/metadata.json`, { throwIfNoEntry: false }), undefined,
            'Delete the owned robot before removing its folders.');
        const projectFile = `${dataRoot}/projects/${hash(fixture.workspace)}.json`;
        if (fs.existsSync(projectFile)) {
            assert.deepEqual(json(projectFile, dataRoot), { cwd: fixture.workspace }, 'Owned project registry reference changed.');
            targets.forEach(target => target.recheck());
            ownedPaths();
            fs.unlinkSync(projectFile);
        }
        targets.forEach(target => target.recheck());
        ownedPaths();
        for (const root of [fixture.workspace, fixture.repositoryRoot]) fs.rmSync(root, { recursive: true });
        return emit({ removed: [fixture.workspace, fixture.repositoryRoot] });
    }
    assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
    const robotRoot = `${dataRoot}/robots/${fixture.robotId}`;
    assert.equal(fs.realpathSync(robotRoot), robotRoot, 'Owned robot storage must remain canonical.');
    const robotFile = `${robotRoot}/metadata.json`, robotBytes = readRegular(robotFile, robotRoot);
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
    const targets = await quiescent();
    // Remove links only while registration still proves their original run-owned source.
    assert.equal(registered.length, 1);
    assert.equal(registered[0].source, fixture.repositoryRoot);
    targets.forEach(target => target.recheck());
    ownedPaths();
    assert.equal(hash(readRegular(robotFile, robotRoot)), hash(robotBytes), 'Robot registration changed before cleanup.');
    const removedLinks = [];
    for (const target of targets) {
        target.recheck();
        if (!target.installed || target.installed.missing) continue;
        removedLinks.push(...target.installed.links.map(link => `${target.installed.directory}/${link.name}`));
        fs.rmSync(target.installed.directory, { recursive: true });
    }
    return emit({ removedLinks });
}
