import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolCache } from './tool-cache.mjs';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'io.assistos.roboteam.robot=1';
const GUI_MODES = new Set(['desktop', 'browser']);
const ALA_FAILURE_DETAIL_LIMIT = 4096;

function alaFailureMessage(exit, output) {
    const normalized = String(output || '').replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').trim();
    const detail = normalized.length > ALA_FAILURE_DETAIL_LIMIT
        ? `…${normalized.slice(-ALA_FAILURE_DETAIL_LIMIT)}`
        : normalized;
    return detail ? `ALA exited with ${exit}: ${detail}` : `ALA exited with ${exit}`;
}

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

export function buildRobotRunArgs({ robot, mode, dataDir, publicBasePath, images, timezone, cwd, toolsPath, codexPath = null }) {
    if (!GUI_MODES.has(mode)) throw new Error('mode must be desktop or browser');
    if (!path.isAbsolute(String(toolsPath || ''))) throw new Error('toolsPath must be an absolute prepared cache path');
    const robotRoot = path.join(path.resolve(dataDir), 'robots', robot.id);
    const containerName = `roboteam-${mode}-${robot.id}`;
    const subfolder = robotSessionUrl(publicBasePath, robot.id);
    return {
        containerName,
        image: images[mode],
        subfolder,
        args: [
            'run', '-d', '--ipc', 'none', '--tmpfs', '/dev/shm:rw,size=1g,mode=1777', '--network', 'pasta',
            '--name', containerName, '--label', MANAGED_LABEL,
            '--label', `io.assistos.roboteam.robot-id=${robot.id}`,
            '--label', `io.assistos.roboteam.mode=${mode}`,
            '-p', '127.0.0.1::3000', '-p', '127.0.0.1::8100',
            '-e', 'PUID=0', '-e', 'PGID=0', '-e', `TZ=${timezone}`,
            '-e', `SUBFOLDER=${subfolder}`, '-e', `TITLE=${robot.name}`,
            '-e', 'START_DOCKER=false', '-e', 'DISABLE_IPV6=true', '-e', 'PELORUS=true',
            ...(mode === 'browser' ? ['-e', 'CHROME_CLI=--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --force-renderer-accessibility'] : []),
            ...(codexPath ? [
                '-e', 'PATH=/opt/roboteam-codex/bin:/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                '-e', 'CODEX_HOME=/config/.codex',
            ] : []),
            '-v', `${path.join(robotRoot, 'home')}:/config`,
            '-v', `${cwd}:/workspace`,
            '-v', `${toolsPath}:/opt/roboteam-tools:ro`,
            ...(codexPath ? ['-v', `${codexPath}:/opt/roboteam-codex:ro`] : []),
            images[mode],
        ],
    };
}

