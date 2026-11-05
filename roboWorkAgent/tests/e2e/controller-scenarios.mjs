import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { argumentsFrom } from './isolation.mjs';
import { ControllerRuntime } from './controller/runtime.mjs';
import { explorerListing, explorerProtectedListing } from './controller/explorer-api.mjs';
import { BASELINE_REVISION, baselineSymlinkControl } from './controller/baseline-control.mjs';
import { openControllerSession } from './controller/auth-session.mjs';
import { FREE_MODEL, ProbeRobots } from './controller/robots.mjs';
import { nativeSymlinkControl } from './controller/native-terminal.mjs';
import { SENTINEL, assertNoAgentExec, assertVictimUnchanged, assertDualHome, assertDeleted,
    assertEmptyPrivateListing, assertNoMarker, createMarkerStreamGuard, assertRefused, sha256, pending } from './controller/contracts.mjs';

export const HELP = `Usage: node controller-scenarios.mjs --config <private-json> --scenario <I2|I8|I9|I10|I11|W1|H2|H3>
Run on the selected apparatus host. No SSH or model prompt is issued.
Config: engine (podman/docker), canonical fixture host path, workspace in-Box path,
box {id,image,startedAt}, rt/rw immutable IDs, ploinkyRoot/ploinkyRevision,
attacker name prefix/victim registry robot ID, sources [{role,root,revision,subdir,runtimePath}].
Exactly rt (subdir roboTeamAgent), rw (roboWorkAgent), ala (empty subdir) sources
are required; runtimePath is /code for rt/rw and the actual ALA root in RW.
I11 creates and deletes a dedicated attacker through normal RoboTeam APIs; victim must exist
with a nonempty <=4096-byte marker-B. H2 creates its own normally configured
robot and checks Browser then Desktop, with exact discovered GUI IDs. Config contains identities, never credentials
or result overrides. All scenarios need explorer {origin,storageState}, where storageState
is the current operator browser's private Playwright JSON and origin is a local
published port of this exact Box. I2 exercises native preparation and Browser
creation but supplies no model prompt; it requires the approved baseline Git
object for its isolated mode-mutation negative control. I10 retains all eighteen
grant refusals (the workspace-private .data/roboTeamAgent and .ploinky-box included, each
proved to exist from RoboWork first) and performs a finite native symlink read through
the normal default robot WebTTY terminal (existing smoke Playwright/Chromium required).
W1 uses a new owned robot and owned folders to prove that a sibling folder's OpenCode
plugin is not loaded while its parent's is, and that a plugin in the robot's own home
sees an empty workspace .data during a fresh model discovery.
M17 sets default and probe robots by normal RT PATCH to the exact free Nemotron
route. H2 stops and deletes only its own newly provisioned probe and GUI.
P1 lifecycle orchestration remains pending and exits nonzero before live access.
Evidence contains hashes, identities and completed assertions only. A sentinel
proves this invocation's selected scenario, never the entire Acceptance suite.`;

export async function manifests(runtime) {
    const inventory = [];
    for (const [name, row] of Object.entries(runtime.registry).filter(([, row]) => row.type === 'agent')) {
        inventory.push({ name, manifest: await runtime.node(row.containerId,
            'console.log(fs.readFileSync("/code/manifest.json","utf8"));') });
    }
    inventory.sort((a, b) => a.name.localeCompare(b.name));
    const result = assertNoAgentExec(inventory);
    assert.throws(() => assertNoAgentExec([{ name: 'negative-control', manifest: { routerAccess: { agentExec: true } } }]));
    return { ...result, negativeControl: 'agentExec fixture rejected' };
}

