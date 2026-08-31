import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const COMMAND_CANDIDATES = Object.freeze({
    xvfb: ['/usr/bin/Xvfb'],
    openbox: ['/usr/bin/openbox-session', '/usr/bin/openbox'],
    xterm: ['/usr/bin/xterm'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'],
    x11vnc: ['/usr/bin/x11vnc'],
    websockify: ['/usr/bin/websockify'],
});

function firstExecutable(candidates) {
    return candidates.find((candidate) => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }) || null;
}

export function resolveDesktopCommands() {
    const resolved = {};
    for (const [name, candidates] of Object.entries(COMMAND_CANDIDATES)) {
        resolved[name] = firstExecutable(candidates);
    }
    return resolved;
}

export function buildDesktopCommandPlan({ profileRoot, displayNumber, rfbPort, websockifyPort, commands }) {
    const display = `:${displayNumber}`;
    const home = path.join(profileRoot, 'home');
    const browser = path.join(profileRoot, 'browser');
    const workspace = path.join(profileRoot, 'workspace');
    return [
        { name: 'xvfb', command: commands.xvfb, args: [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac'] },
        { name: 'openbox', command: commands.openbox, args: [] },
        { name: 'terminal', command: commands.xterm, args: ['-title', 'RoboTeam Terminal', '-geometry', '110x32+40+60', '-e', '/bin/bash', '-lc', `cd ${JSON.stringify(workspace)}; exec /bin/bash`] },
        { name: 'chromium', command: commands.chromium, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', `--user-data-dir=${browser}`, '--start-maximized', 'about:blank'] },
        { name: 'x11vnc', command: commands.x11vnc, args: ['-display', display, '-rfbport', String(rfbPort), '-localhost', '-forever', '-shared', '-nopw', '-xkb', '-quiet'] },
        { name: 'websockify', command: commands.websockify, args: [String(websockifyPort), `127.0.0.1:${rfbPort}`] },
    ];
}

async function waitForCondition(check, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
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

export class DesktopManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.maxActive = Math.max(1, Math.min(32, Number(options.maxActive) || 8));
        this.commands = options.commands || resolveDesktopCommands();
        this.spawnImpl = options.spawnImpl || spawn;
        this.sessions = new Map();
        this.pending = new Map();
    }

    _profileRoot(profile) {
        return path.join(this.dataDir, 'profiles', profile.id);
    }

    _allocateSlot() {
        const used = new Set(Array.from(this.sessions.values()).map((session) => session.slot));
        for (let slot = 0; slot < this.maxActive; slot += 1) {
            if (!used.has(slot)) return slot;
        }
        throw new Error(`active desktop limit reached (${this.maxActive})`);
    }

    status(profileId) {
        const session = this.sessions.get(profileId);
        if (!session) return { state: 'stopped' };
        return {
            state: session.state,
            startedAt: session.startedAt,
            display: session.display,
        };
    }

    activeWebsockifyPort(profileId) {
        return this.sessions.get(profileId)?.websockifyPort || null;
    }

    async _withProfileOperation(profileId, operation) {
        const previous = this.pending.get(profileId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.pending.set(profileId, current);
        try {
            return await current;
        } finally {
            if (this.pending.get(profileId) === current) this.pending.delete(profileId);
        }
    }

    _ensureSystemUser(profile, home) {
        if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
        const existing = spawnSync('/usr/bin/getent', ['passwd', String(profile.uid)], { stdio: 'ignore' });
        if (existing.status === 0) return;
        const created = spawnSync('/usr/sbin/useradd', ['--uid', String(profile.uid), '--user-group', '--no-create-home', '--home-dir', home, '--shell', '/bin/bash', profile.systemUser], { encoding: 'utf8' });
        if (created.status !== 0) {
            throw new Error(`could not provision desktop user: ${String(created.stderr || '').trim() || 'useradd failed'}`);
        }
    }

    async start(profile) {
        return this._withProfileOperation(profile.id, async () => {
            const existing = this.sessions.get(profile.id);
            if (existing) return this.status(profile.id);
            const missing = Object.entries(this.commands).filter(([, command]) => !command).map(([name]) => name);
            if (missing.length) throw new Error(`desktop runtime is missing: ${missing.join(', ')}`);

            const slot = this._allocateSlot();
            const displayNumber = 100 + slot;
            const rfbPort = 5900 + slot;
            const websockifyPort = 6100 + slot;
            const profileRoot = this._profileRoot(profile);
            const home = path.join(profileRoot, 'home');
            const runtime = path.join(profileRoot, 'runtime');
            const logPath = path.join(profileRoot, 'logs', 'desktop.log');
            await fsp.mkdir(runtime, { recursive: true, mode: 0o700 });
            this._ensureSystemUser(profile, home);

            const lockPath = `/tmp/.X${displayNumber}-lock`;
            const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
            await fsp.rm(lockPath, { force: true });
            await fsp.rm(socketPath, { force: true });

            const env = {
                PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                HOME: home,
                USER: profile.systemUser,
                LOGNAME: profile.systemUser,
                DISPLAY: `:${displayNumber}`,
                XDG_RUNTIME_DIR: runtime,
                XDG_CONFIG_HOME: path.join(home, '.config'),
                XDG_CACHE_HOME: path.join(home, '.cache'),
                XDG_DATA_HOME: path.join(home, '.local', 'share'),
            };
            const plan = buildDesktopCommandPlan({ profileRoot, displayNumber, rfbPort, websockifyPort, commands: this.commands });
            const logFd = fs.openSync(logPath, 'a');
            const session = {
                profileId: profile.id,
                slot,
                state: 'starting',
                display: env.DISPLAY,
                rfbPort,
                websockifyPort,
                startedAt: new Date().toISOString(),
                processes: [],
                logFd,
            };
            this.sessions.set(profile.id, session);

            const launch = (entry) => {
                const child = this.spawnImpl(entry.command, entry.args, {
                    cwd: path.join(profileRoot, 'workspace'),
                    env,
                    uid: profile.uid,
                    gid: profile.uid,
                    stdio: ['ignore', logFd, logFd],
                });
                session.processes.push({ name: entry.name, child });
                child.once('error', (error) => {
                    fs.writeSync(logFd, `[${new Date().toISOString()}] ${entry.name} error: ${error.message}\n`);
                });
                if (['xvfb', 'x11vnc', 'websockify'].includes(entry.name)) {
                    child.once('exit', () => {
                        if (this.sessions.get(profile.id) === session && session.state !== 'stopping') {
                            void this.stop(profile.id);
                        }
                    });
                }
                return child;
            };

            try {
                launch(plan.find((entry) => entry.name === 'xvfb'));
                await waitForCondition(() => fs.existsSync(socketPath), 10000, 'virtual display did not become ready');
                launch(plan.find((entry) => entry.name === 'openbox'));
                launch(plan.find((entry) => entry.name === 'terminal'));
                launch(plan.find((entry) => entry.name === 'chromium'));
                launch(plan.find((entry) => entry.name === 'x11vnc'));
                await waitForCondition(() => portIsOpen(rfbPort), 10000, 'VNC server did not become ready');
                launch(plan.find((entry) => entry.name === 'websockify'));
                await waitForCondition(() => portIsOpen(websockifyPort), 10000, 'desktop WebSocket bridge did not become ready');
                session.state = 'running';
                return this.status(profile.id);
            } catch (error) {
                await this._stopSession(session);
                this.sessions.delete(profile.id);
                throw error;
            }
        });
    }

    async _stopSession(session) {
        session.state = 'stopping';
        for (const { child } of [...session.processes].reverse()) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        for (const { child } of [...session.processes].reverse()) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        try { fs.closeSync(session.logFd); } catch {}
    }

    async stop(profileId) {
        return this._withProfileOperation(profileId, async () => {
            const session = this.sessions.get(profileId);
            if (!session) return { state: 'stopped' };
            await this._stopSession(session);
            this.sessions.delete(profileId);
            return { state: 'stopped' };
        });
    }

    async stopAll() {
        await Promise.allSettled(Array.from(this.sessions.keys()).map((profileId) => this.stop(profileId)));
    }
}
