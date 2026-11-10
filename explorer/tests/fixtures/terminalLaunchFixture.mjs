import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [workspace, source, publishedPort, nonce] = process.argv.slice(2);
assert.equal(fs.realpathSync(workspace), workspace);
assert.equal(source, path.join(workspace, 'fixture-source'));
assert.match(nonce, /^[a-f0-9]{32}$/);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
process.env.PLOINKY_AGENT_RUNTIME_ROOT = '/opt/ploinky/Agent';
process.env.PLOINKY_AGENT_ID = 'agent:AchillesIDE/roboWorkAgent';
// The browser reaches the Box through the published host port; the routed origin
// (and so the CSRF binding) must name that exact port.
if (process.env.PLOINKY_ROUTER_HOST_PORT === undefined) process.env.PLOINKY_ROUTER_HOST_PORT = publishedPort;
assert.equal(process.env.PLOINKY_ROUTER_HOST_PORT, publishedPort);

const CORE_IMPORTS = ['cli/sandbox/networkIdentity.js', 'cli/sandbox/networkContract.js', 'cli/sandbox/routerAuthorityAttestation.js',
    'cli/utils/runtime/controllerStateGuards.js', 'cli/sandbox/edgeGeneration.js', 'cli/server/edgeRoutePlan.js',
    'cli/server/routerHandlers.js', 'cli/utils/security/masterKey.js', 'cli/server/handlers/webtty.js',
    'cli/server/browserMutationSecurity.js', 'core-services/webtty/cwd.mjs'];
const core = (name) => import(`/opt/ploinky/${name}`);
const app = (name) => import(pathToFileURL(path.join(source, name)).href);
const [{ NETWORK_LABELS, workspaceNetworkIdentity }, { NETWORK_SCHEMA_VERSION },
    { managedImageUserNamespace }, { controllerGuardMounts, controllerGuardTargets },
    { initializeFreshEdgeRoutingSources, applyEdgeRoutingGeneration }, { resolveEdgeRoutePlan, agentPortPlan },
    { buildHttpRouteAuthInfoHeader }, { deriveAgentRequestSecret }, { WebttyHomeProfileProvider },
    { WebttySessionManager }, { RuntimeRecordStore }, { createHomeMountBroker }, { handleWebtty }, { mintBrowserCsrfToken },
    { RobotPaths }, { createTerminalProfiles, ensureTerminalStub }, { createRoboWorkServer }] = await Promise.all([
    core('cli/sandbox/networkIdentity.js'), core('cli/sandbox/networkContract.js'),
    core('cli/sandbox/routerAuthorityAttestation.js'), core('cli/utils/runtime/controllerStateGuards.js'),
    core('cli/sandbox/edgeGeneration.js'), core('cli/server/edgeRoutePlan.js'),
    core('cli/server/routerHandlers.js'), core('cli/utils/security/masterKey.js'), core('cli/server/webtty/homeProfileProvider.mjs'),
    core('cli/server/webtty/sessionManager.mjs'), core('cli/server/webtty/runtimeRecords.mjs'), core('cli/server/webtty/homeMountBroker.mjs'),
    core('cli/server/handlers/webtty.js'), core('cli/server/browserMutationSecurity.js'),
    app('roboWorkAgent/server/robot-paths.mjs'), app('roboWorkAgent/server/terminal-profiles.mjs'),
    app('roboWorkAgent/server/http-server.mjs'),
]);
process.env.PLOINKY_AGENT_SECRET = deriveAgentRequestSecret(process.env.PLOINKY_AGENT_ID);

const podman = '/usr/bin/podman';
// The runner verifies each digest in the host store and seeds the nested store by local
// save/load of the image ID, so the nested store holds these exact IDs without repo digests.
const NODE_IMAGE = '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1';
const ROBOT_IMAGE = 'b6f2e1ecdf00d4dcf3da0156b7352b26189501dbae856f2a7222b2b9a4fda9ea';
const targets = [];
const privateRoot = path.join(workspace, '.data/.private/roboWorkAgent');
const project = path.join(workspace, 'projects', 'Sample Ω project', 'nested');
const relativeProject = path.relative(workspace, project);
const home = path.join(privateRoot, 'robots/robot-a/home');
const hash = workspaceNetworkIdentity(workspace).hash;
const owner = { id: 'local:admin', username: 'admin', roles: ['admin'] };
const agentName = 'terminalTarget';
const stamp = crypto.randomBytes(8).toString('hex');