async function stopOwnedActivity(runtime, attacker, victim) {
    const noMarker = value => { if (victim) assertNoMarker(value, victim.markerHash, victim.markerLength); };
    const listed = await runtime.mcp('run_list', { robotId: attacker });
    noMarker(listed);
    assert.ok(listed.ok && Array.isArray(listed.result), 'Cannot inventory owned runs for cleanup.');
    for (const run of listed.result) {
        assert.equal(run.robotId, attacker);
        const scanRecords = victim ? createMarkerStreamGuard(victim.markerHash, victim.markerLength) : () => {};
        if (['starting', 'running', 'stopping'].includes(run.state)) {
            const stop = await runtime.mcp('run_stop', { runId: run.runId, signal: 'SIGTERM' });
            noMarker(stop);
            assert.equal(stop.ok, true, 'Owned native run cleanup failed.');
        }
        let ended = false, cursor = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
            const read = await runtime.mcp('run_read', { runId: run.runId, after: cursor, waitMs: 250, maxBytes: 1024 * 1024 });
            noMarker(read);
            assert.equal(read.ok, true, 'Cannot confirm owned run cleanup.');
            assert.ok(Number.isSafeInteger(read.result?.next) && read.result.next >= cursor
                && Array.isArray(read.result.records), 'Owned run output cursor is unavailable.');
            scanRecords(read.result.records);
            if (['completed', 'failed', 'stopped', 'interrupted', 'exited'].includes(read.result.state)
                && read.result.records.length === 0 && read.result.next === cursor) { ended = true; break; }
            cursor = read.result.next;
        }
        assert.ok(ended, 'Owned run did not stop within the cleanup bound.');
        const release = await runtime.mcp('run_release', { runId: run.runId });
        noMarker(release);
        assert.equal(release.ok, true, 'Owned run release failed.');
    }
    const stopped = await runtime.mcp('gui_stop', { robotId: attacker });
    noMarker(stopped);
    assert.ok(stopped.ok && stopped.result?.state === 'stopped', 'Owned GUI cleanup failed.');
}

export async function symlinkHelpers(runtime) {
    const { victim, workspace } = runtime.config;
    const before = await runtime.snapshot(victim);
    const source = runtime.config.sources.find(row => row.role === 'rt');
    const baseline = await runtime.command('git', ['-C', source.root, 'show', `${BASELINE_REVISION}:roboTeamAgent/server/runtime-manager.mjs`]);
    const negativeControl = await baselineSymlinkControl(baseline);
    const attacker = await runtime.probes.create(runtime.config.attacker);
    const project = `${workspace}/controller-symlinks-${randomUUID()}`;
    const owner = await runtime.node(runtime.config.rw, `
        fs.mkdirSync(input.project,{mode:0o700}); const stat=fs.lstatSync(input.project);
        console.log(JSON.stringify({ino:stat.ino,dev:stat.dev}));`, { project });
    const observations = [];
    let created = false;
    try {
        created = true;
        await runtime.node(runtime.config.rw, `
            const home='/data/robots/'+input.attacker+'/home', target='/data/robots/'+input.victim+'/home';
            const config=path.join(home,'.config');
            if(!fs.existsSync(config)) fs.mkdirSync(config,{mode:0o700});
            if(!fs.lstatSync(config).isDirectory()||fs.lstatSync(config).isSymbolicLink()) throw Error('Unsafe owned config');
            for(const name of ['.codex','.ala','.config/opencode']) {
                const link=path.join(home,name); fs.rmSync(link,{recursive:true,force:true}); fs.symlinkSync(target,link,'dir');
                const marker=fs.readFileSync(path.join(link,'marker-B'));
                if(crypto.createHash('sha256').update(marker).digest('hex')!==input.markerHash) throw Error('Planted link control failed');
            } console.log('true');`, { attacker, victim, markerHash: before.markerHash });
        const runId = `controller-${randomUUID()}`;
        const calls = [
            ['robot_ensure', { robotId: attacker, name: 'Controller symlink fixture', codingAgents: ['opencode'] }],
            ['robot_status', { robotIds: [attacker], includeLogins: true }],
            ['robot_config', { robotId: attacker }],
            ['robot_models', { robotId: attacker, agent: 'opencode', cwd: project }],
            ['gui_ensure', { robotId: attacker, mode: 'browser', codingAgents: ['opencode'], allowReplace: false }],
            ['run_start', { runId, robotId: attacker, cwd: project, ala: { sessionId: randomUUID(), ca: 'opencode', model: FREE_MODEL }, folders: [], ignore: [], channels: [], tag: {} }],
        ];
        for (const [tool, input] of calls) {
            const result = await runtime.mcp(tool, input);
            assertNoMarker(result, before.markerHash, before.markerLength);
            if (!result.ok) assert.ok(['HOME_OPERATION_FAILED', 'MODEL_DISCOVERY_FAILED'].includes(result.code),
                'Tool failed for a reason that does not establish a confined home operation.');
            observations.push({ tool, ok: result.ok, code: result.code, outputHash: sha256(JSON.stringify(result)) });
            assertVictimUnchanged(before, await runtime.snapshot(victim));
        }
        assert.ok(observations.some(row => row.code === 'HOME_OPERATION_FAILED'), 'No confined helper refusal was observed.');
        await stopOwnedActivity(runtime, attacker, before);
        const deleted = await runtime.probes.remove(attacker);
        assertNoMarker(deleted, before.markerHash, before.markerLength); assertDeleted(deleted); created = false;
        observations.push({ tool: 'robot_delete', ok: true });
    } finally {
        if (created) {
            await stopOwnedActivity(runtime, attacker, before);
            assertDeleted(await runtime.probes.remove(attacker));
        }
        await runtime.node(runtime.config.rw, `
            const stat=fs.lstatSync(input.project);
            if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==input.ino||stat.dev!==input.dev) throw Error('Project ownership changed');
            fs.rmSync(input.project,{recursive:true}); console.log('true');`, { project, ...owner });
        assertVictimUnchanged(before, await runtime.snapshot(victim));
    }
    return { victim: before, negativeControl, observations };
}

