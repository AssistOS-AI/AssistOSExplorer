import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LIVE_SKILLS_CONTRACTS, readLiveSkillsCodeHashes, readLiveSkillsHomeBinding } from './copilot-live-skills-runtime.mjs';
import { createLiveSkillsFixture } from './copilot-live-skills.mjs';
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
