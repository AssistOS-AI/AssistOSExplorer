import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    assertContainerMounts,
    createRouterAdapter,
    POSTGRES_SHUTDOWN_SCRIPT,
    quiesceExplorerQa,
    readLinuxProcess,
    runBounded,
    SHUTDOWN_TIMEOUT_MS,
} from '../../../.github/scripts/quiesce-explorer-qa.mjs';

function fixture({ exitCodes = {}, neverStop = [], postgres = 'shut down' } = {}) {
    const agents = ['dpuAgent', 'explorer', 'onlyOffice', 'roboTeamAgent', 'soul-gateway',
        'default-local-llm', 'umamiAgent', 'webmeetAgent', 'webmeetScribeAgent', 'webmeetStt', 'liveKitServerAgent'];
    const registry = {};
    const containers = new Map();
    for (const [index, agent] of agents.entries()) {
        const id = (index + 1).toString(16).padStart(64, '0');
        const name = `ploinky_qa_${agent}`;
        registry[name] = { type: 'agent', runtime: 'podman', agentName: agent, repoName: 'QA',
            containerId: id, instanceId: `instance-${agent}`, enableGeneration: 'generation-1', containerImage: 'pinned-image' };
        containers.set(id, { Id: id, Name: name, Image: 'image-sha', Mounts: [], HostConfig: { Init: true, Privileged: false },
            State: { Running: true, StartedAt: '2026-09-10T00:00:00Z', ExitCode: 0, OOMKilled: false, Error: '' } });
    }
    const events = [];
    const held = new Set();
    let time = 0;
    let routerAlive = true;
    const agentFor = (id) => Object.values(registry).find((record) => record.containerId === id)?.agentName;
    const stopped = (agent) => !containers.get(registry[`ploinky_qa_${agent}`].containerId).State.Running;
    const mutate = (operation, subject) => {
        assert.ok(held.has('workspace') && held.has('network'));
        assert.equal(held.size, agents.length + 2);
        assert.ok(routerAlive, 'Router remains live for container mutations');
        events.push([operation, subject]);
    };
    const adapters = {
        async withWorkspaceMutationLease(options, work) {
            assert.equal(options.operation, 'qa-backup-quiesce');
            held.add('workspace');
            try { return await work(); } finally { events.push(['release', 'workspace']); held.delete('workspace'); }
        },
        async withMaintenanceLock(name, options, work) {
            assert.ok(held.has('workspace'));
            held.add(name);
            try { return await work(); } finally { events.push(['release', name]); held.delete(name); }
        },
        async withNetworkLifecycleLock(work) {
            held.add('network');
            try { return await work('network-capability'); } finally { events.push(['release', 'network']); held.delete('network'); }
        },
        readRegistry: () => structuredClone(registry),
        listContainerIds: () => [...containers.keys()],
        inspect: (id) => structuredClone(containers.get(id)),
        assertOwnership: (binding, inspection) => {
            assert.equal(inspection.Id, binding.id);
            assert.equal(inspection.Name, binding.name);
            assert.equal(registry[binding.name].instanceId, binding.instanceId);
        },
        assertMounts: () => 'fixture-mount-contract',
        pinRouter: () => ({ router: { pid: 101 }, watchdog: { pid: 100 } }),
        assertRouterAlive: () => assert.ok(routerAlive),
        async prepareTargetedAgentRestart(request) {
            assert.equal(request.networkLifecycleCapability, 'network-capability');
            assert.equal(request.shortAgentName, 'onlyOffice');
            assert.ok(!stopped('dpuAgent'));
            mutate('withdraw', 'onlyOffice');
            return { targetedRestart: { acknowledgement: 'exit-zero-after-drain',
                affectedSelectors: ['agent-root:onlyOffice', 'agent-port:onlyOffice'],
                assertSelectorsInactive: () => true } };
        },
        drainTargetedContainer(name, options) {
            assert.equal(name, 'ploinky_qa_onlyOffice');
            assert.equal(options.acknowledgement, 'exit-zero-after-drain');
            assert.equal(options.timeoutMs, 35_000);
            assert.equal(options.runtime, 'podman');
            assert.equal(options.assertSelectorsInactive(), true);
            assert.equal(options.exists(name), true);
            if (options.isRunning(name)) {
                options.retireControlSocket(name);
                assert.equal(options.signal('podman', name).status, 0);
                const deadline = options.now() + options.timeoutMs;
                while (options.isRunning(name) && options.now() < deadline) options.sleep(100);
            }
            const state = options.inspect().State;
            if (state.Running || state.ExitCode !== 0 || state.OOMKilled || state.Error) throw new Error('drain rejected');
            events.push(['drained', 'onlyOffice']);
        },
        retireRuntimeRelaySocket(name) { mutate('retire-relay', registry[name].agentName); },
        signalContainer(id) {
            const agent = agentFor(id);
            mutate('SIGTERM', agent);
            assert.match(id, /^[a-f0-9]{64}$/);
            if (!neverStop.includes(agent)) {
                containers.get(id).State.Running = false;
                containers.get(id).State.ExitCode = exitCodes[agent] ?? 0;
            }
        },
        shutdownPostgres(id) {
            mutate('postgres-fast-wait-proof', agentFor(id));
            assert.ok(!stopped('umamiAgent'));
            return postgres;
        },
        signalRouter() {
            mutate('SIGTERM', 'Router');
            assert.ok([...containers.values()].every((record) => !record.State.Running));
            routerAlive = false;
        },
        routerExited: () => !routerAlive,
        now: () => time,
        sleep: (ms) => { time += ms; },
    };
    return { adapters, events, registry, containers, held, stopped,
        setRouterAlive: (value) => { routerAlive = value; } };
}

