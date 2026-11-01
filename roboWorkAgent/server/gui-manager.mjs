import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { waitForPreparation, preparationCancelled } from './preparation.mjs';
import { ProxyRelay } from './proxy-pool/proxy-relay.mjs';
import { ProxySettings } from './proxy-pool/proxy-settings.mjs';
import { CHROMIUM_POLICY_TARGET, CONTAINER_PROXY_PORT, writeChromiumProxyPolicy } from './proxy-pool/chromium-policy.mjs';
import { NFT_COMMAND, NSENTER_COMMAND, writeContainerFirewallRules } from './proxy-pool/container-firewall.mjs';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'io.assistos.robowork.gui=1';
const GUI_MODES = new Set(['desktop', 'browser']);
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

function normalizeBasePath(value) {
    const raw = String(value || '/').trim();
    const leading = raw.startsWith('/') ? raw : `/${raw}`;
    return leading.endsWith('/') ? leading : `${leading}/`;
}

function robotSessionUrl(publicBasePath, robotId) {
    return `${normalizeBasePath(publicBasePath)}api/robots/${robotId}/session/`;
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(250).once('timeout', () => finish(false));
        socket.once('connect', () => finish(true)).once('error', () => finish(false));
    });
}

async function waitForPort(port, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portIsOpen(port)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`service on loopback port ${port} did not become ready`);
}

function httpServiceIsReady(port, requestPath) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const request = http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
            response.resume();
            finish(true);
        });
        request.setTimeout(500, () => { request.destroy(); finish(false); });
        request.once('error', () => finish(false));
    });
}

async function waitForHttpService(port, requestPath, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await httpServiceIsReady(port, requestPath)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`HTTP service on loopback port ${port} did not become ready`);
}

function mappedPort(output) {
    const match = String(output || '').trim().match(/:(\d+)$/u);
    if (!match) throw new Error('could not resolve nested container port');
    return Number(match[1]);
}

function chromiumLanguageFlag(lang) {
    return lang && lang !== 'en-US' ? ` --lang=${lang}` : '';
}