export async function safeDelete(runtime) {
    const { victim } = runtime.config;
    const before = await runtime.snapshot(victim);
    const attacker = await runtime.probes.create(runtime.config.attacker);
    let created = false;
    let operationError;
    try {
        created = true;
        await runtime.node(runtime.config.rw, `
            const home='/data/robots/'+input.attacker+'/home';
            const target='/data/robots/'+input.victim+'/home';
            fs.symlinkSync(target,path.join(home,'victim-link'),'dir');
            const expected=fs.readFileSync(path.join(target,'marker-B'));
            if(!fs.readFileSync(path.join(home,'victim-link','marker-B')).equals(expected)) throw Error('Dead positive control');
            console.log('true');`, { attacker, victim });
        const deleted = await runtime.probes.remove(attacker);
        assertDeleted(deleted);
        created = false;
        await runtime.node(runtime.config.rw, `
            try {fs.lstatSync('/data/robots/'+input.id); throw Error('Deleted robot still exists');}
            catch(error) {if(error.code!=='ENOENT') throw error;}
            console.log('true');`, { id: attacker });
    } catch (error) { operationError = error; }
    finally {
        if (created) {
            // Only this invocation's initially absent ID is eligible. A cleanup
            // failure is fatal; it cannot be converted into successful evidence.
            const cleanup = await runtime.probes.remove(attacker);
            assertDeleted(cleanup);
        }
        assertVictimUnchanged(before, await runtime.snapshot(victim));
    }
    if (operationError) throw operationError;
    return { victim: before, attackerAbsent: true, positiveControl: 'planted link reads victim marker in privileged RoboWork shell' };
}