test('QA quiesce withdraws and drains OnlyOffice with live dependencies, stops providers last, and retains locks until Router exits', async () => {
    const f = fixture({ exitCodes: { explorer: 143 } });
    const receipt = await quiesceExplorerQa(f.adapters);
    assert.equal(receipt.result, 'passed');
    assert.equal(receipt.stopped.length, 11);
    const position = (operation, agent) => f.events.findIndex((event) => event[0] === operation && event[1] === agent);
    assert.ok(position('withdraw', 'onlyOffice') < position('retire-relay', 'onlyOffice'));
    assert.ok(position('retire-relay', 'onlyOffice') < position('SIGTERM', 'onlyOffice'));
    assert.ok(position('drained', 'onlyOffice') < position('SIGTERM', 'explorer'));
    assert.ok(position('postgres-fast-wait-proof', 'umamiAgent') < position('SIGTERM', 'umamiAgent'));
    const order = ['webmeetAgent', 'webmeetScribeAgent', 'webmeetStt', 'liveKitServerAgent', 'dpuAgent', 'soul-gateway', 'default-local-llm', 'Router'];
    for (let index = 1; index < order.length; index += 1) {
        assert.ok(position('SIGTERM', order[index - 1]) < position('SIGTERM', order[index]));
    }
    assert.ok(position('SIGTERM', 'Router') < position('release', 'network'));
    assert.equal(f.held.size, 0);
    assert.equal(receipt.stopped.find((item) => item.agent === 'umamiAgent').postgres, 'shut down');
    assert.ok(!JSON.stringify(receipt).includes('containerImage'));
});

for (const [description, options] of [
    ['OnlyOffice times out', { neverStop: ['onlyOffice'] }],
    ['OnlyOffice exits on an unhandled signal', { exitCodes: { onlyOffice: 143 } }],
    ['PostgreSQL has no clean shutdown proof', { postgres: 'in production' }],
]) {
    test(`${description} aborts while providers remain live and never removes or recreates anything`, async () => {
        const f = fixture(options);
        await assert.rejects(quiesceExplorerQa(f.adapters), (error) => error.receipt.result === 'failed');
        assert.ok(!f.stopped('dpuAgent') && !f.stopped('soul-gateway'));
        assert.ok(!f.events.some(([operation, subject]) => operation === 'SIGTERM' && subject === 'Router'));
        assert.equal(f.containers.size, 11);
        assert.equal(f.held.size, 0);
        if (options.postgres) assert.ok(!f.stopped('umamiAgent'));
    });
}

