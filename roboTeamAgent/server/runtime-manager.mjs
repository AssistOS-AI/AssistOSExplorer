import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ToolCache } from './tool-cache.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR, MAX_ACTIVE_GUI_ROBOTS, BROWSER_IMAGE, DESKTOP_IMAGE, TIMEZONE } from './constants.mjs';
import { prepareRobotShell } from './robot-shell.mjs';
import { RESUME_REOBSERVE_INSTRUCTION } from './workstation-control-adapter.mjs';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'io.assistos.roboteam.robot=1';
const GUI_MODES = new Set(['desktop', 'browser']);
const ALA_FAILURE_DETAIL_LIMIT = 4096;
const TASK_LOG_TAIL_LIMIT = 1024 * 1024;
const TASK_RESULT_LIMIT = 1024 * 1024;
const ALA_EVENT_PREFIX = '@@ALA_EVENT@@';
const CODING_AGENT_NAMES = Object.freeze(['codex', 'opencode', 'pi']);
const ROBOT_AGENT_STATE_DIRECTORIES = Object.freeze([
    '.codex',
    '.config/opencode',
    '.cache/opencode',
    '.local/share/opencode',
    '.local/state/opencode',
    '.pi/agent',
]);

function appendTail(previous, chunk, limit) {
    const next = `${previous}${chunk}`;
    return next.length > limit ? next.slice(-limit) : next;
}

function createAlaProgressParser(onText, onEvent = () => {}) {
    let buffered = '';
    const consumeLine = (line, terminated) => {
        if (!line.startsWith(ALA_EVENT_PREFIX)) {
            onText(`${line}${terminated ? '\n' : ''}`);
            return;
        }
        try {
            const event = JSON.parse(line.slice(ALA_EVENT_PREFIX.length));
            onEvent(event);
            if (event?.type === 'coding-agent-message' && typeof event.message === 'string') onText(event.message);
        } catch {
            onText(`${line}${terminated ? '\n' : ''}`);
        }
    };
    return {
        push(chunk) {
            buffered += chunk.toString('utf8');
            let newline = buffered.indexOf('\n');
            while (newline >= 0) {
                consumeLine(buffered.slice(0, newline), true);
                buffered = buffered.slice(newline + 1);
                newline = buffered.indexOf('\n');
            }
        },
        finish() {
            if (buffered) consumeLine(buffered, false);
            buffered = '';
        },
    };
}

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

export function buildRobotRunArgs({ robot, mode, dataDir, publicBasePath, images, timezone, cwd, toolsPath, shellTools }) {
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
            'run', '-d', '--log-driver', 'k8s-file', '--ipc', 'none', '--tmpfs', '/dev/shm:rw,size=1g,mode=1777', '--network', 'pasta',
            '--name', containerName, '--label', MANAGED_LABEL,
            '--label', `io.assistos.roboteam.robot-id=${robot.id}`,
            '--label', `io.assistos.roboteam.mode=${mode}`,
            '-p', '127.0.0.1::3000', '-p', '127.0.0.1::8100',
            '-e', 'PUID=0', '-e', 'PGID=0', '-e', `TZ=${timezone}`,
            '-e', `SUBFOLDER=${subfolder}`, '-e', `TITLE=${robot.name}`,
            '-e', 'START_DOCKER=false', '-e', 'DISABLE_IPV6=true', '-e', 'PELORUS=true',
            ...(mode === 'browser' ? ['-e', 'CHROME_CLI=--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --force-renderer-accessibility'] : []),
            ...(shellTools ? [
                '-e', 'PATH=/data/tool-cache/shell/bin:/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                '-e', 'CODEX_HOME=/config/.codex',
                '-e', 'HOME=/config',
                '-e', 'XDG_CONFIG_HOME=/config/.config', '-e', 'XDG_CACHE_HOME=/config/.cache',
                '-e', 'XDG_DATA_HOME=/config/.local/share', '-e', 'XDG_STATE_HOME=/config/.local/state',
                '-e', 'PI_CODING_AGENT_DIR=/config/.pi/agent',
            ] : []),
            '-v', `${path.join(robotRoot, 'home')}:/config`,
            '-v', `${cwd}:/workspace`,
            '-v', `${toolsPath}:/opt/roboteam-tools:ro`,
            ...(shellTools ? ['-v', `${shellTools.root}:/data/tool-cache:ro`] : []),
            images[mode],
        ],
    };
}