export async function otherAgentMasks(runtime) {
    const privatePath = `${runtime.config.workspace}/.data/.private`;
    const inventory = [];
    for (const [name, row] of Object.entries(runtime.registry).filter(([, row]) => row.type === 'agent')) {
        const evidence = await runtime.node(row.containerId, `
            const manifest=JSON.parse(fs.readFileSync('/code/manifest.json','utf8'));
            const entries=fs.readdirSync(input.privatePath);
            console.log(JSON.stringify({manifestHash:crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),entries}));
        `, { privatePath });
        assertEmptyPrivateListing(evidence.entries);
        inventory.push({ name, containerId: row.containerId, manifestHash: evidence.manifestHash });
    }
    assert.ok(inventory.length > 0);
    const victim = await runtime.snapshot(runtime.config.victim);
    const homes = await runtime.node(runtime.config.rw, 'console.log(JSON.stringify(fs.readdirSync("/data/robots")));');
    assert.ok(homes.includes(runtime.config.victim), 'Privileged RoboWork positive control cannot list victim home.');
    const control = `${runtime.config.workspace}/controller-mask-${randomUUID()}`;
    const owner = await runtime.node(runtime.config.rw, `
        fs.mkdirSync(input.directory,{mode:0o700});
        const stat=fs.lstatSync(input.directory); console.log(JSON.stringify({ino:stat.ino,dev:stat.dev}));
    `, { directory: control });
    let api;
    try {
        await runtime.node(runtime.config.rw, `
            fs.writeFileSync(path.join(input.directory,'positive-control'),'owned',{flag:'wx',mode:0o600}); console.log('true');
        `, { directory: control });
        const positive = await explorerListing(runtime, control);
        assert.ok(Array.isArray(positive.listing) && positive.listing.some(entry => entry.name === 'positive-control'),
            'Explorer file API positive control is missing.');
        const root = await explorerListing(runtime, runtime.config.workspace);
        assert.ok(Array.isArray(root.listing) && root.listing.every(entry => typeof entry?.name === 'string'),
            'Explorer workspace root listing is unavailable.');
        assert.ok(!root.listing.some(entry => entry.name.normalize('NFKC').toLowerCase().replace(/[. ]+$/u, '') === '.data'),
            'Explorer exposes private storage in the workspace root listing.');
        api = await explorerProtectedListing(runtime, privatePath);
    } finally {
        await runtime.node(runtime.config.rw, `
            const stat=fs.lstatSync(input.directory);
            if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==input.ino||stat.dev!==input.dev) throw Error('Control ownership changed');
            const entries=fs.readdirSync(input.directory); if(entries.length>1||(entries.length===1&&entries[0]!=='positive-control')) throw Error('Unexpected control data');
            if(entries.length) fs.unlinkSync(path.join(input.directory,'positive-control')); fs.rmdirSync(input.directory); console.log('true');
        `, { directory: control, ...owner });
        assertVictimUnchanged(victim, await runtime.snapshot(runtime.config.victim));
    }
    return { inventory, victim, apiGeneration: api.generation, privateApiRefused: api.refusal,
        workspacePrivateRootHidden: true, positiveControl: 'Explorer lists newly created owned file' };
}

export async function grantRefusals(runtime, nativeControl = nativeSymlinkControl) {
    const { workspace, victim } = runtime.config;
    const attacker = await runtime.probes.create(runtime.config.attacker);
    const before = await runtime.snapshot(victim);
    const project = `${workspace}/controller-grants-${randomUUID()}`;
    const owner = await runtime.node(runtime.config.rw, `
        fs.mkdirSync(input.project,{mode:0o700});
        const st=fs.lstatSync(input.project); console.log(JSON.stringify({ino:st.ino,dev:st.dev}));
    `, { project, victim, markerHash: before.markerHash });
    const observations = [];
    let nativeTerminal, retain = false;
    const noRuns = async () => {
        const result = await runtime.mcp('run_list', { robotId: attacker });
        assert.ok(result.ok && Array.isArray(result.result), 'Grant probe run inventory is unavailable.');
        assert.deepEqual(result.result, [], 'Grant validation unexpectedly admitted a native run.');
    };
    try {
        await noRuns();
        await runtime.node(runtime.config.rw, `
            fs.symlinkSync('/data/robots/'+input.victim+'/home',path.join(input.project,'victim-link'),'dir');
            const bytes=fs.readFileSync(path.join(input.project,'victim-link','marker-B'));
            if(crypto.createHash('sha256').update(bytes).digest('hex')!==input.markerHash) throw Error('Grant symlink positive control failed'); console.log('true');
        `, { project, victim, markerHash: before.markerHash });
        // Workspace entries that exist but belong to no robot. The service must see them, or a refusal proves nothing.
        const private_ = [`${workspace}/.data/roboTeamAgent`, `${workspace}/.ploinky-box`];
        await runtime.node(runtime.config.rw, `
            for (const target of input.targets) if (!fs.lstatSync(target).isDirectory()) throw Error('Refusal target is not a directory: '+target);
            console.log('true');
        `, { op: 'exists', targets: private_ });
        // The deliberately invalid tag is checked after grants. If a protected
        // grant unexpectedly succeeds, this stops before any native launch and
        // produces INVALID_INPUT, which cannot satisfy the refusal assertion.
        const request = { runId: `controller-${randomUUID()}`, robotId: attacker, cwd: project,
            ala: { sessionId: randomUUID() }, folders: [], ignore: [], channels: [], tag: { padding: 'x'.repeat(65537) } };
        assertRefused(await runtime.mcp('run_start', request), 'INVALID_INPUT');
        assertRefused(await runtime.mcp('run_start', { ...request, folders: [{ source: project }] }), 'INVALID_INPUT');
        const paths = ['/data', '/data/robots', `/data/robots/${victim}/home`,
            `${workspace}/.data/.private`, workspace, '/', `${project}/victim-link`, ...private_];
        for (const target of paths) {
            for (const kind of ['cwd', 'folder']) {
                const result = await runtime.mcp('run_start', kind === 'cwd' ? { ...request, cwd: target }
                    : { ...request, folders: [{ source: target }] });
                assertRefused(result, kind === 'cwd' ? 'CWD_REFUSED' : 'FOLDER_REFUSED');
                assertNoMarker(result, before.markerHash, before.markerLength);
                observations.push({ kind, pathHash: sha256(target), code: result.code });
            }
        }
        await noRuns();
        nativeTerminal = await nativeControl(runtime, { attacker, project, victim: before });
        await noRuns();
    } catch (error) {
        retain = error.evidence?.nativeTerminal?.cleanupConfirmed === false;
        if (retain) runtime.retainedNativeTerminal = { ...error.evidence.nativeTerminal,
            projectOwner: { project, ...owner }, robotOwner: runtime.probes.owned?.get(attacker) };
        error.evidence = { ...error.evidence, observations, victim: before,
            ...(retain ? { nativeTerminal: runtime.retainedNativeTerminal } : {}) };
        throw error;
    } finally {
        if (!retain) await runtime.node(runtime.config.rw, `
            const st=fs.lstatSync(input.project);
            if(!st.isDirectory()||st.isSymbolicLink()||st.ino!==input.ino||st.dev!==input.dev) throw Error('Grant control ownership changed');
            // Opening a terminal creates the empty mask target; a non-empty one or any other entry is a failure, and rmdir proves it empty.
            const names=fs.readdirSync(input.project).filter(name=>name!=='.roboteam'||!fs.lstatSync(path.join(input.project,name)).isDirectory()||fs.rmdirSync(path.join(input.project,name)));
            if(names.length>1||(names.length===1&&(names[0]!=='victim-link'||!fs.lstatSync(path.join(input.project,'victim-link')).isSymbolicLink()))) throw Error('Grant control changed');
            if(names.length) fs.unlinkSync(path.join(input.project,'victim-link')); fs.rmdirSync(input.project); console.log('true');
        `, { project, ...owner });
        assertVictimUnchanged(before, await runtime.snapshot(victim));
    }
    return { observations, victim: before, nativeTerminal,
        positiveControl: 'safe cwd and folder reach subsequent tag validation; privileged symlink reads marker' };
}