for (const exitCode of [137, 1, 143]) {
    test(`Soul exit ${exitCode} cannot authorize a backup`, async () => {
        const f = fixture({ exitCodes: { 'soul-gateway': exitCode } });
        await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_UNCLEAN_EXIT' });
        assert.ok(!f.stopped('default-local-llm'));
    });
}

test('ordinary SIGTERM is bounded and does not escalate when a consumer stays alive', async () => {
    const f = fixture({ neverStop: ['explorer'] });
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_UNCLEAN_EXIT' });
    assert.equal(f.adapters.now(), SHUTDOWN_TIMEOUT_MS);
    assert.equal(f.events.filter(([operation, agent]) => operation === 'SIGTERM' && agent === 'explorer').length, 1);
    assert.ok(!f.stopped('dpuAgent'));
});

test('OOM evidence rejects even a zero exit', async () => {
    const f = fixture();
    const signal = f.adapters.signalContainer;
    f.adapters.signalContainer = (id) => {
        signal(id);
        if (id === f.registry.ploinky_qa_explorer.containerId) f.containers.get(id).State.OOMKilled = true;
    };
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_UNCLEAN_EXIT' });
});

test('unregistered nested containers are rejected before selector or container mutations', async () => {
    const f = fixture();
    f.containers.set('f'.repeat(64), { Id: 'f'.repeat(64) });
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_UNREGISTERED_CONTAINER' });
    assert.deepEqual(f.events, [['release', 'workspace']]);
});

for (const field of ['instanceId', 'enableGeneration', 'containerId']) {
    test(`registry ${field} drift after selector withdrawal prevents the first signal`, async () => {
        const f = fixture();
        const prepare = f.adapters.prepareTargetedAgentRestart;
        f.adapters.prepareTargetedAgentRestart = async (request) => {
            const transition = await prepare(request);
            f.registry.ploinky_qa_onlyOffice[field] = field === 'containerId' ? 'f'.repeat(64) : 'changed';
            return transition;
        };
        await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_REGISTRY_CHANGED' });
        assert.ok(!f.events.some(([operation]) => operation === 'SIGTERM'));
    });
}

test('same immutable ID restarted during relay retirement is rejected before signaling', async () => {
    const f = fixture();
    const retire = f.adapters.retireRuntimeRelaySocket;
    f.adapters.retireRuntimeRelaySocket = (name) => {
        retire(name);
        f.containers.get(f.registry[name].containerId).State.StartedAt = 'later-start';
    };
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_CONTAINER_CHANGED' });
    assert.ok(!f.events.some(([operation]) => operation === 'SIGTERM'));
});

test('new nested container after retirement is rejected before signaling', async () => {
    const f = fixture();
    const retire = f.adapters.retireRuntimeRelaySocket;
    f.adapters.retireRuntimeRelaySocket = (name) => {
        retire(name);
        f.containers.set('f'.repeat(64), {});
    };
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_UNREGISTERED_CONTAINER' });
    assert.ok(!f.events.some(([operation]) => operation === 'SIGTERM'));
});

for (const field of ['Mounts', 'HostConfig']) {
    test(`${field} changes after retirement are rejected before signaling`, async () => {
        const f = fixture();
        const retire = f.adapters.retireRuntimeRelaySocket;
        f.adapters.retireRuntimeRelaySocket = (name) => {
            retire(name);
            const item = f.containers.get(f.registry[name].containerId);
            if (field === 'Mounts') item.Mounts.push({ Source: '/foreign', Destination: '/root' });
            else item.HostConfig.CapAdd = ['SYS_ADMIN'];
        };
        await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_CONTAINER_CHANGED' });
        assert.ok(!f.events.some(([operation]) => operation === 'SIGTERM'));
    });
}