export class RuntimeManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || DATA_DIR);
        this.publicBasePath = normalizeBasePath(options.publicBasePath);
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.alaCommand = resolveAlaCommand(options.alaCommand);
        this.workspaceRoot = path.resolve(options.workspaceRoot || '/workspace');
        this.hostWorkspaceRoot = options.hostWorkspaceRoot ? path.resolve(options.hostWorkspaceRoot) : null;
        this.maxActive = Math.max(1, Math.min(32, Number(options.maxActive) || MAX_ACTIVE_GUI_ROBOTS));
        this.images = {
            desktop: options.desktopImage || DESKTOP_IMAGE,
            browser: options.browserImage || BROWSER_IMAGE,
        };
        this.timezone = options.timezone || TIMEZONE;
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
        this.activeTasks = new Map();
        this.taskQueues = new Map();
        this.manualControl = new Map();
        this.pending = new Map();
        this.shuttingDown = false;
        this.messageWaiters = new Map();
        this.deletedRobots = new Set();
        this.skillsets = options.skillsets || null;
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
        const current = previous.catch(() => {}).then(() => {
            if (this.deletedRobots.has(robotId)) throw new Error('robot was deleted');
            return operation();
        });
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
        const queueDepth = (this.taskQueues.get(robotId) || []).filter((id) => this.tasks.get(id)?.state === 'queued').length;
        return session ? { state: session.state, mode: session.mode, startedAt: session.startedAt, sessionUrl: session.sessionUrl, task, queueDepth } : { state: 'stopped', task, queueDepth };
    }

    activePort(robotId) { return this.sessions.get(robotId)?.sessionPort || null; }

    hasUnfinishedTasks(robotId) {
        return Array.from(this.tasks.values()).some((task) => task.robotId === robotId
            && ['queued', 'starting', 'running', 'stopping'].includes(task.state));
    }

    async ensureContainer(robot, mode, cwdValue, options = {}) {
        return this._serialize(robot.id, async () => {
            const cwd = cwdValue
                ? await this.resolveCwd(cwdValue)
                : path.join(this.dataDir, 'robots', robot.id, 'workspace');
            const robotHome = path.join(this.dataDir, 'robots', robot.id, 'home');
            await this._prepareRobotAgentState(robotHome);
            await prepareRobotShell(robotHome);
            const existing = this.sessions.get(robot.id);
            if (existing) {
                if (existing.mode !== mode && !options.taskId) throw new Error(`robot slot is occupied by its ${existing.mode} container`);
                if (existing.mode === mode && existing.cwd === cwd) return existing;
                const activeTask = this.activeTaskStatus(robot.id);
                const activeStates = ['queued', 'starting', 'running', 'stopping'];
                if (activeTask && activeTask.taskId !== options.taskId && activeStates.includes(activeTask.state)) {
                    throw new Error(`robot has an active ${activeTask.type} task; its container cwd cannot be changed`);
                }
                existing.state = 'stopping';
                await this._podman(['rm', '-f', existing.containerName], 30000).catch(() => {});
                this.sessions.delete(robot.id);
            }
            if (this.sessions.size >= this.maxActive) throw new Error(`active robot limit reached (${this.maxActive})`);
            const [tools, shellTools] = await Promise.all([
                this.toolCache.prepareMode(mode),
                mode === 'desktop' ? this.toolCache.prepareShellTools() : Promise.resolve(null),
            ]);
            const plan = buildRobotRunArgs({ robot, mode, dataDir: this.dataDir, publicBasePath: this.publicBasePath, images: this.images, timezone: this.timezone, cwd, toolsPath: tools.path, shellTools });
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
            taskId: (!request.alaSessionId && request.skillSelection?.catalogId) || crypto.randomUUID(), robotId: robot.id, type, state: 'queued',
            createdAt: new Date().toISOString(), request, logTail: '', logSeq: 0,
            logTruncated: false, result: '', error: null,
            child: null, cancelRequested: false,
            ...(GUI_MODES.has(type) ? { sessionUrl: robotSessionUrl(this.publicBasePath, robot.id) } : {}),
        };
        task.alaSessionId = request.alaSessionId || task.taskId;
        task.pendingMessages = [];
        this.tasks.set(task.taskId, task);
        if (trackLatest) this.latestTask.set(robot.id, task.taskId);
        return task;
    }

    _enqueueTask(robot, type, request, { first = false } = {}) {
        if (this.deletedRobots.has(robot.id)) throw new Error('robot was deleted');
        request = structuredClone(request);
        const task = this._newTask(robot, type, request);
        if (type === 'simple') {
            queueMicrotask(() => { if (!this.shuttingDown) void this._runTask(robot, task); });
            return { taskId: task.taskId, state: task.state, queuePosition: 0 };
        }
        const queue = this.taskQueues.get(robot.id) || [];
        if (first) queue.unshift(task.taskId);
        else queue.push(task.taskId);
        this.taskQueues.set(robot.id, queue);
        queueMicrotask(() => void this._drainTaskQueue(robot));
        return {
            taskId: task.taskId,
            state: task.state,
            queuePosition: this.taskQueuePosition(task),
            ...(task.sessionUrl ? { sessionUrl: task.sessionUrl } : {}),
        };
    }

    startTask(robot, type, request) {
        return this._enqueueTask(robot, type, request);
    }

    async _prepareRobotAgentState(robotHome) {
        await Promise.all(ROBOT_AGENT_STATE_DIRECTORIES.map(async (relativePath) => {
            const directory = path.join(robotHome, relativePath);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
        }));
    }

    async _drainTaskQueue(robot) {
        if (this.shuttingDown || this.activeTasks.has(robot.id) || this.manualControl.has(robot.id)) return;
        const queue = this.taskQueues.get(robot.id) || [];
        let task = null;
        while (queue.length > 0 && !task) {
            const candidate = this.tasks.get(queue.shift());
            if (candidate?.state === 'queued' && !candidate.cancelRequested) task = candidate;
        }
        if (queue.length === 0) this.taskQueues.delete(robot.id);
        else this.taskQueues.set(robot.id, queue);
        if (!task) return;
        this.activeTasks.set(robot.id, task.taskId);
        try {
            await this._runTask(robot, task);
        } finally {
            if (this.activeTasks.get(robot.id) === task.taskId) this.activeTasks.delete(robot.id);
            queueMicrotask(() => void this._drainTaskQueue(robot));
        }
    }

    taskQueuePosition(task) {
        if (!task || task.state !== 'queued') return 0;
        const index = (this.taskQueues.get(task.robotId) || []).indexOf(task.taskId);
        return index < 0 ? 0 : index + 1;
    }

    async _runTask(robot, task) {
        if (task.cancelRequested || task.state !== 'queued') return;
        const appendProgress = (chunk) => {
            const previousLength = task.logTail.length;
            task.logTail = appendTail(task.logTail, chunk, TASK_LOG_TAIL_LIMIT);
            if (task.logTail.length < previousLength + String(chunk).length) task.logTruncated = true;
            task.logSeq += 1;
        };
        try {
            task.state = 'starting';
            task.startedAt = new Date().toISOString();
            const cwd = await this.resolveCwd(task.request.cwd);
            if (task.cancelRequested) throw new Error('task was stopped');
            const codingAgent = task.request.ca || 'codex';
            const codingAgentsPromise = codingAgent === 'auto'
                ? this.toolCache.prepareCodingAgents()
                : this.toolCache.prepareCodingAgents([codingAgent]);
            let mcpAddress = null;
            if (GUI_MODES.has(task.type)) {
                const [, session] = await Promise.all([
                    codingAgentsPromise,
                    this.ensureContainer(robot, task.type, cwd, { taskId: task.taskId }),
                ]);
                mcpAddress = `${task.type}=http://127.0.0.1:${session.mcpPort}/mcp`;
            } else {
                await codingAgentsPromise;
            }
            if (task.cancelRequested) throw new Error('task was stopped');
            const robotHome = path.join(this.dataDir, 'robots', robot.id, 'home');
            const runtimeDir = path.join(this.dataDir, 'robots', robot.id, 'runtime');
            await this._prepareRobotAgentState(robotHome);
            await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
            await this._saveTask(task);
            const taskFile = path.join(runtimeDir, `${task.taskId}.prompt`);
            await fs.writeFile(taskFile, task.request.task, { mode: 0o600 });
            if (task.cancelRequested) throw new Error('task was stopped');
            const args = ['--home', robotHome, '--cwd', cwd, '--taskFile', taskFile, '--ca', codingAgent];
            args.push('--session-id', task.alaSessionId, '--control-stdin');
            if (task.request.resumeSession) args.push('--resume-session');
            // Catalog capture belongs to the wrapper's actual execution boundary after queue/cache wait.
            if (this.skillsets) {
                const policyId = task.request.skillPolicyRef || task.alaSessionId;
                await this.skillsets.policies.ensure(robot, policyId, { legacy: task.request.skillSelection });
                task.request.skillPolicyRef = policyId;
                if (task.request.skillSelection) task.legacySkillSelection = task.request.skillSelection;
                delete task.request.skillSelection;
                await this._saveTask(task);
            }
            if (task.request.model) args.push('--model', task.request.model);
            if (mcpAddress) args.push('--MCPServers', mcpAddress);
            task.state = 'running';
            const codingAgents = await codingAgentsPromise;
            const codingAgentPath = CODING_AGENT_NAMES
                .map((name) => codingAgents[name]?.binPath)
                .filter(Boolean)
                .join(':');
            const childEnv = {
                ...process.env,
                ALA_EVENT_STREAM: '1',
                ...(codingAgentPath ? { PATH: `${codingAgentPath}:${process.env.PATH || ''}` } : {}),
            };
            delete childEnv.ROBOTEAM_INTERNAL_TOKEN;
            delete childEnv.ROBOTEAM_TASK_SKILL_SELECTION;
            const child = this.spawnImpl(process.execPath, [fileURLToPath(new URL('./robot-task.mjs', import.meta.url)),
                '--robot', robot.name, ...args], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
            task.child = child;
            child.stdin?.on('error', () => {});
            child.stdout?.on('data', (chunk) => {
                task.result = appendTail(task.result, chunk, TASK_RESULT_LIMIT);
            });
            const progressParser = createAlaProgressParser(appendProgress, (event) => {
                if (event.type === 'skill-catalog') task.skillExecution = { revision: event.revision, policyVersion: event.policyVersion };
                if (event.type === 'messages-cancelled') appendProgress(`\nCancelled ${event.count} queued message(s).\n`);
                if (event.type === 'session-ready') {
                    task.controlReady = true;
                    for (const message of task.pendingMessages.splice(0)) {
                        child.stdin?.write(`${JSON.stringify(message)}\n`);
                    }
                }
                if (event.type === 'message-accepted' || event.type === 'message-rejected') {
                    const waiter = this.messageWaiters.get(event.id);
                    if (waiter && waiter.taskId === task.taskId) {
                        this.messageWaiters.delete(event.id);
                        clearTimeout(waiter.timer);
                        if (event.type === 'message-rejected') waiter.reject(new Error(event.error));
                        else waiter.resolve({ delivery: event.delivery });
                    }
                    appendProgress(`\nMessage ${event.id}: ${event.delivery || event.error}\n`);
                }
            });
            child.stderr?.on('data', (chunk) => progressParser.push(chunk));
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code, signal) => {
                    progressParser.finish();
                    if (code === 0) resolve();
                    else reject(new Error(alaFailureMessage(signal || code, `${task.logTail}${task.result}`)));
                });
            });
            if (!task.cancelRequested) task.state = 'completed';
            task.completedAt = new Date().toISOString();
        } catch (error) {
            if (task.state !== 'stopped') {
                task.state = 'failed'; task.error = String(error?.message || error); task.completedAt = new Date().toISOString();
            }
        } finally {
            task.child = null;
            task.controlReady = false;
            for (const [id, waiter] of this.messageWaiters) {
                if (waiter.taskId !== task.taskId) continue;
                clearTimeout(waiter.timer);
                waiter.reject(new Error('Task ended before the message was acknowledged.'));
                this.messageWaiters.delete(id);
            }
            await this._saveTask(task).catch(() => {});
        }
    }

    async _saveTask(task) {
        if (!['desktop', 'browser', 'simple'].includes(task.type)) return;
        const directory = path.join(this.dataDir, 'robots', task.robotId, 'runtime');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${task.taskId}.task.json`);
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        const record = { taskId: task.taskId, robotId: task.robotId, type: task.type,
            state: task.state, request: task.request, alaSessionId: task.alaSessionId, skillExecution: task.skillExecution, legacySkillSelection: task.legacySkillSelection };
        await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await fs.rename(temporary, file);
    }

    async sendTaskMessage(robot, taskId, prompt) {
        const task = this.tasks.get(taskId);
        if (!task || task.robotId !== robot.id || !['queued', 'starting', 'running'].includes(task.state)) {
            throw new Error('Task is no longer running; continue it instead.');
        }
        const message = String(prompt || '').trim();
        if (!message || message.length > 32768) throw new Error('Message must contain 1 to 32768 characters.');
        const command = { type: 'message', id: crypto.randomUUID(), message };
        if (!task.controlReady) {
            if (task.pendingMessages.length >= 100) throw new Error('Task message queue is full.');
            task.pendingMessages.push(command);
            return { delivery: 'queued', messageId: command.id };
        }
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.messageWaiters.delete(command.id);
                reject(new Error('Message acknowledgement timed out; delivery is unknown.'));
            }, 35000);
            this.messageWaiters.set(command.id, { resolve, reject, timer, taskId });
        });
        task.child.stdin.write(`${JSON.stringify(command)}\n`);
        return { ...await response, messageId: command.id };
    }

    taskStatus(robotId, taskId = null) {
        const id = taskId || this.activeTasks.get(robotId) || this.latestTask.get(robotId);
        const task = id ? this.tasks.get(id) : null;
        if (!task || task.robotId !== robotId) return null;
        const { child, request, cancelRequested, pendingMessages, controlReady, ...status } = task;
        return { ...status, cwd: request.cwd, skillPolicyRef: request.skillPolicyRef || null, skillExecution: task.skillExecution ? structuredClone(task.skillExecution) : null, skillSelection: request.skillSelection ? structuredClone(request.skillSelection) : null,
            queuePosition: this.taskQueuePosition(task) };
    }

    activeTaskStatus(robotId) {
        const id = this.activeTasks.get(robotId);
        return id ? this.taskStatus(robotId, id) : null;
    }

    stopTask(robot, expectedType = null, taskId = null, { manualControl = false } = {}) {
        if (!taskId && expectedType === 'simple') {
            const candidates = [...this.tasks.values()].filter((task) => task.robotId === robot.id
                && task.type === 'simple' && ['queued', 'starting', 'running'].includes(task.state));
            if (candidates.length > 1) throw new Error('Multiple CLI tasks are running; specify taskId.');
            taskId = candidates[0]?.taskId || null;
        }
        const target = taskId ? this.taskStatus(robot.id, taskId) : this.activeTaskStatus(robot.id);
        if (target && expectedType && target.type !== expectedType
            && ['queued', 'starting', 'running'].includes(target.state)) {
            throw new Error(`robot has an active ${target.type} task, not a ${expectedType} task`);
        }
        const operation = this._newTask(robot, `stop-${expectedType || 'task'}`, {}, false);
        operation.state = 'running';
        queueMicrotask(() => {
            const internal = target ? this.tasks.get(target.taskId) : null;
            if (internal && (!expectedType || internal.type === expectedType)) {
                if (manualControl && GUI_MODES.has(internal.type)
                    && this.activeTasks.get(robot.id) === internal.taskId) {
                    this.manualControl.set(robot.id, internal.taskId);
                }
                internal.cancelRequested = true;
                internal.state = 'stopped'; internal.completedAt = new Date().toISOString(); internal.child?.kill('SIGTERM');
            }
            operation.state = 'completed'; operation.completedAt = new Date().toISOString();
        });
        return { taskId: operation.taskId, state: operation.state };
    }

    takeControl(robot, taskId) {
        return this.stopTask(robot, null, taskId, { manualControl: true });
    }

    async resumeTask(robot, taskId, prompt = '') {
        if (!/^[0-9a-f-]{36}$/u.test(String(taskId))) throw new Error('Invalid task id.');
        let internal = this.tasks.get(taskId);
        if (!internal) {
            internal = JSON.parse(await fs.readFile(path.join(this.dataDir, 'robots', robot.id,
                'runtime', `${taskId}.task.json`), 'utf8'));
            if (['starting', 'running'].includes(internal.state)) internal.state = 'stopped';
        }
        if (internal.robotId !== robot.id || !['desktop', 'browser', 'simple'].includes(internal.type)
            || !['stopped', 'completed', 'failed'].includes(internal.state)) {
            throw new Error('Robot has no matching task to continue.');
        }
        const message = String(prompt || '').trim() || 'Continue.';
        if (!/^[0-9a-f-]{36}$/u.test(internal.alaSessionId || '')) throw new Error('Task has no recoverable ALA session.');
        if ([...this.tasks.values()].some((task) => task.robotId === robot.id
            && task.alaSessionId === internal.alaSessionId && ['queued', 'starting', 'running'].includes(task.state))) {
            throw new Error('This conversation already has an active execution.');
        }
        if (message.length > 32768) throw new Error('Continuation prompt is too long.');
        if (this.manualControl.has(robot.id) && this.manualControl.get(robot.id) !== taskId) {
            throw new Error('Resume the task currently under manual control before continuing another task.');
        }
        if (this.skillsets) {
            const policyId = internal.request.skillPolicyRef || internal.alaSessionId;
            // A current conversation policy always wins over a terminal task's old request.
            await this.skillsets.policies.ensure(robot, policyId, { legacy: internal.request.skillSelection });
            internal.request.skillPolicyRef = policyId;
            internal.legacySkillSelection ||= internal.request.skillSelection;
            delete internal.request.skillSelection;
            await this._saveTask(internal);
        }
        const resumed = this._enqueueTask(robot, internal.type, {
            ...internal.request,
            alaSessionId: internal.alaSessionId, resumeSession: true,
            task: GUI_MODES.has(internal.type) ? `${message}\n\n${RESUME_REOBSERVE_INSTRUCTION}` : message,
        }, { first: this.manualControl.get(robot.id) === taskId });
        if (this.manualControl.get(robot.id) === taskId) this.manualControl.delete(robot.id);
        queueMicrotask(() => void this._drainTaskQueue(robot));
        return resumed;
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
            const active = this.activeTaskStatus(robotId);
            if (active && active.type === mode && ['queued', 'starting', 'running'].includes(active.state)) throw new Error(`stop the ${mode} task before its container`);
            session.state = 'stopping';
            await this._podman(['rm', '-f', session.containerName], 30000).catch(() => {});
            this.sessions.delete(robotId);
            return { state: 'stopped' };
        });
    }

    async logs(robotId, tail = 200) {
        const session = this.sessions.get(robotId);
        if (!session) return '';
        const result = await this._podman(['logs', '--tail', String(Math.max(1, Math.min(1000, Number(tail) || 200))), session.containerName], 30000);
        return `${result.stdout || ''}${result.stderr || ''}`.slice(-256 * 1024);
    }

    async deleteRobot(robotId, remove) {
        if (this.pending.has(robotId) || this.sessions.has(robotId) || this.activeTasks.has(robotId)
            || this.hasUnfinishedTasks(robotId)) throw new Error('stop the robot and its queued tasks before deleting it');
        this.deletedRobots.add(robotId);
        try { await remove(); }
        catch (error) { this.deletedRobots.delete(robotId); throw error; }
        this.manualControl.delete(robotId);
        this.taskQueues.delete(robotId);
        this.latestTask.delete(robotId);
        for (const [id, task] of this.tasks) if (task.robotId === robotId) this.tasks.delete(id);
    }

    async stopAll() {
        this.shuttingDown = true;
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

export const runtimeManagerInternals = { alaFailureMessage, createAlaProgressParser, httpServiceIsReady, normalizeBasePath, robotSessionUrl, MANAGED_LABEL };