// OpenCode finds plugins in every ancestor of its working folder and never beside it. This plants the same canary in a
// sibling of the working folder and in its parent, and a recorder in the robot's own home, then runs a real turn and a fresh
// model discovery. The sibling's canary must stay silent, the parent's must write (it proves the canary runs, and documents
// that a robot writing a parent folder runs code in its children), and the recorder must have run and seen an empty `.data`.
const CANARY = marker => `export const W1Canary = async () => { try { const fs = await import('node:fs'), path = await import('node:path');
    fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(marker)}), 'loaded'); } catch {} return {}; };`;
const RECORDER = root => `export const W1Recorder = async () => { try { const fs = await import('node:fs'), path = await import('node:path');
    let entry; try { entry = { entries: fs.readdirSync(${JSON.stringify(`${root}/.data`)}) }; } catch (error) { entry = { error: String(error.code || error.message) }; }
    fs.appendFileSync(path.join(process.env.HOME, 'w1-recorder.jsonl'), JSON.stringify({ cwd: process.cwd(), ...entry }) + '\\n'); } catch {} return {}; };`;
const W1_MARKERS = Object.freeze({ sibling: 'w1-marker-sibling', parent: 'w1-marker-parent' });

export async function walkUpAndDiscovery(runtime) {
    const { workspace } = runtime.config;
    const attacker = await runtime.probes.create(runtime.config.attacker);
    const parent = `${workspace}/controller-w1-${randomUUID()}`;
    const cwd = `${parent}/child`, sibling = `${parent}/sibling`;
    const owner = await runtime.node(runtime.config.rw, `
        for (const directory of [input.parent, input.cwd, input.sibling]) fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const stat=fs.lstatSync(input.parent); console.log(JSON.stringify({ino:stat.ino,dev:stat.dev}));
    `, { op: 'folders', parent, cwd, sibling });
    let observed;
    try {
        await runtime.node(runtime.config.rw, `
            for (const [directory, file, source] of input.plugins) {
                for (const name of ['plugin','plugins']) { fs.mkdirSync(path.join(directory,'.opencode',name),{recursive:true}); fs.writeFileSync(path.join(directory,'.opencode',name,file),source); }
            }
            const home='/data/robots/'+input.attacker+'/home/.config/opencode/plugins';
            fs.mkdirSync(home,{recursive:true}); fs.writeFileSync(path.join(home,'w1-recorder.js'),input.recorder);
            console.log('true');
        `, { op: 'plant', attacker, recorder: RECORDER(workspace), plugins: [
            [sibling, 'w1-sibling.js', CANARY(W1_MARKERS.sibling)], [parent, 'w1-parent.js', CANARY(W1_MARKERS.parent)]] });
        const read = async () => runtime.node(runtime.config.rw, `
            const records=fs.existsSync(input.file)?fs.readFileSync(input.file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line)):[];
            const present=name=>fs.existsSync(path.join(input.cwd,name));
            console.log(JSON.stringify({records,sibling:present(input.markers.sibling),parent:present(input.markers.parent)}));
        `, { op: 'observe', file: `/data/robots/${attacker}/home/w1-recorder.jsonl`, cwd, markers: W1_MARKERS });
        // A fresh discovery: a new robot has no cached catalog, and the recorder is new to its configuration.
        const models = await runtime.mcp('robot_models', { robotId: attacker, agent: 'opencode', cwd });
        assert.ok(models.ok === true, 'Model discovery failed, so its view of the workspace was not observed.');
        const discovery = await read();
        assert.ok(discovery.records.length > 0, 'The home plugin never ran during model discovery.');
        for (const record of discovery.records) assert.deepEqual(record.entries, [], `Discovery saw workspace .data entries or failed: ${JSON.stringify(record)}`);
        // A real turn in the working folder.
        const runId = `controller-${randomUUID()}`;
        const started = await runtime.mcp('run_start', { runId, robotId: attacker, cwd, ala: { sessionId: randomUUID(), ca: 'opencode', model: FREE_MODEL },
            folders: [], ignore: [], channels: [], tag: {} });
        assert.ok(started.ok === true, 'The probe turn could not start.');
        const prompt = Buffer.from(`${JSON.stringify({ type: 'prompt', prompt: 'Reply with the single word ok.' })}\n`).toString('base64');
        assert.ok((await runtime.mcp('run_input', { runId, data: prompt })).ok === true, 'The probe prompt was not accepted.');
        let state = 'running', cursor = 0;
        for (let attempt = 0; attempt < 480 && ['starting', 'running', 'stopping'].includes(state); attempt++) {
            const chunk = await runtime.mcp('run_read', { runId, after: cursor, waitMs: 500, maxBytes: 1024 * 1024 });
            assert.ok(chunk.ok === true && Number.isSafeInteger(chunk.result?.next), 'The probe turn cannot be read.');
            cursor = chunk.result.next; state = chunk.result.state;
        }
        await stopOwnedActivity(runtime, attacker);
        assert.ok(!['starting', 'running', 'stopping'].includes(state), 'The probe turn did not end within its bound.');
        observed = await read();
        assert.ok(observed.records.length > discovery.records.length, 'The home plugin never ran during the turn.');
        for (const record of observed.records) assert.deepEqual(record.entries, [], `A robot saw workspace .data entries: ${JSON.stringify(record)}`);
        assert.equal(observed.parent, true, 'The parent folder canary did not run, so the turn proves nothing about plugin loading.');
        assert.equal(observed.sibling, false, 'A sibling folder plugin was loaded.');
        assertDeleted(await runtime.probes.remove(attacker));
    } finally {
        if (runtime.probes.owned?.has(attacker)) {
            await stopOwnedActivity(runtime, attacker);
            assertDeleted(await runtime.probes.remove(attacker));
        }
        await runtime.node(runtime.config.rw, `
            const stat=fs.lstatSync(input.parent);
            if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==input.ino||stat.dev!==input.dev) throw Error('Walk-up folder ownership changed');
            fs.rmSync(input.parent,{recursive:true}); console.log('true');
        `, { op: 'remove', parent, ...owner });
    }
    return { discoveryRecords: observed.records.length, markers: { parent: observed.parent, sibling: observed.sibling },
        positiveControl: 'the parent folder canary wrote its marker and the home recorder ran in discovery and in the turn' };
}