export function buildRobotRunArgs({ robot, mode, dataDir, publicBasePath, images, timezone, locale = null, cwd, toolsPath, shellTools, proxy = null, workspaceRoot, maskEnv = false, homePath = path.join(path.resolve(dataDir), 'robots', robot.id, 'home') }) {
    if (!GUI_MODES.has(mode)) throw new Error('mode must be desktop or browser');
    if (!path.isAbsolute(String(toolsPath || ''))) throw new Error('toolsPath must be an absolute prepared cache path');
    if (proxy && (!Number.isInteger(proxy.relayPort) || proxy.relayPort < 1 || proxy.relayPort > 65535 || !path.isAbsolute(String(proxy.policyFile || '')))) {
        throw new Error('proxy needs a relay port and an absolute policy file');
    }
    if (!ROBOT_ID.test(robot.id)) throw new Error('Invalid robot ID.');
    const homeTarget = `/home/${robot.id}`;
    cwd ||= homeTarget;
    const soulPath = path.join(path.resolve(dataDir), 'robots', robot.id, 'run', 'soul');
    const containerName = `robowork-${mode}-${robot.id}`;
    const subfolder = robotSessionUrl(publicBasePath, robot.id);
    // A proxied Browser container is only created here; its firewall is loaded before it starts.
    const firewalled = Boolean(proxy) && mode === 'browser';
    return {
        containerName,
        image: images[mode],
        subfolder,
        firewalled,
        args: [
            ...(firewalled ? ['create'] : ['run', '-d']), '--log-driver', 'k8s-file', '--ipc', 'none', '--tmpfs', '/dev/shm:rw,size=1g,mode=1777',
            // With a proxy, the container's loopback proxy port reaches the robot's relay on the outer
            // loopback, and nothing else of the outer loopback.
            '--network', `pasta:--no-map-gw${proxy ? `,-T,${CONTAINER_PROXY_PORT}:${proxy.relayPort}` : ''}`,
            '--name', containerName, '--label', MANAGED_LABEL,
            '--label', `io.assistos.robowork.robot-id=${robot.id}`,
            '--label', `io.assistos.robowork.mode=${mode}`,
            '-p', '127.0.0.1::3000', '-p', '127.0.0.1::8100',
            '-e', 'PUID=0', '-e', 'PGID=0', '-e', `TZ=${timezone}`,
            ...(locale ? ['-e', `LC_ALL=${locale.locale}`, '-e', `LANG=${locale.locale}`, '-e', `LANGUAGE=${locale.lang}`] : []),
            '-e', `SUBFOLDER=${subfolder}`, '-e', `TITLE=${robot.name}`,
            '-e', `ROBOTEAM_WORKING_DIRECTORY=${cwd}`, '-e', `ROBOTEAM_SHELL_HOME=${homeTarget}`,
            '-e', `USER=${robot.id}`, '-e', `LOGNAME=${robot.id}`,
            '-e', 'START_DOCKER=false', '-e', 'DISABLE_IPV6=true', '-e', 'PELORUS=true',
            ...(mode === 'browser' ? ['-e', `CHROME_CLI=--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --force-renderer-accessibility${chromiumLanguageFlag(locale?.lang)}`] : []),
            ...(shellTools ? [
                '-e', `PATH=${shellTools.binPath}:/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                '-e', `CODEX_HOME=${homeTarget}/.codex`,
                '-e', `HOME=${homeTarget}`,
                '-e', `XDG_CONFIG_HOME=${homeTarget}/.config`, '-e', `XDG_CACHE_HOME=${homeTarget}/.cache`,
                '-e', `XDG_DATA_HOME=${homeTarget}/.local/share`, '-e', `XDG_STATE_HOME=${homeTarget}/.local/state`,
                '-e', `PI_CODING_AGENT_DIR=${homeTarget}/.pi/agent`,
                '-e', `CLAUDE_CONFIG_DIR=${homeTarget}/.claude`,
            ] : []),
            '-v', `${homePath}:/config`, '-v', `${homePath}:${homeTarget}`,
            '-v', `${soulPath}:/workspace/roboteam-soul`,
            ...(path.resolve(workspaceRoot) === path.resolve(cwd)
                ? ['-v', `${cwd}:${cwd}:rw`]
                : ['-v', `${workspaceRoot}:${workspaceRoot}:ro`, ...(cwd === homeTarget ? [] : ['-v', `${cwd}:${cwd}:rw`])]),
            '--tmpfs', `${workspaceRoot}/.data:ro,size=64k,mode=0555,nosuid,nodev,noexec`, '--tmpfs', `${workspaceRoot}/.ploinky:ro,size=64k,mode=0555,nosuid,nodev,noexec`,
            ...(maskEnv ? ['-v', `/dev/null:${workspaceRoot}/.env:ro`] : []),
            '-w', cwd,
            '-v', `${toolsPath}:/opt/roboteam-tools:ro`,
            ...(proxy ? ['-v', `${proxy.policyFile}:${CHROMIUM_POLICY_TARGET}:ro`] : []),
            ...(shellTools ? [
                '-v', `${shellTools.path}:${path.dirname(shellTools.binPath)}:ro`,
                ...Object.values(shellTools.agents).flatMap(agent => ['-v', `${agent.path}:${agent.path}:ro`]),
            ] : []),
            images[mode],
        ],
    };
}

export class GuiManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.workspaceRoot = path.resolve(options.workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '/workspace');
        this.publicBasePath = normalizeBasePath(options.publicBasePath || '/base-agent-additional-server/roboWorkAgent/3001/');
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.execFileImpl = options.execFileImpl || execFileAsync;
        this.nsenterCommand = options.nsenterCommand || NSENTER_COMMAND;
        this.nftCommand = options.nftCommand || NFT_COMMAND;
        this.maxActive = Math.max(1, Math.min(8, Number(options.maxActive) || 8));
        this.images = { browser: options.browserImage || 'docker.io/assistos/roboteam-browser:runtime', desktop: options.desktopImage || 'docker.io/assistos/roboteam-desktop:runtime' };
        this.timezone = options.timezone || 'UTC';
        this.toolCache = options.toolCache;
        this.homeOps = options.homeOps;
        this.prepareRobot = options.prepareRobot;
        this.getRobot = options.getRobot;
        this.hasActiveRun = options.hasActiveRun || (() => false);
        this.proxyPool = options.proxyPool || null;
        this.proxyPolicyDir = path.join(this.dataDir, 'proxy-pool');
        this.proxySettings = options.proxySettings || new ProxySettings({ file: path.join(this.proxyPolicyDir, 'settings.json') });
        this.createRelay = options.createRelay || (upstream => new ProxyRelay(upstream));
        this.waitForSession = options.waitForSession || (session => Promise.all([
            waitForPort(session.sessionPort), waitForHttpService(session.mcpPort, session.mode === 'desktop' ? '/health' : '/mcp'),
        ]));
        this.sessions = new Map();
        this.pending = new Map();
        this.shuttingDown = false;
    }

    async _podman(args, timeout = 120000) {
        return this.execFileImpl(this.podmanCommand, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: process.env });
    }

    async initialize() {
        const result = await this._podman(['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', 'json']);
        for (const record of JSON.parse(result.stdout || '[]')) {
            const id = String(record.Id || record.ID || '');
            if (!id) continue;
            const detail = JSON.parse((await this._podman(['inspect', id])).stdout)[0];
            const name = String(detail?.Name || '').replace(/^\//u, '');
            if (detail?.Config?.Labels?.['io.assistos.robowork.gui'] !== '1'
                || !/^robowork-(browser|desktop)-[a-z0-9][a-z0-9-]{2,63}$/u.test(name)) continue;
            await this._podman(['rm', '-f', id], 30000);
        }
    }

    _serialize(robotId, operation) {
        if (!ROBOT_ID.test(robotId)) return Promise.reject(new Error('Invalid robot ID.'));
        const previous = this.pending.get(robotId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.pending.set(robotId, current);
        return current.finally(() => { if (this.pending.get(robotId) === current) this.pending.delete(robotId); });
    }

    async resolveCwd(robotId, value) {
        const homeTarget = `/home/${robotId}`;
        if (!value || value === homeTarget) return homeTarget;
        if (!path.isAbsolute(value)) throw new Error('cwd must be an absolute workspace path');
        const candidate = await fs.realpath(value);
        const root = await fs.realpath(this.workspaceRoot);
        const relative = path.relative(root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative) || ['.data', '.ploinky'].includes(relative.split(path.sep)[0])) {
            throw new Error('CWD_REFUSED');
        }
        if (!(await fs.stat(candidate)).isDirectory()) throw new Error('cwd must reference a directory');
        return candidate;
    }

    status(robotId) {
        const session = this.sessions.get(robotId);
        return session ? { state: session.state, mode: session.mode, sessionUrl: session.sessionUrl, cwd: session.cwd } : { state: 'stopped', mode: null, sessionUrl: null, cwd: null };
    }

    activeSession(robotId) { return this.sessions.get(robotId) || null; }
    activePort(robotId) { return this.sessions.get(robotId)?.sessionPort || null; }

    async proxyAssignments({ robotIds = null } = {}) {
        const useProxy = await this.proxySettings.useProxy();
        if (!this.proxyPool) return { available: false, active: false, useProxy, assignments: [] };
        const listing = await this.proxyPool.assignments(robotIds);
        const assignments = [];
        for (const assignment of listing.assignments) {
            if (!ROBOT_ID.test(assignment.subject)) continue;
            try {
                await this.getRobot(assignment.subject);
                assignments.push(assignment);
            } catch (error) {
                if (error.code !== 'UNKNOWN_ROBOT') throw error;
                // Only this consumer's orphaned lease is released; proxyAgent binds the caller.
                await this.proxyPool.release(assignment.subject);
            }
        }
        return { available: listing.available, active: listing.active, useProxy, assignments };
    }

    releaseProxy({ robotId }) {
        return this._serialize(robotId, async () => {
            if (this.status(robotId).state !== 'stopped') {
                throw Object.assign(new Error('stop the robot workstation before releasing its proxy'), { code: 'ROBOT_BUSY', statusCode: 409 });
            }
            await this.getRobot(robotId);
            return { released: this.proxyPool ? await this.proxyPool.release(robotId) : false };
        });
    }
    _result(session) {
        return { ...this.status(session.robotId), mcpPort: session.mcpPort };
    }

    ensure({ robotId, mode, cwd: cwdValue, codingAgents = [], allowReplace = false }) {
        return this._serialize(robotId, async () => {
            if (this.shuttingDown) throw new Error('GUI service is stopping');
            if (!GUI_MODES.has(mode)) throw new Error('mode must be desktop or browser');
            if (!Array.isArray(codingAgents) || codingAgents.some(name => !['codex', 'opencode', 'pi', 'claude'].includes(name))) throw new Error('Invalid coding agents');
            const robot = await this.getRobot(robotId);
            const cwd = await this.resolveCwd(robotId, cwdValue);
            const codingAgentsKey = codingAgents.join(',');
            const lease = this.proxyPool && await this.proxySettings.useProxy() ? await this.proxyPool.lease(robotId, robot.name) : null;
            const upstream = lease?.upstream || null;
            const locale = upstream ? lease.locale : null;
            const proxyKey = upstream ? `${upstream.id}@${upstream.host}:${upstream.port}` : '';
            const localeKey = locale ? `${locale.timezone}|${locale.locale}` : '';
            let existing = this.sessions.get(robotId);
            if (existing?.state === 'failed') { this.sessions.delete(robotId); existing = null; }
            if (existing) {
                if (existing.mode === mode && existing.cwd === cwd && existing.codingAgentsKey === codingAgentsKey && existing.proxyKey === proxyKey && existing.localeKey === localeKey) return this._result(existing);
                if (!allowReplace) throw new Error(`robot slot is occupied by its ${existing.mode} container`);
                if (this.hasActiveRun(robotId)) throw new Error('stop the robot run before replacing its container');
                existing.abort?.abort();
                await existing.preparing?.catch(() => {});
                await this._remove(existing);
            }
            // Reserve before awaiting preparation, so parallel robots cannot exceed the limit.
            if ([...this.sessions.values()].filter(value => value.state !== 'failed').length >= this.maxActive) throw new Error(`active robot limit reached (${this.maxActive})`);
            const session = { robotId, mode, cwd, codingAgentsKey, proxyKey, localeKey, state: 'starting', relay: null, containerName: null, abort: new AbortController() };
            this.sessions.set(robotId, session);
            session.preparing = this._prepareSession(session, { robot, codingAgents, mode, cwd, upstream, locale });
            void session.preparing.catch(() => {});
            return this._result(session);
        });
    }

    async ensureReady(input, { signal } = {}) {
        await this.ensure(input);
        const session = this.sessions.get(input.robotId);
        if (!session) throw new Error('GUI preparation was stopped');
        await waitForPreparation(session.preparing, signal);
        if (session.state !== 'running') throw session.error || new Error('GUI preparation failed');
        return this._result(session);
    }

    async _prepareSession(session, { robot, codingAgents, mode, cwd, upstream, locale }) {
        const { robotId } = session;
        const signal = session.abort.signal;
        const check = () => { if (signal.aborted) throw preparationCancelled(); };
        const wait = operation => waitForPreparation(operation, signal);
        try {
            await this.prepareRobot(robotId); check();
            const [tools, shellTools] = await wait(Promise.all([this.toolCache.prepareMode(mode), this.toolCache.prepareShellTools()]));
            check();
            await this.homeOps(robotId, 'shell', { codingAgents, binPath: shellTools.binPath, cacheRoot: this.toolCache.root });
            if (mode === 'desktop') await this.homeOps(robotId, 'desktop-launchers', {});
            check();
            const policyFile = upstream ? await writeChromiumProxyPolicy(this.proxyPolicyDir) : null;
            const firewallFile = upstream && mode === 'browser' ? await writeContainerFirewallRules(this.proxyPolicyDir) : null;
            session.relay = upstream ? this.createRelay(upstream) : null;
            const proxy = session.relay ? { relayPort: await session.relay.listen(), policyFile } : null;
            const maskEnv = await fs.lstat(path.join(this.workspaceRoot, '.env')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
            const plan = buildRobotRunArgs({ robot: { ...robot, id: robotId }, mode, dataDir: this.dataDir, publicBasePath: this.publicBasePath, images: this.images,
                timezone: locale?.timezone || this.timezone, locale, cwd, toolsPath: tools.path, shellTools, proxy, workspaceRoot: this.workspaceRoot, maskEnv });
            Object.assign(session, { containerName: plan.containerName, sessionUrl: plan.subfolder });
            check();
            await this.execFileImpl(this.podmanCommand, plan.args, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: process.env, signal });
            check();
            if (plan.firewalled) await this._startFirewalled(plan.containerName, firewallFile, signal);
            session.sessionPort = mappedPort((await this._podman(['port', plan.containerName, '3000/tcp'])).stdout);
            session.mcpPort = mappedPort((await this._podman(['port', plan.containerName, '8100/tcp'])).stdout);
            await wait(this.waitForSession(session));
            check();
            session.state = 'running';
            return this._result(session);
        } catch (error) {
            try { await this._remove(session); }
            finally {
                session.state = 'failed'; session.error = error;
                this.sessions.set(robotId, session);
            }
            throw error;
        }
    }

    async _startFirewalled(containerName, rulesFile, signal) {
        signal?.throwIfAborted();
        await this._podman(['init', containerName]);
        const namespace = (await this._podman(['inspect', '--format', '{{.NetworkSettings.SandboxKey}}', containerName])).stdout.trim();
        if (!path.isAbsolute(namespace)) throw new Error('could not resolve the container network namespace');
        await this.execFileImpl(this.nsenterCommand, [`--net=${namespace}`, this.nftCommand, '-f', rulesFile], { timeout: 30000, maxBuffer: 1024 * 1024, env: process.env });
        signal?.throwIfAborted();
        await this._podman(['start', containerName]);
    }

    async _remove(session) {
        try {
            if (session.containerName) await this._podman(['rm', '-f', '--ignore', session.containerName], 30000);
        } finally {
            await session.relay?.close();
            session.relay = null;
        }
        this.sessions.delete(session.robotId);
    }

    stop({ robotId, mode }) {
        return this._serialize(robotId, async () => {
            const session = this.sessions.get(robotId);
            if (!session) return { state: 'stopped' };
            if (mode && mode !== session.mode) throw new Error(`robot slot is occupied by its ${session.mode} container`);
            if (this.hasActiveRun(robotId)) throw new Error('stop the robot run before its container');
            session.abort?.abort();
            await session.preparing?.catch(() => {});
            await this._remove(session);
            return { state: 'stopped' };
        });
    }

    async logs({ robotId, tail = 200 }) {
        if (!ROBOT_ID.test(robotId)) throw new Error('Invalid robot ID.');
        const session = this.sessions.get(robotId);
        if (!session?.containerName) return { logs: '' };
        const result = await this._podman(['logs', '--tail', String(Math.max(1, Math.min(1000, Number(tail) || 200))), session.containerName], 30000);
        return { logs: `${result.stdout || ''}${result.stderr || ''}`.slice(-256 * 1024) };
    }

    async shutdown() {
        this.shuttingDown = true;
        await Promise.allSettled([...this.pending.values()]);
        for (const session of this.sessions.values()) session.abort?.abort();
        await Promise.allSettled([...this.sessions.values()].map(session => session.preparing));
        const results = await Promise.allSettled([...this.sessions.values()].map(session => this._remove(session)));
        if (results.some(result => result.status === 'rejected')) throw new Error('GUI cleanup failed');
    }
}

function sessionHeaders(req, port) {
    const headers = { host: `127.0.0.1:${port}` };
    for (const name of ['accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-length', 'content-type', 'cookie', 'origin', 'pragma', 'range', 'user-agent']) {
        if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    headers['x-forwarded-proto'] = 'https';
    return headers;
}

function sessionUpstreamPath(req, publicBasePath) {
    const relative = String(req.url || '/').startsWith('/') ? String(req.url || '/') : `/${req.url}`;
    return `${publicBasePath.slice(0, -1)}${relative}`;
}

export function proxySessionHttp(req, res, port, publicBasePath, rawBody) {
    const upstream = http.request({
        host: '127.0.0.1',
        port,
        method: req.method,
        path: sessionUpstreamPath(req, publicBasePath),
        headers: sessionHeaders(req, port),
    }, (response) => {
        const headers = { ...response.headers, 'cache-control': 'no-store' };
        res.writeHead(response.statusCode || 502, headers);
        response.pipe(res);
    });
    upstream.once('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'robot session is unavailable' }));
    });
    // The gate already consumed the stream; send the bytes it verified.
    if (Buffer.isBuffer(rawBody)) upstream.end(rawBody);
    else req.pipe(upstream);
}

function websocketFailure(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}


export function proxySessionWebSocket(req, socket, head, port, publicBasePath) {
    const upstream = net.connect({ host: '127.0.0.1', port });
    upstream.once('connect', () => {
        const headers = [`GET ${sessionUpstreamPath(req, publicBasePath)} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
        for (const name of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'origin', 'user-agent', 'cookie']) {
            const value = req.headers[name];
            if (value) headers.push(`${name}: ${value}`);
        }
        upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.once('error', () => websocketFailure(socket, 502, 'Bad Gateway'));
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
}
