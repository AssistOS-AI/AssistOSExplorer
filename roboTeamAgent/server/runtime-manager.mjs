import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'io.assistos.roboteam.robot=1';
const MODES = new Set(['browser', 'desktop']);

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (!MODES.has(mode)) throw new Error('run mode must be browser or desktop');
    return mode;
}

function normalizeBasePath(value) {
    const raw = String(value || '/').trim();
    const leading = raw.startsWith('/') ? raw : `/${raw}`;
    return leading.endsWith('/') ? leading : `${leading}/`;
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (value) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(250);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function waitForPort(port, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portIsOpen(port)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('robot session did not become ready');
}

export function buildRobotRunArgs({ robot, mode, dataDir, publicBasePath, images, timezone }) {
    const robotRoot = path.join(path.resolve(dataDir), 'robots', robot.id);
    const containerName = `roboteam-robot-${robot.id}`;
    const subfolder = `${normalizeBasePath(publicBasePath)}api/robots/${robot.id}/session/`;
    const image = mode === 'browser' ? images.browser : images.desktop;
    return {
        containerName,
        image,
        subfolder,
        args: [
            'run', '-d',
            '--ipc', 'private',
            '--shm-size', '1g',
            '--network', 'pasta',
            '--name', containerName,
            '--label', MANAGED_LABEL,
            '--label', `io.assistos.roboteam.robot-id=${robot.id}`,
            '--label', `io.assistos.roboteam.mode=${mode}`,
            '-p', '127.0.0.1::3000',
            '-e', 'PUID=0',
            '-e', 'PGID=0',
            '-e', `TZ=${timezone}`,
            '-e', `SUBFOLDER=${subfolder}`,
            '-e', `TITLE=${robot.name}`,
            '-e', 'START_DOCKER=false',
            '-e', 'DISABLE_IPV6=true',
            '-e', 'PELORUS=true',
            '-v', `${path.join(robotRoot, 'home')}:/config`,
            '-v', `${path.join(robotRoot, 'workspace')}:/config/workspace`,
            '-v', `${path.join(robotRoot, 'downloads')}:/config/Downloads`,
            image,
        ],
    };
}

export class RuntimeManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.publicBasePath = normalizeBasePath(options.publicBasePath);
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.maxActive = Math.max(1, Math.min(32, Number(options.maxActive) || 8));
        this.images = {
            browser: options.browserImage || 'lscr.io/linuxserver/chromium:latest',
            desktop: options.desktopImage || 'lscr.io/linuxserver/webtop:ubuntu-xfce',
        };
        this.timezone = options.timezone || 'Europe/Bucharest';
        this.execFileImpl = options.execFileImpl || execFileAsync;
        this.sessions = new Map();
        this.pending = new Map();
    }

    async _podman(args, timeout = 120000) {
        return this.execFileImpl(this.podmanCommand, args, {
            timeout,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
        });
    }

    async initialize() {
        await this._podman(['info'], 30000);
        let records = [];
        try {
            const result = await this._podman(['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', 'json']);
            records = JSON.parse(result.stdout || '[]');
        } catch {
            records = [];
        }
        for (const record of records) {
            const id = String(record?.Id || record?.ID || '').trim();
            if (id) await this._podman(['rm', '-f', id]).catch(() => {});
        }
    }

    _withRobotOperation(robotId, operation) {
        const previous = this.pending.get(robotId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.pending.set(robotId, current);
        return current.finally(() => {
            if (this.pending.get(robotId) === current) this.pending.delete(robotId);
        });
    }

    status(robotId) {
        const session = this.sessions.get(robotId);
        if (!session) return { state: 'stopped' };
        return {
            state: session.state,
            mode: session.mode,
            startedAt: session.startedAt,
            sessionUrl: session.sessionUrl,
        };
    }

    activePort(robotId) {
        return this.sessions.get(robotId)?.port || null;
    }

    async start(robot, requestedMode) {
        const mode = normalizeMode(requestedMode);
        return this._withRobotOperation(robot.id, async () => {
            const existing = this.sessions.get(robot.id);
            if (existing) {
                if (existing.mode !== mode) throw new Error(`robot is already running in ${existing.mode} mode`);
                return this.status(robot.id);
            }
            if (this.sessions.size >= this.maxActive) throw new Error(`active robot limit reached (${this.maxActive})`);
            const plan = buildRobotRunArgs({
                robot,
                mode,
                dataDir: this.dataDir,
                publicBasePath: this.publicBasePath,
                images: this.images,
                timezone: this.timezone,
            });
            const session = {
                robotId: robot.id,
                mode,
                state: 'starting',
                containerName: plan.containerName,
                startedAt: new Date().toISOString(),
                sessionUrl: plan.subfolder,
                port: null,
            };
            this.sessions.set(robot.id, session);
            try {
                await this._podman(plan.args, 10 * 60 * 1000);
                const mapping = await this._podman(['port', plan.containerName, '3000/tcp']);
                const match = String(mapping.stdout || '').trim().match(/:(\d+)$/);
                if (!match) throw new Error('could not resolve robot session port');
                session.port = Number(match[1]);
                await waitForPort(session.port);
                session.state = 'running';
                this._monitor(session);
                return this.status(robot.id);
            } catch (error) {
                await this._podman(['rm', '-f', plan.containerName]).catch(() => {});
                this.sessions.delete(robot.id);
                throw error;
            }
        });
    }

    _monitor(session) {
        const timer = setInterval(async () => {
            if (this.sessions.get(session.robotId) !== session || session.state === 'stopping') {
                clearInterval(timer);
                return;
            }
            try {
                const result = await this._podman(['inspect', '--format', '{{.State.Running}}', session.containerName], 10000);
                if (String(result.stdout).trim() === 'true') return;
            } catch {}
            this.sessions.delete(session.robotId);
            clearInterval(timer);
        }, 2000);
        timer.unref();
    }

    async stop(robotId) {
        return this._withRobotOperation(robotId, async () => {
            const session = this.sessions.get(robotId);
            if (!session) return { state: 'stopped' };
            session.state = 'stopping';
            await this._podman(['rm', '-f', session.containerName], 30000).catch(() => {});
            this.sessions.delete(robotId);
            return { state: 'stopped' };
        });
    }

    async logs(robotId, tail = 200) {
        const session = this.sessions.get(robotId);
        if (!session) return '';
        const boundedTail = Math.max(1, Math.min(1000, Number(tail) || 200));
        const result = await this._podman(['logs', '--tail', String(boundedTail), session.containerName], 30000);
        return `${result.stdout || ''}${result.stderr || ''}`.slice(-256 * 1024);
    }

    async stopAll() {
        await Promise.allSettled(Array.from(this.sessions.keys()).map((robotId) => this.stop(robotId)));
    }
}

export const runtimeManagerInternals = { normalizeMode, normalizeBasePath, MANAGED_LABEL };