export async function dualHome(runtime) {
    const victim = await runtime.probes.create('dual-home');
    const evidence = [];
    try {
        for (const mode of ['browser', 'desktop']) {
            const input = { robotId: victim, mode, codingAgents: ['opencode'], allowReplace: false };
            const deadline = Date.now() + 180000;
            let ensured = await runtime.mcp('gui_ensure', input);
            while (ensured.ok && ensured.result?.state === 'starting' && Date.now() < deadline) {
                await delay(250);
                const status = await runtime.mcp('robot_status', { robotIds: [victim] });
                assert.ok(status.ok && status.result?.robots?.length === 1 && status.result.robots[0].id === victim,
                    'Owned GUI status is unavailable.');
                ensured = { ok: true, result: status.result.robots[0].gui };
            }
            assert.ok(ensured.ok && ensured.result?.state === 'running' && ensured.result.mode === mode,
                'Owned GUI did not become ready in its selected mode.');
            const ids = (await runtime.inner(runtime.config.rw, ['podman', 'ps', '--all', '--no-trunc',
                '--filter', `label=io.assistos.robowork.robot-id=${victim}`, '--filter', `label=io.assistos.robowork.mode=${mode}`,
                '--format', '{{.ID}}'])).trim().split('\n').filter(Boolean);
            assert.equal(ids.length, 1, 'Owned GUI container identity is missing or ambiguous.');
            const id = ids[0]; assert.match(id, /^[a-f0-9]{64}$/u);
            const rows = JSON.parse(await runtime.inner(runtime.config.rw, ['podman', 'inspect', id]));
            assert.equal(rows.length, 1); const row = rows[0];
            assert.equal(row.Id, id); assert.equal(row.State?.Running, true);
            assert.equal(row.Config?.Labels?.['io.assistos.robowork.robot-id'], victim);
            assert.equal(row.Config?.Labels?.['io.assistos.robowork.mode'], mode);
            assert.equal(row.Config?.Labels?.['io.assistos.robowork.gui'], '1');
            const targets = ['/config', `/home/${victim}`];
            const mounts = targets.map(target => row.Mounts?.find(mount => mount.Destination === target));
            assert.ok(mounts.every(mount => mount?.Type === 'bind'));
            assert.equal(mounts[0].Source, `/data/robots/${victim}/home`);
            assert.equal(mounts[1].Source, mounts[0].Source);
            const output = await runtime.inner(runtime.config.rw, ['podman', 'exec', id, 'stat', '-c', '%d:%i:%F', ...targets]);
            const stats = output.trim().split('\n').map(line => {
                const match = /^(\d+):(\d+):directory$/u.exec(line); assert.ok(match, 'Unexpected GUI stat evidence.');
                return { dev: Number(match[1]), ino: Number(match[2]), directory: true };
            });
            assertDualHome(stats); evidence.push({ mode, id, stats });
            await stopOwnedActivity(runtime, victim);
            const remaining = await runtime.inner(runtime.config.rw, ['podman', 'ps', '--all', '--no-trunc',
                '--filter', `label=io.assistos.robowork.robot-id=${victim}`, '--filter', 'label=io.assistos.robowork.gui=1',
                '--format', '{{.ID}}']);
            assert.equal(remaining.trim(), '', 'Previous GUI still exists; refusing the next heavy mode.');
        }
        assert.deepEqual(evidence[1].stats, evidence[0].stats, 'Browser and Desktop did not retain the same persistent home.');
    } finally {
        await stopOwnedActivity(runtime, victim);
        await runtime.probes.remove(victim);
    }
    return evidence;
}