function mountFixture(agent = 'onlyOffice') {
    const name = `ploinky_QA_${agent}`;
    const binds = [
        { source: `/workspace/.ploinky/container-runtime/${name}/Agent-123-456`, target: '/Agent', ro: true },
        { source: '/opt/ploinky-agentlib', target: '/opt/ploinky-agentlib', ro: true },
        { source: `/workspace/.ploinky/container-runtime/${name}/code-123-456`, target: '/code', ro: false },
        { source: `/workspace/.ploinky/repos/QA/${agent}`, target: `/workspace/.ploinky/repos/QA/${agent}`, ro: false },
        { source: '/workspace/.data/shared', target: '/shared' },
        { source: `/workspace/.data/${agent}`, target: '/root' },
    ];
    const volumes = agent === 'onlyOffice' ? {
        '.data/onlyOffice/data': '/var/www/onlyoffice/Data', '.data/onlyOffice/log': '/var/log/onlyoffice',
        '.data/onlyOffice/lib': '/var/lib/onlyoffice',
    } : agent === 'soul-gateway' ? { '.data/soul-gateway': '/data' } : {};
    const manifest = { volumes, runtime: { resources: agent === 'dpuAgent'
        ? { persistentStorage: { key: 'dpu-data', containerPath: '/dpu-data' } } : {} } };
    const Mounts = binds.map((bind) => ({ Type: 'bind', Source: bind.source, Destination: bind.target, RW: bind.ro !== true }));
    for (const [source, target] of Object.entries(volumes)) Mounts.push({ Type: 'bind', Source: `/workspace/${source}`, Destination: target, RW: true });
    if (agent === 'dpuAgent') Mounts.push({ Type: 'bind', Source: '/workspace/.data/dpu-data', Destination: '/dpu-data', RW: true });
    Mounts.push({ Type: 'bind', Source: `/workspace/.ploinky/run/health-probes/${name}`, Destination: '/run/ploinky-health-probes', RW: true });
    return { binding: { name, agent, record: { config: { binds }, profile: 'default' } }, inspected: { Mounts },
        options: { manifest, realpath: (value) => value } };
}

for (const agent of ['onlyOffice', 'dpuAgent', 'umamiAgent', 'soul-gateway']) {
    test(`${agent} mount validation accepts the observed QA registry, read-only runtime source, and manifest data layout`, () => {
        const f = mountFixture(agent);
        assert.ok(assertContainerMounts(f.binding, f.inspected, f.options));
    });
}

for (const scenario of ['redirected-data', 'data-symlink', 'database-overlay', 'writable-agentlib', 'missing-manifest-volume', 'unknown-writable']) {
    test(`mount preflight rejects ${scenario} before shutdown`, () => {
        const f = mountFixture();
        if (scenario === 'redirected-data') f.inspected.Mounts.find((item) => item.Destination === '/root').Source = '/foreign/root';
        if (scenario === 'data-symlink') f.options.realpath = (value) => value.endsWith('/onlyOffice') ? '/foreign/root' : value;
        if (scenario === 'database-overlay') f.inspected.Mounts.push({ Type: 'bind', Source: '/workspace/.data/foreign', Destination: '/root/postgres', RW: false });
        if (scenario === 'writable-agentlib') f.inspected.Mounts.find((item) => item.Destination === '/opt/ploinky-agentlib').RW = true;
        if (scenario === 'missing-manifest-volume') delete f.options.manifest.volumes['.data/onlyOffice/lib'];
        if (scenario === 'unknown-writable') f.inspected.Mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/new', RW: true });
        assert.throws(() => assertContainerMounts(f.binding, f.inspected, f.options), /^Error: QA_/);
    });
}