export class RuntimeManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.publicBasePath = normalizeBasePath(options.publicBasePath);
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.alaCommand = options.alaCommand || '/workspace/AdvancedLanguageAgent/bin/ala.mjs';
        this.workspaceRoot = path.resolve(options.workspaceRoot || '/workspace');
        this.hostWorkspaceRoot = options.hostWorkspaceRoot ? path.resolve(options.hostWorkspaceRoot) : null;
        this.maxActive = Math.max(1, Math.min(32, Number(options.maxActive) || 8));
        this.images = {
            desktop: options.desktopImage || 'docker.io/assistos/roboteam-desktop:runtime',
            browser: options.browserImage || 'docker.io/assistos/roboteam-browser:runtime',
        };
        this.timezone = options.timezone || 'Europe/Bucharest';
        this.execFileImpl = options.execFileImpl || execFileAsync;
        this.spawnImpl = options.spawnImpl || spawn;
        this.toolCache = options.toolCache || new ToolCache({
            dataDir: this.dataDir,
            root: options.toolCacheRoot,
            refreshIntervalMs: options.toolRefreshIntervalMs,
            podmanCommand: this.podmanCommand,
            desktopImage: this.images.desktop,
            browserImage: this.images.browser,
        });
        this.sessions = new Map();
        this.tasks = new Map();
        this.latestTask = new Map();
        this.pending = new Map();
    }

    async _podman(args, timeout = 120000) {
        return this.execFileImpl(this.podmanCommand, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: process.env });
    }

    async initialize() {
        await this._podman(['info'], 30000);
        const result = await this._podman(['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', 'json']).catch(() => ({ stdout: '[]' }));
        for (const record of JSON.parse(result.stdout || '[]')) {
            const id = String(record?.Id || record?.ID || '').trim();
            if (id) await this._podman(['rm', '-f', id]).catch(() => {});
        }
    }

    _serialize(robotId, operation) {
        const previous = this.pending.get(robotId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.pending.set(robotId, current);
        return current.finally(() => { if (this.pending.get(robotId) === current) this.pending.delete(robotId); });
    }

    async resolveCwd(value) {
        const requested = String(value || '').trim();
        if (!requested || !path.isAbsolute(requested)) throw new Error('cwd must be an absolute workspace path');
        let candidate = path.resolve(requested);
        try { candidate = await fs.realpath(candidate); } catch (error) {
            if (!this.hostWorkspaceRoot || !candidate.startsWith(`${this.hostWorkspaceRoot}${path.sep}`)) throw error;
            candidate = await fs.realpath(path.join(this.workspaceRoot, path.relative(this.hostWorkspaceRoot, candidate)));
        }
        const root = await fs.realpath(this.workspaceRoot);
        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('cwd must stay inside the enabled Ploinky workspace');
        if (!(await fs.stat(candidate)).isDirectory()) throw new Error('cwd must reference a directory');
        return candidate;
    }

    status(robotId) {
        const session = this.sessions.get(robotId);
        const task = this.taskStatus(robotId);
        return session ? { state: session.state, mode: session.mode, startedAt: session.startedAt, sessionUrl: session.sessionUrl, task } : { state: 'stopped', task };
    }

    activePort(robotId) { return this.sessions.get(robotId)?.sessionPort || null; }

    async ensureContainer(robot, mode, cwdValue, options = {}) {
        return this._serialize(robot.id, async () => {
            const cwd = cwdValue
                ? await this.resolveCwd(cwdValue)
                : path.join(this.dataDir, 'robots', robot.id, 'workspace');
            const codexHome = path.join(this.dataDir, 'robots', robot.id, 'home', '.codex');
            await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
            await fs.chmod(codexHome, 0o700);
            const existing = this.sessions.get(robot.id);
            if (existing) {
                if (existing.mode !== mode) throw new Error(`robot slot is occupied by its ${existing.mode} container`);
                if (existing.cwd === cwd) return existing;
                const activeTask = this.taskStatus(robot.id);
                const activeStates = ['queued', 'starting', 'running', 'stopping'];
                if (activeTask && activeTask.taskId !== options.taskId && activeStates.includes(activeTask.state)) {
                    throw new Error(`robot has an active ${activeTask.type} task; its container cwd cannot be changed`);
                }
                existing.state = 'stopping';
                await this._podman(['rm', '-f', existing.containerName], 30000).catch(() => {});
                this.sessions.delete(robot.id);
            }
            if (this.sessions.size >= this.maxActive) throw new Error(`active robot limit reached (${this.maxActive})`);
            const activeTask = this.taskStatus(robot.id);
            if (activeTask && activeTask.type !== mode && ['queued', 'starting', 'running', 'stopping'].includes(activeTask.state)) throw new Error('robot execution slot is already occupied');
            const [tools, codex] = await Promise.all([
                this.toolCache.prepareMode(mode),
                mode === 'desktop' ? this.toolCache.prepareCodex() : Promise.resolve(null),
            ]);
            const plan = buildRobotRunArgs({ robot, mode, dataDir: this.dataDir, publicBasePath: this.publicBasePath, images: this.images, timezone: this.timezone, cwd, toolsPath: tools.path, codexPath: codex?.path });
            const session = { robotId: robot.id, mode, cwd, state: 'starting', containerName: plan.containerName, startedAt: new Date().toISOString(), sessionUrl: plan.subfolder, sessionPort: null, mcpPort: null };
            this.sessions.set(robot.id, session);
            try {
                await this._podman(plan.args, 10 * 60 * 1000);
                session.sessionPort = mappedPort((await this._podman(['port', plan.containerName, '3000/tcp'])).stdout);
                session.mcpPort = mappedPort((await this._podman(['port', plan.containerName, '8100/tcp'])).stdout);
                await Promise.all([
                    waitForPort(session.sessionPort),
                    waitForHttpService(session.mcpPort, mode === 'desktop' ? '/health' : '/mcp'),
                ]);
                session.state = 'running';
                return session;
            } catch (error) {
                await this._podman(['rm', '-f', plan.containerName]).catch(() => {});
                this.sessions.delete(robot.id);
                throw error;
            }
        });
    }

    async openDesktop(robot, cwd) {
        const session = await this.ensureContainer(robot, 'desktop', cwd);
        return { state: session.state, mode: session.mode, sessionUrl: session.sessionUrl };
    }

    start(robot, mode) { return this.ensureContainer(robot, mode, null).then(() => this.status(robot.id)); }
    stop(robotId) {
        const session = this.sessions.get(robotId);
        return session ? this.stopContainer(robotId, session.mode) : Promise.resolve({ state: 'stopped' });
    }

    _newTask(robot, type, request, trackLatest = true) {
        const task = {
            taskId: crypto.randomUUID(), robotId: robot.id, type, state: 'queued',
            createdAt: new Date().toISOString(), request, output: '', error: null,
            child: null, cancelRequested: false,
            ...(GUI_MODES.has(type) ? { sessionUrl: robotSessionUrl(this.publicBasePath, robot.id) } : {}),
        };
        this.tasks.set(task.taskId, task);
        if (trackLatest) this.latestTask.set(robot.id, task.taskId);
        return task;
    }

    startTask(robot, type, request) {
        const current = this.taskStatus(robot.id);
        if (current && ['queued', 'starting', 'running', 'stopping'].includes(current.state)) throw new Error('robot already has an active task');
        const session = this.sessions.get(robot.id);
        if (session && session.mode !== type) throw new Error(`robot slot is occupied by its ${session.mode} container`);
        if (type === 'simple' && session) throw new Error(`robot slot is occupied by its ${session.mode} container`);
        const task = this._newTask(robot, type, request);
        void this._runTask(robot, task);
        return {
            taskId: task.taskId,
            state: task.state,
            ...(task.sessionUrl ? { sessionUrl: task.sessionUrl } : {}),
        };
    }

    async _runTask(robot, task) {
        try {
            task.state = 'starting';
            task.startedAt = new Date().toISOString();
            const cwd = await this.resolveCwd(task.request.cwd);
            if (task.cancelRequested) throw new Error('task was stopped');
            const codingAgent = task.request.ca || 'codex';
            const codexPromise = codingAgent === 'codex' || codingAgent === 'auto'
                ? this.toolCache.prepareCodex()
                : Promise.resolve(null);
            let mcpAddress = null;
            if (GUI_MODES.has(task.type)) {
                const [, session] = await Promise.all([
                    codexPromise,
                    this.ensureContainer(robot, task.type, cwd, { taskId: task.taskId }),
                ]);
                mcpAddress = `${task.type}=http://127.0.0.1:${session.mcpPort}/mcp`;
            } else {
                await codexPromise;
            }
            if (task.cancelRequested) throw new Error('task was stopped');
            const robotHome = path.join(this.dataDir, 'robots', robot.id, 'home');
            const runtimeDir = path.join(this.dataDir, 'robots', robot.id, 'runtime');
            const codexHome = path.join(robotHome, '.codex');
            await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
            await fs.chmod(codexHome, 0o700);
            await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
            const taskFile = path.join(runtimeDir, `${task.taskId}.prompt`);
            await fs.writeFile(taskFile, task.request.task, { mode: 0o600 });
            const args = ['--home', robotHome, '--cwd', cwd, '--taskFile', taskFile, '--ca', codingAgent];
            if (task.request.skillSets) args.push('--skillSets', task.request.skillSets);
            if (task.request.model) args.push('--model', task.request.model);
            if (mcpAddress) args.push('--MCPServers', mcpAddress);
            task.state = 'running';
            const codex = await codexPromise;
            const childEnv = codex?.binPath
                ? { ...process.env, PATH: `${codex.binPath}:${process.env.PATH || ''}` }
                : process.env;
            const child = this.spawnImpl(this.alaCommand, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
            task.child = child;
            const append = (chunk) => { task.output = `${task.output}${chunk}`.slice(-256 * 1024); };
            child.stdout?.on('data', append); child.stderr?.on('data', append);
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code, signal) => code === 0
                    ? resolve()
                    : reject(new Error(alaFailureMessage(signal || code, task.output))));
            });
            task.state = 'completed';
            task.completedAt = new Date().toISOString();
        } catch (error) {
            if (task.state !== 'stopped') {
                task.state = 'failed'; task.error = String(error?.message || error); task.completedAt = new Date().toISOString();
            }
        } finally { task.child = null; }
    }

    taskStatus(robotId, taskId = null) {
        const id = taskId || this.latestTask.get(robotId);
        const task = id ? this.tasks.get(id) : null;
        if (!task || task.robotId !== robotId) return null;
        const { child, request, cancelRequested, ...status } = task;
        return { ...status, cwd: request.cwd };
    }

    stopTask(robot, expectedType = null) {
        const target = this.taskStatus(robot.id);
        if (target && expectedType && target.type !== expectedType
            && ['queued', 'starting', 'running'].includes(target.state)) {
            throw new Error(`robot has an active ${target.type} task, not a ${expectedType} task`);
        }
        const operation = this._newTask(robot, `stop-${expectedType || 'task'}`, {}, false);
        operation.state = 'running';
        queueMicrotask(() => {
            const internal = target ? this.tasks.get(target.taskId) : null;
            if (internal && (!expectedType || internal.type === expectedType)) {
                internal.cancelRequested = true;
                internal.state = 'stopped'; internal.completedAt = new Date().toISOString(); internal.child?.kill('SIGTERM');
            }
            operation.state = 'completed'; operation.completedAt = new Date().toISOString();
        });
        return { taskId: operation.taskId, state: operation.state };
    }

    resumeTask(robot) {
        const previous = this.taskStatus(robot.id);
        if (!previous || !['desktop', 'browser'].includes(previous.type) || previous.state !== 'stopped') {
            throw new Error('robot has no interrupted GUI task to resume');
        }
        const internal = this.tasks.get(previous.taskId);
        return this.startTask(robot, previous.type, {
            ...internal.request,
            task: `${internal.request.task}\n\nResume after human takeover. Observe the current visible desktop or browser state before acting, preserve the human's changes, and continue the original task from that state.`,
        });
    }

    sessionUrl(robotId, mode) {
        const session = this.sessions.get(robotId);
        if (!session || session.mode !== mode || session.state !== 'running') throw new Error(`${mode} container is not running`);
        return session.sessionUrl;
    }

    async stopContainer(robotId, mode) {
        return this._serialize(robotId, async () => {
            const session = this.sessions.get(robotId);
            if (!session) return { state: 'stopped' };
            if (session.mode !== mode) throw new Error(`robot slot is occupied by its ${session.mode} container`);
            const active = this.taskStatus(robotId);
            if (active && active.type === mode && ['queued', 'starting', 'running'].includes(active.state)) throw new Error(`stop the ${mode} task before its container`);
            session.state = 'stopping';
            await this._podman(['rm', '-f', session.containerName], 30000).catch(() => {});
            this.sessions.delete(robotId);
            return { state: 'stopped' };
        });
    }

    async logs(robotId, tail = 200) {
        const session = this.sessions.get(robotId);
        if (!session) return this.taskStatus(robotId)?.output || '';
        const result = await this._podman(['logs', '--tail', String(Math.max(1, Math.min(1000, Number(tail) || 200))), session.containerName], 30000);
        return `${result.stdout || ''}${result.stderr || ''}`.slice(-256 * 1024);
    }

    async stopAll() {
        for (const task of this.tasks.values()) {
            if (!['queued', 'starting', 'running'].includes(task.state)) continue;
            task.cancelRequested = true;
            task.state = 'stopped';
            task.completedAt = new Date().toISOString();
            task.child?.kill('SIGTERM');
        }
        await Promise.allSettled(Array.from(this.sessions.values()).map((session) => this.stopContainer(session.robotId, session.mode)));
    }
}

export const runtimeManagerInternals = { alaFailureMessage, httpServiceIsReady, normalizeBasePath, robotSessionUrl, MANAGED_LABEL };