export async function workspaceStorage(runtime) {
    for (const output of [await runtime.box(['podman', 'volume', 'ls', '--format', 'json']),
        await runtime.inner(runtime.config.rw, ['podman', 'volume', 'ls', '--format', 'json'])]) {
        assert.deepEqual(JSON.parse(output), [], 'Named volumes exist in the selected Box or RoboWork.');
    }
    const root = `${runtime.config.workspace}/.data/.private/roboWorkAgent`;
    const inspection = runtime.inspections.get(runtime.config.rw);
    assert.ok(inspection.Mounts?.some(mount => mount.Type === 'bind' && mount.Source === root && mount.Destination === '/data'),
        'RoboWork data is not the selected workspace bind.');
    const output = await runtime.box(['du', '-s', root]);
    const match = /^(\d+)\s+/u.exec(output); assert.ok(match && Number(match[1]) > 0, 'Private workspace storage is missing.');
    return { namedVolumes: 0, workspaceBind: true, privateDataKiB: Number(match[1]) };
}

export async function runControllerScenario(config, scenario) {
    if (!['I2', 'I8', 'I9', 'I10', 'I11', 'W1', 'H2', 'H3'].includes(scenario)) {
        pending(scenario, 'Controller scenario is not fully implemented; authenticated API, sandbox control or lifecycle evidence remains pending.');
    }
    const runtime = new ControllerRuntime(config);
    return runVerifiedScenario(runtime, scenario);
}

