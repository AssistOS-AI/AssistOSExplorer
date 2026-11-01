import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LIVE_SKILLS_CONTRACTS, readLiveSkillsCodeHashes, readLiveSkillsHomeBinding } from './copilot-live-skills-runtime.mjs';
import { createLiveSkillsFixture, liveSkillsHash } from './copilot-live-skills.mjs';
const { operateLiveSkillsFixture } = await import(process.env.SMOKE_SOURCE_FIXTURE_MODULE || './copilot-live-skills-fixture-runtime.mjs');

const { createLiveSkillsRuntimeReader } = await import(process.env.SMOKE_SOURCE_READER_MODULE || './copilot-live-skills-runtime.mjs');
const repositorySource = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const moved = ['server/soul-gateway-service.mjs', 'server/soul-gateway-opencode.mjs',
    'server/soul-gateway-connection.mjs', 'server/agent-model-config.mjs', 'server/robot-shell.mjs'];
const homeEvidence = ({ robotId, robotName }) => ({ robotId, robotName, homeTarget: `/home/${robotId}`,
    identity: { dev: '1', ino: '2', uid: '0', gid: '0', mode: '16832' } });

function setup(t, agentName) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source relocation ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesIDE`, source = `${repository}/${agentName}`;
    // Copy only files present under their real owner in this exact checkout. In particular,
    // never synthesize the five retired RoboTeam paths as the older fixture did.
    for (const [owner, files] of Object.entries(LIVE_SKILLS_CONTRACTS)) for (const file of files) {
        const actual = `${repositorySource}/${owner}/${file}`, target = `${repository}/${owner}/${file}`;
        assert.ok(fs.statSync(actual).isFile(), `Missing actual ${owner} source: ${file}`);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(actual, target);
    }
    for (const file of moved) assert.equal(fs.existsSync(`${repository}/roboTeamAgent/${file}`), false);
    const digest = 'a'.repeat(64), startedAt = new Date().toISOString(), boxId = 'b'.repeat(64);
    const objectId = randomUUID(), payloadPath = `${root}/.ploinky/deps/store/objects/${objectId}/payload`;
    fs.mkdirSync(`${payloadPath}/node_modules`, { recursive: true });
    const dataSource = `${root}/.data/${agentName === 'roboWorkAgent' ? '.private/' : ''}${agentName}`;
    const agentSource = `${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`;
    fs.mkdirSync(dataSource, { recursive: true }); fs.mkdirSync(agentSource, { recursive: true });
    const bind = (Source, Destination, RW = true) => ({ Type: 'bind', Source, Destination, RW });
    const runtime = { key: 'owned-runtime', containerId: 'c'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt, imageId: digest, dependencies: { schema: 1, mode: 'store', family: 'container',
            runtimeKey: 'container-linux-x64-glibc-node22', imageId: digest, inputKey: digest, generationId: digest,
            objectId, payloadPath, nodeModulesPath: `${payloadPath}/node_modules` }, mounts: [
            bind(root, root), bind(dataSource, '/data'), bind(source, source), bind(source, '/code', false),
            bind(agentSource, '/Agent', false), bind('/opt/ploinky-agentlib', '/opt/ploinky-agentlib', false),
            bind(`${payloadPath}/node_modules`, '/code/node_modules', false), bind(`${payloadPath}/node_modules`, `${payloadPath}/node_modules`, false),
        ] };
    const otherName = agentName === 'roboTeamAgent' ? 'roboWorkAgent' : 'roboTeamAgent';
    const otherSource = `${repository}/${otherName}`, otherData = `${root}/.data/${otherName === 'roboWorkAgent' ? '.private/' : ''}${otherName}`;
    fs.mkdirSync(otherData, { recursive: true });
    const otherRuntime = structuredClone(runtime); otherRuntime.containerId = 'd'.repeat(64);
    for (const mount of otherRuntime.mounts) {
        if (mount.Destination === '/data') mount.Source = otherData;
        if (mount.Source === source) mount.Source = otherSource;
        if (mount.Destination === source) mount.Destination = otherSource;
    }
    const alaRoot = `${root}/AdvancedLanguageAgent`;
    for (const file of ['package.json', 'bin/ala.mjs', 'src/transcript.mjs']) {
        fs.mkdirSync(path.dirname(`${alaRoot}/${file}`), { recursive: true });
        fs.writeFileSync(`${alaRoot}/${file}`, file === 'package.json' ? '{"name":"advanced-language-agent"}' : 'export const pinned = true;\n');
    }
    const release = { applicationBaseURL: 'http://127.0.0.1:8080', boxBaseURL: 'http://127.0.0.1:8080', imageDigest: digest,
        agentLib: { mode: 'image', commit: 'f'.repeat(40) }, liveBox: { box: { containerId: boxId, imageId: digest, startedAt, semanticLabels: {} },
        workspaceSourceMount: { source: root } }, repositories: { explorer: { repositoryPath: repository } } };
    const descriptors = new Map();
    const fsApi = { ...fs, openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) {
            if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file))));
            return fs.realpathSync(file);
        } };
    const state = { outerMounts: [bind(root, root)], codeRoot: source, sourceReads: 0, programs: [] };
    const runCommand = async (args, input) => {
        if (args[0] === 'inspect') return [{ Id: boxId, Image: digest, State: { Running: true, StartedAt: startedAt },
            Config: { Env: [`PLOINKY_WORKSPACE_ROOT=${root}`], WorkingDir: root }, Mounts: state.outerMounts }];
        if (args[5] !== 'podman') return structuredClone(input.includes(`"agentName":"${agentName}"`) ? runtime : otherRuntime);
        const prefix = `(${readLiveSkillsCodeHashes.toString()})(`;
        const homePrefix = `(${readLiveSkillsHomeBinding.toString()})(`;
        if (input.startsWith(homePrefix)) {
            assert.equal(args[8], (agentName === 'roboWorkAgent' ? runtime : otherRuntime).containerId, 'Home evidence must enter the exact RoboWork container.');
            const value = homeEvidence(JSON.parse(input.slice(homePrefix.length, input.indexOf(').catch('))));
            return state.onHome ? state.onHome(value) : value;
        }
        if (!input.startsWith(prefix)) return state.onOperation();
        assert.ok(input.startsWith(prefix), 'Run the actual self-contained source reader.');
        const options = JSON.parse(input.slice(prefix.length, input.indexOf(').then(value =>')));
        const selected = options.agentName === agentName;
        assert.equal(args[8], (selected ? runtime : otherRuntime).containerId, 'Source read must enter the exact admitted container.');
        state.programs.push(options); state.sourceReads++;
        return readLiveSkillsCodeHashes(options, { codeRoot: selected ? state.codeRoot : otherSource, fsApi });
    };
    const env = { SMOKE_PLOINKY_BOX_CONTAINER: 'owned-box', SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080',
        SMOKE_WORKSPACE_ROOT: root, SMOKE_ALA_COMMAND: `${alaRoot}/bin/ala.mjs` };
    const create = () => createLiveSkillsRuntimeReader({ env, agentName, baseURL: env.SMOKE_BOX_BASE_URL, verifierPath: '/unused' },
        { collectRelease: async () => release, runCommand, fsApi });
    return { root, repository, source, runtime, otherRuntime, state, create, bind, alaRoot };
}

test('original moved source claims belong to RoboWork and remain protected exactly once', () => {
    assert.deepEqual(LIVE_SKILLS_CONTRACTS.roboWorkAgent, moved);
    const files = Object.values(LIVE_SKILLS_CONTRACTS).flat();
    assert.equal(new Set(files).size, files.length);
    assert.equal(files.length, 36, 'All 35 original claims and the current RoboTeam runtime client must remain protected.');
    assert.ok(LIVE_SKILLS_CONTRACTS.roboTeamAgent.includes('server/run-client.mjs'));
});

for (const agentName of ['roboTeamAgent', 'roboWorkAgent']) {
    test(`actual relocated source tree constructs the ${agentName} reader and binds its own runtime bytes`, async t => {
        const c = setup(t, agentName), reader = await c.create(), evidence = await reader.finish();
        assert.equal(c.state.programs.filter(args => args.agentName === agentName).length, 2);
        assert.deepEqual(evidence.contractHashes, Object.fromEntries(LIVE_SKILLS_CONTRACTS[agentName].map(file =>
            [file, liveSkillsHash(fs.readFileSync(`${c.source}/${file}`))])));
        if (agentName === 'roboTeamAgent') {
            assert.equal(evidence.executionSources.runtime.containerId, 'd'.repeat(64));
            assert.deepEqual(Object.keys(evidence.executionSources.contractHashes), moved);
            assert.ok(c.state.programs.filter(args => args.agentName === 'roboWorkAgent').length >= 2);
        } else assert.equal(evidence.executionSources, undefined, 'Execution reader must not recursively create a controller guard.');
    });

    test(`${agentName} refuses another container's source even when its bytes are identical`, async t => {
        const c = setup(t, agentName);
        fs.cpSync(c.source, `${c.root}/copied-code`, { recursive: true }); c.state.codeRoot = `${c.root}/copied-code`;
        await assert.rejects(c.create(), /verified source directory object/);
    });

    test(`${agentName} finish refuses changed hash and generation instead of certifying stale source`, async t => {
        const c = setup(t, agentName), reader = await c.create();
        const file = `${c.source}/${LIVE_SKILLS_CONTRACTS[agentName][0]}`, original = fs.readFileSync(file);
        fs.appendFileSync(file, '\n// changed source\n');
        await assert.rejects(reader.finish(), /source differs/);
        fs.writeFileSync(file, original); c.runtime.enableGeneration = randomUUID();
        await assert.rejects(reader.finish(), /replaced, restarted or remounted/);
    });
}