test('DPU disappearance during the OnlyOffice drain aborts the sequence', async () => {
    const f = fixture();
    const signal = f.adapters.signalContainer;
    f.adapters.signalContainer = (id) => {
        signal(id);
        f.containers.get(f.registry.ploinky_qa_dpuAgent.containerId).State.Running = false;
    };
    await assert.rejects(quiesceExplorerQa(f.adapters), { code: 'QA_DPU_UNAVAILABLE' });
    assert.ok(!f.stopped('soul-gateway'));
});

function processFixture() {
    const watchdog = '/opt/ploinky/cli/server/Watchdog.js';
    const router = '/opt/ploinky/cli/server/RoutingServer.js';
    const processes = new Map([
        [1, { pid: 1, ppid: 0, startTicks: '1', uid: 1000, cwd: '/workspace', exe: '/run/podman-init',
            argv: ['/run/podman-init', '--', '/usr/local/bin/ploinky-box-entrypoint'] }],
        [2, { pid: 2, ppid: 1, startTicks: '2', uid: 1000, cwd: '/workspace', exe: '/usr/bin/sleep', argv: ['sleep', 'infinity'] }],
        [100, { pid: 100, ppid: 1, startTicks: '100', uid: 1000, cwd: '/workspace', exe: '/usr/bin/node', argv: ['node', watchdog] }],
        [101, { pid: 101, ppid: 100, startTicks: '101', uid: 1000, cwd: '/workspace', exe: '/usr/bin/node', argv: ['node', router] }],
    ]);
    const signals = [];
    const fsApi = {
        readdirSync: () => [...processes.keys()].map(String),
        readFileSync(name) {
            if (name.endsWith('router.pid')) return '100\n';
            if (name.endsWith('/children')) return '2 100\n';
            const pid = Number(name.split('/')[2]);
            return `${processes.get(pid).argv.join('\0')}\0`;
        },
    };
    const adapter = createRouterAdapter({ fsApi, readProcess: (pid) => structuredClone(processes.get(pid) || null),
        signal: (pid, name) => signals.push([pid, name]), uid: 1000 });
    return { adapter, processes, signals };
}

test('Router adapter pins process start identities and signals only its exact child, then proves both processes absent', () => {
    const f = processFixture();
    const pinned = f.adapter.pinRouter();
    f.adapter.signalRouter(pinned);
    assert.deepEqual(f.signals, [[101, 'SIGTERM']]);
    assert.equal(f.adapter.routerExited(pinned), false);
    f.processes.delete(101);
    assert.equal(f.adapter.routerExited(pinned), false);
    f.processes.delete(100);
    assert.equal(f.adapter.routerExited(pinned), true);
});

for (const property of ['startTicks', 'cwd', 'uid', 'ppid']) {
    test(`reused Router PID with changed ${property} is never signaled`, () => {
        const f = processFixture();
        const pinned = f.adapter.pinRouter();
        f.processes.get(101)[property] = 'foreign';
        assert.throws(() => f.adapter.signalRouter(pinned), { code: 'QA_ROUTER_CHANGED' });
        assert.deepEqual(f.signals, []);
    });
}

test('a new Router child during shutdown rejects completion', () => {
    const f = processFixture();
    const pinned = f.adapter.pinRouter();
    f.processes.set(102, { ...f.processes.get(101), pid: 102, startTicks: '102' });
    assert.throws(() => f.adapter.routerExited(pinned), { code: 'QA_ROUTER_CHANGED' });
});

test('unrecognized Box supervisor is refused before any process signal', () => {
    const f = processFixture();
    f.processes.get(1).argv = ['supervisor', 'restart-always'];
    assert.throws(() => f.adapter.pinRouter(), { code: 'QA_BOX_SUPERVISOR_UNPROVEN' });
    assert.deepEqual(f.signals, []);
});

test('an init child replacement cannot authorize Router shutdown', () => {
    const f = processFixture();
    const pinned = f.adapter.pinRouter();
    f.processes.get(2).startTicks = 'replacement';
    assert.throws(() => f.adapter.signalRouter(pinned), { code: 'QA_ROUTER_CHANGED' });
    assert.deepEqual(f.signals, []);
});