function run(args, { allowFailure = false } = {}) {
    const result = spawnSync(podman, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (!allowFailure) assert.equal(result.status, 0, `podman ${args[0]} failed: ${result.stderr || result.error || result.signal}`);
    return result;
}
function inspect(id) { return JSON.parse(run(['container', 'inspect', id]).stdout)[0]; }
function identity(file) { const stat = fs.statSync(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; }
function ownership(file) { const stat = fs.statSync(file); return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }; }
// Known absence for one exact container ID, mirroring exactPodmanInspectAbsent in
// ploinky/cli/server/webtty/agentRuntime.mjs: any timeout, spawn error, signal or
// other failure is not proof of absence.
function inspectAbsent(result, id) {
    if (!result || typeof result.status !== 'number' || result.status !== 125 || result.signal || result.error) return false;
    const stdout = String(result.stdout || '').trim();
    if (stdout !== '' && stdout !== '[]') return false;
    return new RegExp(`^(?:error:\\s*)?(?:no container with name or id ["']?${id}["']? found|no such container:?\\s+["']?${id}["']?|container ["']?${id}["']? does not exist)\\.?$`, 'i')
        .test(String(result.stderr || '').trim());
}
function mountPoints(containerId) {
    const text = run(['container', 'exec', containerId, '/bin/cat', '/proc/1/mountinfo']).stdout;
    return text.split('\n').filter(Boolean).map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
}
function liveProjections() {
    return manager ? [...manager.sessions.values()].map(session => session.recordHandle?.record?.homeProjection).filter(Boolean) : [];
}
function createAgent(agent, image, imageId, mounts, extra = []) {
    const name = `terminal-fixture-${stamp}-${agent}`;
    const instanceId = `${stamp}-${agent}`;
    const enableGeneration = `${stamp}-generation`;
    const labels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION, [NETWORK_LABELS.workspace]: hash,
        [NETWORK_LABELS.contract]: 'a'.repeat(64), [NETWORK_LABELS.instanceId]: instanceId,
        [NETWORK_LABELS.enableGeneration]: enableGeneration,
    };
    const args = ['container', 'create', '--name', name, '--init', '--entrypoint', '/bin/sh'];
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
    args.push(...extra, ...mounts, image, '-c', 'exec sleep 900');
    const id = run(args).stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const record = { type: 'agent', runtime: 'podman', containerId: id, instanceId, enableGeneration,
        repoName: 'AchillesIDE', agentName: agent, auth: { mode: 'sso' } };
    targets.push({ id, name, imageId, labels });
    run(['container', 'start', id]);
    const inspected = inspect(id);
    assert.equal(inspected.Image.replace(/^sha256:/, ''), imageId);
    assert.equal(inspected.State.Running, true);
    return { name, record, pid: inspected.State.Pid };
}

class TcpRelayStream extends EventEmitter {
    constructor(port) {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.terminal = false;
        this.socket = net.connect(port, '127.0.0.1');
        this.socket.on('data', (chunk) => this.emit('data', chunk));
        this.socket.on('end', () => { this.terminal = true; this.emit('end'); });
        this.socket.on('error', (error) => this.emit('error', error));
    }
    write(chunk) { return this.socket.write(chunk); }
    end() {}
    cancel() { this.terminal = true; this.socket.destroy(); }
    abandon() { this.cancel(); }
}
function tcpRelayManager(port) {
    return { async checkout({ lease, authorized }) {
        if (authorized !== true || lease.commit() !== true) throw new Error('stale route generation');
        return { async openRequest() { return new TcpRelayStream(port); }, close() {} };
    } };
}