export async function runVerifiedScenario(runtime, scenario) {
    const identity = await runtime.verify();
    const operation = { I2: symlinkHelpers, I8: otherAgentMasks, I9: manifests, I10: grantRefusals, I11: safeDelete,
        W1: walkUpAndDiscovery, H2: dualHome, H3: workspaceStorage }[scenario];
    let observed, primaryError;
    try {
        runtime.auth = await openControllerSession(runtime);
        runtime.probes = new ProbeRobots(runtime);
        await runtime.probes.setup({ includeVictim: !['H2', 'H3', 'I9', 'W1'].includes(scenario) });
        observed = await operation(runtime);
    }
    catch (error) {
        primaryError = error;
    }
    finally {
        let cleanupFailed = false;
        // An unproven native terminal still owns the robot/home/project. Keep its
        // exact creation receipts for operator recovery instead of deleting it.
        const retained = runtime.retainedNativeTerminal || primaryError?.evidence?.nativeTerminal?.cleanupConfirmed === false;
        if (runtime.retainedNativeTerminal && primaryError) primaryError.evidence = {
            ...primaryError.evidence, nativeTerminal: runtime.retainedNativeTerminal,
        };
        try { if (runtime.probes && !retained) await runtime.probes.cleanup(); } catch { cleanupFailed = true; }
        try { if (runtime.auth) await runtime.auth.close(); } catch { cleanupFailed = true; }
        if (cleanupFailed) {
            const error = Object.assign(new Error('Controller cleanup failed.'), { code: 'CONTROLLER_CLEANUP_FAILED' });
            error.evidence = { ...primaryError?.evidence, primaryFailureCode: primaryError?.code,
                controllerCleanup: { ok: false }, receipts: runtime.receipts };
            throw error;
        }
    }
    if (primaryError) {
        if (primaryError.code === 'ACCEPTANCE_PENDING') {
            assert.deepEqual(await runtime.verify(), identity, 'Runtime identity changed during the scenario.');
            primaryError.evidence = { identity, observed: primaryError.evidence, modelSetup: runtime.probes.evidence,
                receipts: runtime.receipts };
        }
        throw primaryError;
    }
    // Refuse success if the selected runtime changed during observation.
    assert.deepEqual(await runtime.verify(), identity, 'Runtime identity changed during the scenario.');
    return { sentinel: SENTINEL, scenario, identity, observed, modelSetup: runtime.probes.evidence, receipts: runtime.receipts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        if (process.argv.length === 3 && process.argv[2] === '--help') console.log(HELP);
        else {
            const options = argumentsFrom(process.argv.slice(2));
            assert.deepEqual(Object.keys(options).sort(), ['config', 'scenario']);
            const config = JSON.parse(await fs.readFile(options.config, 'utf8'));
            console.log(JSON.stringify(await runControllerScenario(config, options.scenario)));
        }
    } catch (error) {
        console.error(JSON.stringify({ status: error.code === 'ACCEPTANCE_PENDING' ? 'PENDING' : 'FAILED',
            code: ['ACCEPTANCE_PENDING', 'CONTROLLER_PREREQUISITE', 'CONTROLLER_CLEANUP_FAILED'].includes(error.code) ? error.code : 'CONTROLLER_ASSERTION_FAILED',
            scenario: error.scenario, evidence: error.evidence,
            message: 'Controller acceptance did not complete; no success sentinel issued.' }));
        process.exitCode = 1;
    }
}