test('Linux process parsing uses start ticks after a command name containing parentheses', () => {
    const fields = ['S', '100', ...Array(17).fill('0'), '777', '0'];
    const fsApi = {
        readFileSync(name) {
            if (name.endsWith('/stat')) return `101 (strange (name)) ${fields.join(' ')}`;
            if (name.endsWith('/cmdline')) return 'node\0/opt/ploinky/cli/server/RoutingServer.js\0';
            return 'Uid:\t1000\t1000\t1000\t1000\n';
        },
        realpathSync: (name) => name.endsWith('/cwd') ? '/workspace' : '/usr/bin/node',
    };
    const parsed = readLinuxProcess(101, fsApi);
    assert.equal(parsed.startTicks, '777');
    assert.equal(parsed.ppid, 100);
});

for (const outcome of ['shut down', 'in production', 'shut down in recovery', 'command-failed']) {
    test(`PostgreSQL production helper requires exact clean pg_controldata state: ${outcome}`, () => {
        const calls = [];
        let output = '';
        const context = { require: (name) => name === 'node:fs' ? { realpathSync: (value) => value } : { spawnSync(command, args, options) {
            calls.push({ command, args, options });
            return { status: outcome === 'command-failed' ? 1 : 0,
                stdout: args.includes('pg_controldata') ? `Database cluster state: ${outcome}\n` : '' };
        } }, process: { env: { PGDATA: '/root/postgres', SECRET: 'not-in-receipt' },
            exit: () => { throw new Error('pg-refused'); }, stdout: { write: (value) => { output += value; } } } };
        if (outcome === 'shut down') {
            vm.runInNewContext(POSTGRES_SHUTDOWN_SCRIPT, context);
            assert.equal(output, '{"state":"shut down"}');
            assert.deepEqual(Array.from(calls[0].args), ['postgres', 'pg_ctl', '-D', '/root/postgres', '-m', 'fast', '-w', '-t', '35', 'stop']);
            assert.deepEqual(Array.from(calls[1].args), ['postgres', 'pg_controldata', '-D', '/root/postgres']);
        } else {
            assert.throws(() => vm.runInNewContext(POSTGRES_SHUTDOWN_SCRIPT, context), /pg-refused/);
            assert.equal(output, '');
        }
        assert.ok(calls.every((call) => call.command === 'su-exec' && call.options.killSignal === 'SIGTERM'));
    });
}

test('PostgreSQL preflight refuses a redirected database path before running any database command', () => {
    let commands = 0;
    for (const pgdata of ['/tmp/postgres', '/root/postgres']) {
        const context = { require: (name) => name === 'node:fs' ? { realpathSync: () => '/tmp/postgres' }
            : { spawnSync: () => { commands += 1; } },
        process: { env: { PGDATA: pgdata }, exit: () => { throw new Error('pg-refused'); } } };
        assert.throws(() => vm.runInNewContext(POSTGRES_SHUTDOWN_SCRIPT, context), /pg-refused/);
    }
    assert.equal(commands, 0);
});

test('bounded command failures never expose engine stderr or use a hard kill', () => {
    let captured;
    assert.throws(() => runBounded('podman', ['container', 'inspect', 'a'.repeat(64)], 5_000,
        (command, args, options) => { captured = options; return { status: 1, stderr: 'SECRET=private' }; }),
    (error) => error.code === 'QA_COMMAND_FAILED' && !error.message.includes('private'));
    assert.equal(captured.killSignal, 'SIGTERM');
    assert.equal(captured.timeout, 5_000);
});

test('streamed helper executes its prerequisite guard and emits one sanitized failed receipt on an unsupported host', () => {
    const source = fs.readFileSync(new URL('../../../.github/scripts/quiesce-explorer-qa.mjs', import.meta.url), 'utf8');
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: source, encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: '/not-the-qa-workspace', SECRET: 'not-in-output' },
    });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.code, 'QA_WORKSPACE_INVALID');
    assert.equal(receipt.result, 'failed');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('not-in-output'));
});