test('RoboWork reader refuses RoboTeam owner mounts and moved-file shadows in either container layer', async t => {
    const c = setup(t, 'roboWorkAgent');
    const code = c.runtime.mounts.find(mount => mount.Destination === '/code');
    code.Source = `${c.repository}/roboTeamAgent`;
    await assert.rejects(c.create(), /exact verified/); code.Source = c.source;
    c.runtime.mounts.push(c.bind('/foreign', `/code/${moved[0]}`));
    await assert.rejects(c.create(), /shadowing/); c.runtime.mounts.pop();
    c.state.outerMounts.push(c.bind('/foreign', `${c.source}/${moved[0]}`));
    await assert.rejects(c.create(), /shadowing/);
});

for (const operation of ['capture', 'fixtureOperation']) test(`controller ${operation} rechecks moved runtime source after the operation`, async t => {
    const c = setup(t, 'roboTeamAgent'), reader = await c.create();
    const fixture = createLiveSkillsFixture(c.root);
    if (operation === 'capture') fixture.robotId = 'owned-live-robot';
    const hashes = Object.fromEntries(LIVE_SKILLS_CONTRACTS.roboTeamAgent.map(file => [file, liveSkillsHash(fs.readFileSync(`${c.source}/${file}`))]));
    c.state.onOperation = () => {
        fs.appendFileSync(`${c.repository}/roboWorkAgent/${moved[0]}`, '\n// changed during operation\n');
        return { prepared: true, workspaceRoot: c.root, codeHashes: hashes, homeBinding: homeEvidence(fixture), sourceMapping: 'aliases', alaBinding: {
            root: c.alaRoot, command: `${c.alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
                .map(file => [file, liveSkillsHash(fs.readFileSync(`${c.alaRoot}/${file}`))])),
        } };
    };
    await assert.rejects(operation === 'capture' ? reader.capture({ sessionId: randomUUID(), fixture }) : reader.fixtureOperation('prepare', fixture), /source differs/);
});

test('controller companion rejects a changed execution generation and a reused controller container ID', async t => {
    const c = setup(t, 'roboTeamAgent'), reader = await c.create();
    const generation = c.otherRuntime.enableGeneration;
    c.otherRuntime.enableGeneration = randomUUID();
    await assert.rejects(reader.finish(), /replaced, restarted or remounted/);
    c.otherRuntime.enableGeneration = generation;
    c.otherRuntime.containerId = c.runtime.containerId;
    await assert.rejects(c.create(), /different exact runtime containers/);
});

test('controller companion retains hash protection for every moved source claim', async t => {
    const c = setup(t, 'roboTeamAgent'), reader = await c.create();
    for (const file of moved) {
        const target = `${c.repository}/roboWorkAgent/${file}`, original = fs.readFileSync(target);
        fs.appendFileSync(target, '\n// changed moved source\n');
        await assert.rejects(reader.finish(), /source differs/, file);
        fs.writeFileSync(target, original);
    }
    await reader.finish();
});

test('every moved source claim is checked before a fixture action can mutate state', async t => {
    const c = setup(t, 'roboTeamAgent'), reader = await c.create(), fixture = createLiveSkillsFixture(c.root);
    let operations = 0; c.state.onOperation = () => { operations++; return { prepared: true }; };
    for (const file of moved) {
        const target = `${c.repository}/roboWorkAgent/${file}`, original = fs.readFileSync(target);
        fs.appendFileSync(target, '\n// changed before operation\n');
        await assert.rejects(reader.fixtureOperation('prepare', fixture), /source differs/, file);
        fs.writeFileSync(target, original);
    }
    assert.equal(operations, 0, 'Unverified relocated source must prevent entry into the fixture operation.');
});

test('fixture source guard accepts the canonical /code bind object and rejects identical copied bytes before mutation', async t => {
    const c = setup(t, 'roboTeamAgent');
    let fixture = createLiveSkillsFixture(c.root);
    const contractHashes = Object.fromEntries(LIVE_SKILLS_CONTRACTS.roboTeamAgent.map(file => [file, liveSkillsHash(fs.readFileSync(`${c.source}/${file}`))]));
    const codeRoot = `${c.root}/runtime-code`, descriptors = new Map();
    let backingRoot = c.source;
    const backing = file => file === codeRoot || file.startsWith(`${codeRoot}/`) ? backingRoot + file.slice(codeRoot.length) : file;
    const fsApi = { ...fs,
        realpathSync(file) {
            const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/);
            if (match) {
                const opened = descriptors.get(Number(match[1]));
                const actual = process.platform === 'linux' ? fs.realpathSync(file) : fs.realpathSync(opened.backing);
                return actual === opened.backing ? opened.filename : actual;
            }
            const actual = fs.realpathSync(backing(file));
            return actual === backing(file) ? file : actual;
        },
        lstatSync(file, options) { return fs.lstatSync(backing(file), options); },
        openSync(file, flags) { const fd = fs.openSync(backing(file), flags); descriptors.set(fd, { filename: file, backing: backing(file) }); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
    };
    const run = async () => { let result; await operateLiveSkillsFixture({ action: 'prepare', fixture, workspaceRoot: c.root,
        expectedRepository: c.repository, contractHashes }, { codeRoot, fsApi, emit: value => { result = value; } }); return result; };
    assert.equal((await run()).prepared, true);
    assert.equal(descriptors.size, 0);
    fixture = createLiveSkillsFixture(c.root);
    fs.cpSync(c.source, `${c.root}/copied-code`, { recursive: true }); backingRoot = `${c.root}/copied-code`;
    await assert.rejects(run(), /verified source directory object/);
    assert.equal(descriptors.size, 0);
    assert.equal(fs.existsSync(fixture.workspace), false); assert.equal(fs.existsSync(fixture.repositoryRoot), false);
});

for (const invalid of ['canonical mapping', 'replaced home']) test(`production capture rejects ${invalid}`, async t => {
    const c = setup(t, 'roboTeamAgent'), reader = await c.create(), fixture = createLiveSkillsFixture(c.root);
    fixture.robotId = 'owned-live-robot'; let homeReads = 0;
    c.state.onHome = value => { homeReads++; if (invalid === 'replaced home' && homeReads > 1) value.identity.ino = '99'; return value; };
    c.state.onOperation = () => ({ workspaceRoot: c.root, codeHashes: Object.fromEntries(LIVE_SKILLS_CONTRACTS.roboTeamAgent.map(file =>
        [file, liveSkillsHash(fs.readFileSync(`${c.source}/${file}`))])), homeBinding: homeEvidence(fixture),
    sourceMapping: invalid === 'canonical mapping' ? 'canonical' : 'aliases', alaBinding: {
        root: c.alaRoot, command: `${c.alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
            .map(file => [file, liveSkillsHash(fs.readFileSync(`${c.alaRoot}/${file}`))])),
    } });
    await assert.rejects(reader.capture({ sessionId: randomUUID(), fixture }), invalid === 'canonical mapping' ? /source aliases/ : /home changed/);
});
