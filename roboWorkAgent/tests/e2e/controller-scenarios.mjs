import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { argumentsFrom } from './isolation.mjs';
import { ControllerRuntime } from './controller/runtime.mjs';
import { SENTINEL, assertNoAgentExec, assertVictimUnchanged, assertDualHome, assertDeleted, pending } from './controller/contracts.mjs';

export const HELP = `Usage: node controller-scenarios.mjs --config <private-json> --scenario <I9|I11|H2|H3>
Run on the selected apparatus host, with its existing Box. No SSH, model, or browser is launched.
Config: engine (podman/docker), canonical fixture host path, workspace in-Box path,
box {id,image,startedAt}, rt/rw immutable IDs, ploinkyRoot/ploinkyRevision,
attacker/victim robot IDs, sources [{role,root,revision,subdir,runtimePath}].
Exactly rt (subdir roboTeamAgent), rw (roboWorkAgent), ala (empty subdir) sources
are required; runtimePath is /code for rt/rw and the actual ALA root in RW.
I11 creates and deletes an initially absent dedicated attacker; victim must exist
with a nonempty <=4096-byte marker-B. H2 needs gui {browser,desktop} exact IDs
for existing victim GUI containers. Config contains identities, never credentials
or result overrides. I2/I8/I10/P1 currently exit nonzero ACCEPTANCE_PENDING.
Evidence contains hashes, identities and completed assertions only. A sentinel
proves this invocation's selected scenario, never the entire Acceptance suite.`;

async function manifests(runtime) {
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

async function safeDelete(runtime) {
    const { attacker, victim } = runtime.config;
    const before = await runtime.snapshot(victim);
    // A preexisting ID can belong to a real robot. Never adopt or delete it.
    await runtime.node(runtime.config.rw, `
        try {fs.lstatSync('/data/robots/'+input.id); throw Error('Attacker already exists');}
        catch(error) {if(error.code!=='ENOENT') throw error;}
        console.log('true');`, { id: attacker });
    let created = false;
    let operationError;
    try {
        // A failed ensure may still create state. From here cleanup is mandatory.
        created = true;
        const ensure = await runtime.mcp('robot_ensure', { robotId: attacker, name: 'Controller deletion fixture', codingAgents: ['opencode'] });
        assert.equal(ensure.ok, true, 'Unable to create the dedicated attacker.');
        await runtime.node(runtime.config.rw, `
            const home='/data/robots/'+input.attacker+'/home';
            const target='/data/robots/'+input.victim+'/home';
            fs.symlinkSync(target,path.join(home,'victim-link'),'dir');
            const expected=fs.readFileSync(path.join(target,'marker-B'));
            if(!fs.readFileSync(path.join(home,'victim-link','marker-B')).equals(expected)) throw Error('Dead positive control');
            console.log('true');`, { attacker, victim });
        const deleted = await runtime.mcp('robot_delete', { robotId: attacker });
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
            const cleanup = await runtime.mcp('robot_delete', { robotId: attacker });
            assertDeleted(cleanup);
        }
        assertVictimUnchanged(before, await runtime.snapshot(victim));
    }
    if (operationError) throw operationError;
    return { victim: before, attackerAbsent: true, positiveControl: 'planted link reads victim marker in privileged RoboWork shell' };
}

async function dualHome(runtime) {
    const { victim, gui } = runtime.config;
    assert.ok(gui, 'H2 requires exact Browser and Desktop IDs.');
    const evidence = [];
    for (const mode of ['browser', 'desktop']) {
        const id = gui[mode]; assert.match(id || '', /^[a-f0-9]{64}$/u);
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
    }
    return evidence;
}

async function workspaceStorage(runtime) {
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
    if (!['I9', 'I11', 'H2', 'H3'].includes(scenario)) {
        pending(scenario, 'Controller scenario is not fully implemented; authenticated API, sandbox control or lifecycle evidence remains pending.');
    }
    const runtime = new ControllerRuntime(config);
    const identity = await runtime.verify();
    const operation = { I9: manifests, I11: safeDelete, H2: dualHome, H3: workspaceStorage }[scenario];
    const observed = await operation(runtime);
    // Refuse success if the selected runtime changed during observation.
    await runtime.verify();
    return { sentinel: SENTINEL, scenario, identity, observed, receipts: runtime.receipts };
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
            code: error.code === 'ACCEPTANCE_PENDING' ? error.code : 'CONTROLLER_ASSERTION_FAILED',
            scenario: error.scenario, message: 'Controller acceptance did not complete; no success sentinel issued.' }));
        process.exitCode = 1;
    }
}