let manager;
let pinnedProjection;
let providerServer;
let server;
let recordsDirectory;
try {
    for (const [reference, id] of [[NODE_IMAGE, '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1'],
        [ROBOT_IMAGE, 'b6f2e1ecdf00d4dcf3da0156b7352b26189501dbae856f2a7222b2b9a4fda9ea']]) {
        const image = JSON.parse(run(['image', 'inspect', reference]).stdout)[0];
        assert.equal(image.Id.replace(/^sha256:/, ''), id);
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(privateRoot, 'robots/robot-b/home'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.data/roboWorkAgent'), { recursive: true });
    fs.writeFileSync(path.join(home, 'original-marker'), nonce, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(privateRoot, 'robots/robot-b/home/sibling-marker'), nonce, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(workspace, '.data/.private/parent-marker'), nonce, { flag: 'wx', mode: 0o600 });
    fs.symlinkSync(path.join(workspace, '.data/.private/parent-marker'), path.join(home, 'escape'));
    const paths = new RobotPaths({ workspaceRoot: workspace, dataDir: privateRoot });
    const stub = await ensureTerminalStub(paths, 'robot-a');
    const provider = createAgent('roboWorkAgent', ROBOT_IMAGE,
        'b6f2e1ecdf00d4dcf3da0156b7352b26189501dbae856f2a7222b2b9a4fda9ea', ['-v', `${privateRoot}:/data:rw`]);
    const bindings = [{ hostPath: workspace, runtimePath: workspace, readOnly: false },
        { hostPath: project, runtimePath: project, readOnly: false }];
    const guards = controllerGuardMounts(controllerGuardTargets(bindings, { workspaceRoot: workspace }), { workspaceRoot: workspace, bindings });
    const mounts = ['-v', `${workspace}:${workspace}:rw`, '-v', `${project}:${project}:rw`];
    for (const guard of guards) {
        assert.equal(Boolean(guard.replaceExisting), false);
        mounts.push('-v', `${guard.source}:${guard.target}:${guard.readOnly ? 'ro' : 'rw'}`);
    }
    const target = createAgent(agentName, NODE_IMAGE, '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1',
        mounts, ['--userns', managedImageUserNamespace('1000:1000')]);
    run(['container', 'exec', target.record.containerId, '/bin/sh', '-c', 'printf %s "$1" > /tmp/started-marker', 'fixture', nonce]);
    const originalTarget = inspect(target.record.containerId);
    const originalHome = identity(home);
    const originalHomeOwnership = ownership(home);
    const originalProject = identity(project);
    const robots = { require: async (id) => {
        if (!['robot-a', 'robot-b'].includes(id)) throw new Error('unknown robot');
        return { id, name: id === 'robot-a' ? 'Robot A' : 'Robot B' };
    } };
    const forbidden = async () => { throw new Error('live profiles must not prepare an image'); };
    const terminal = createTerminalProfiles({ paths, robots, environment: { list: async () => [], require: forbidden, prepare: forbidden },
        toolCache: { prepareShellTools: forbidden }, homeOperation: forbidden, runtimeBundle: { prepare: forbidden, prepareAla: forbidden } });
    providerServer = createRoboWorkServer({ robots, terminal, runs: {}, environment: {}, internalToken: 'fixture-only' });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    fs.writeFileSync(path.join(workspace, '.ploinky/routing.json'), JSON.stringify({ routes: {
        roboWorkAgent: { repo: 'AchillesIDE', agent: 'roboWorkAgent', container: provider.name, hostPath: path.join(source, 'roboWorkAgent') },
    } }));
    fs.writeFileSync(path.join(workspace, '.ploinky/agents.json'), JSON.stringify({ [provider.name]: provider.record, [target.name]: target.record }));
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'terminal-fixture' });
    const plan = resolveEdgeRoutePlan({ req: { method: 'GET', url: '/webtty/', headers: { host: `127.0.0.1:${publishedPort}` } } });
    assert.equal(plan.ok, true, plan.code);
    const homeProfiles = new WebttyHomeProfileProvider({ workspaceRoot: workspace, relayManager: tcpRelayManager(providerServer.address().port) });
    const broker = createHomeMountBroker();
    recordsDirectory = path.join(workspace, '.ploinky/terminal-fixture-records');
    const store = new RuntimeRecordStore({ directory: recordsDirectory, homeMountBroker: broker });
    manager = new WebttySessionManager({ workspaceRoot: workspace, homeProfiles, recordStore: store, homeMountBroker: broker, agentProviderAvailable: true,
        auth: { validateLease: async () => ({ ok: true }) } });
    assert.equal((await manager.initialize()).ok, true);
    // Diagnostics only: the handler maps unexpected failures to a generic 503.
    for (const method of ['discoverTargets', 'create']) {
        const original = manager[method].bind(manager);
        manager[method] = async (...args) => {
            try { return await original(...args); } catch (error) {
                process.stderr.write(`fixture ${method} failed: ${error?.code || ''} ${error?.category || ''} ${error?.stack || error}\n`);
                throw error;
            }
        };
    }
    const plugin = JSON.parse(fs.readFileSync(path.join(source, 'roboWorkAgent/IDE-plugins/terminal-profile-source/config.json')));
    plugin.agent = 'roboWorkAgent';
    const html = fs.readFileSync(path.join(source, 'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.html'), 'utf8');
    const page = `<!doctype html><meta charset="utf-8"><button id="open-terminal">Open Terminal Here</button><dialog id="dialog">${html}</dialog><script>window.__moduleLoad='pending';window.addEventListener('error',()=>{if(window.__moduleLoad==='pending')window.__moduleLoad='failed';});</script><script type="module" onerror="window.__moduleLoad='failed'">
        import {FileExp} from '/source/explorer/web-components/pages/file-exp/file-exp.js';
        import {TerminalTargetModal} from '/source/explorer/web-components/modals/terminal-target-modal/terminal-target-modal.js';
        const dialog = document.querySelector('#dialog'); let modal;
        window.assistOS={workspace:{appPlugins:{'terminal-profiles:source':[${JSON.stringify(plugin)}]}},UI:{
            showModal:async (_name,props)=>{try{modal=new TerminalTargetModal(dialog,()=>{},props); dialog.showModal(); await modal.afterRender();}catch(error){console.error('showModal failed: '+(error&&error.stack||error));throw error;}},
            closeModal:()=>dialog.close()}};
        dialog.addEventListener('click',event=>{const button=event.target.closest('[data-local-action]');if(button&&modal){const action=button.dataset.localAction;if(action==='selectTarget')modal.selectTarget(button);else if(typeof modal[action]==='function')modal[action]();}});
        document.querySelector('#open-terminal').onclick=()=>FileExp.prototype.openTerminalHere.call({}, {dataset:{entryPath:${JSON.stringify(`/${relativeProject}`)}}}).then(opened=>{if(opened!==true)console.error('openTerminalHere refused');});
        window.__moduleLoad='ok';
    </script>`;
    server = http.createServer(async (req, res) => {
        try {
            req.user = req.headers['x-fixture-member'] === '1' ? { id: 'local:member', roles: ['user'] } : owner;
            req.authMode = 'sso'; req.authChannel = 'browser'; req.sessionId = 'fixture-session';
            const url = new URL(req.url, `http://127.0.0.1:${publishedPort}`);
            if (url.pathname === '/') {
                const csrf = mintBrowserCsrfToken({ req, routePlan: plan, sessionId: req.sessionId });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `ploinky_browser_csrf=${csrf}; Path=/; SameSite=Strict` });
                return res.end(page);
            }
            if (url.pathname === '/fixture/result') {
                const deadline = Date.now() + 20_000;
                const proofFile = path.join(project, 'terminal-proof');
                while ((!fs.existsSync(proofFile) || !fs.readFileSync(proofFile, 'utf8').includes('escape:0')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
                const after = inspect(target.record.containerId);
                const writeback = fs.existsSync(path.join(home, 'browser-writeback')) && fs.readFileSync(path.join(home, 'browser-writeback'), 'utf8') === nonce;
                const proof = fs.existsSync(proofFile) ? fs.readFileSync(proofFile, 'utf8') : '';
                const expected = `${project}\n${originalProject.dev}:${originalProject.ino}\n${originalHome.dev}:${originalHome.ino}\n${nonce}${nonce}sibling:0\nparent:0\nescape:0\n`;
                const ok = writeback && after.Id === originalTarget.Id && after.State.Pid === originalTarget.State.Pid
                    && after.Image === originalTarget.Image && JSON.stringify(identity(home)) === JSON.stringify(originalHome)
                    && JSON.stringify(ownership(home)) === JSON.stringify(originalHomeOwnership)
                    && JSON.stringify(identity(project)) === JSON.stringify(originalProject) && fs.readdirSync(stub).length === 0 && proof === expected;
                res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok, writeback, proof, expected, homeOwnership: ownership(home), originalHomeOwnership }));
            }
            if (url.pathname === '/fixture/projection') {
                const projections = liveProjections();
                if (projections.length !== 1 || projections[0].stage !== 'attached' || (pinnedProjection && JSON.stringify(pinnedProjection) !== JSON.stringify(projections[0]))) {
                    res.writeHead(409, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ count: projections.length, stages: projections.map(item => item.stage) }));
                }
                pinnedProjection = JSON.parse(JSON.stringify(projections[0]));
                res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ receipt: pinnedProjection }));
            }
            if (url.pathname.startsWith('/source/')) {
                const file = path.resolve(source, `.${url.pathname.slice('/source'.length)}`);
                if (!file.startsWith(`${source}/`)) { res.writeHead(404); return res.end(); }
                let content;
                try { content = fs.readFileSync(file); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    res.writeHead(404); return res.end();
                }
                res.writeHead(200, { 'content-type': /\.(?:mjs|js)$/.test(file) ? 'text/javascript' : 'text/plain' }); return res.end(content);
            }
            if (url.pathname.startsWith('/base-agent-additional-server/roboWorkAgent/3001/')) {
                const catalogPlan = agentPortPlan({ req, host: plan.host, listener: plan.listener || 'public', parsedUrl: url,
                    hostSelection: plan.hostSelection, routes: plan.snapshot.routing.routes, snapshot: plan.snapshot, lease: plan.lease, requestTarget: req.url });
                assert.equal(catalogPlan.ok, true);
                const headers = buildHttpRouteAuthInfoHeader(req, catalogPlan.parsedUrl, catalogPlan.authDefinition, { routePath: catalogPlan.unmatchedSuffix });
                const upstream = http.request({ host: '127.0.0.1', port: providerServer.address().port,
                    path: catalogPlan.unmatchedSuffix, method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
                upstream.on('error', error => res.destroy(error)); return upstream.end();
            }
            if (await handleWebtty(req, res, url, { manager, routePlan: plan })) return;
            res.writeHead(404); res.end();
        } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error.code || error.message)); }
    });
    await new Promise((resolve) => server.listen(8080, '0.0.0.0', resolve));
    const sourceFiles = ['explorer/web-components/pages/file-exp/file-exp.js',
        'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.js',
        'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.html',
        'explorer/utils/liveSessionSource.mjs', 'roboWorkAgent/server/terminal-profiles.mjs',
        'roboWorkAgent/server/http-server.mjs', 'roboWorkAgent/manifest.json',
        'roboWorkAgent/IDE-plugins/terminal-profile-source/config.json'];
    const sources = Object.fromEntries(sourceFiles.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]));
    const coreDirectory = '/opt/ploinky/cli/server/webtty';
    const coreSources = Object.fromEntries([
        ...fs.readdirSync(coreDirectory).filter(name => /\.(?:mjs|js|py)$/.test(name)).map(name => `cli/server/webtty/${name}`),
        ...CORE_IMPORTS,
    ].sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(`/opt/ploinky/${name}`)).digest('hex')]));
    process.stdout.write(`${JSON.stringify({ phase: 'ready', privateRoot, privateParent: path.dirname(privateRoot), sources, coreSources })}\n`);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) { if (JSON.parse(line).action === 'finish') break; }
} finally {
    const projections = pinnedProjection ? [pinnedProjection] : liveProjections();
    if (pinnedProjection) {
        assert.equal(liveProjections().length, 1, 'launched session projection must still be live before close');
        assert.ok(mountPoints(pinnedProjection.target.containerId).includes(pinnedProjection.destination.path), 'projection mount must be present before close');
    }
    await manager?.closeAll();
    if (recordsDirectory && fs.existsSync(recordsDirectory)) assert.deepEqual(fs.readdirSync(recordsDirectory), []);
    for (const projection of projections) {
        assert.equal(projection.stage, 'attached');
        run(['container', 'exec', projection.target.containerId, '/bin/sh', '-c', 'test ! -e "$1" && test ! -L "$1"', 'fixture', projection.destination.path]);
        assert.ok(!mountPoints(projection.target.containerId).includes(projection.destination.path), 'projection mount must be gone after close');
    }
    if (pinnedProjection) assert.equal(projections.length, 1, 'exactly one projection receipt is expected for the launched session');
    if (server) await new Promise(resolve => server.close(resolve));
    if (providerServer) await new Promise(resolve => providerServer.close(resolve));
    for (const target of targets.reverse()) {
        const current = inspect(target.id);
        assert.equal(current.Id, target.id); assert.equal(current.Name.replace(/^\//, ''), target.name);
        assert.equal(current.Image.replace(/^sha256:/, ''), target.imageId);
        for (const [key, value] of Object.entries(target.labels)) assert.equal(current.Config.Labels[key], value);
        run(['container', 'rm', '-f', target.id]);
        const absence = run(['container', 'inspect', target.id], { allowFailure: true });
        assert.equal(inspectAbsent(absence, target.id), true, `container ${target.id} absence not proven: ${absence.status} ${absence.signal || absence.error || absence.stderr}`);
    }
    process.stdout.write(`${JSON.stringify({ phase: 'closed', cleanup: true })}\n`);
}
