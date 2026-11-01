import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fail, robotId, runId, homeTarget, within } from './robot-paths.mjs';
import { RunChannels, validateChannels } from './run-channels.mjs';
import { buildPrivateLaunch } from './launch.mjs';
import { codingAgentEnvironment } from './coding-agents.mjs';

export const LOG_CAP = 64 * 1024 * 1024;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const live = state => ['starting', 'running', 'stopping'].includes(state);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);

async function processStamp(pid) {
    try { return (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19]; } catch { return null; }
}

export class RunManager {
    constructor({ paths, toolCache, runtimeBundle, robots, environment = null, gui = null, alaEntry,
        spawnImpl = spawn, buildLaunch = buildPrivateLaunch, logCap = LOG_CAP, now = Date.now, execFileImpl = execute } = {}) {
        Object.assign(this, { paths, toolCache, runtimeBundle, robots, environment, gui, alaEntry, spawnImpl, buildLaunch, logCap, now, execFileImpl });
        this.runs = new Map(); this.starting = new Map(); this.events = new EventEmitter(); this.events.setMaxListeners(0);
        this.launchId = randomUUID(); this.closed = false;
    }

    async initialize() {
        const root = path.join(this.paths.dataDir, 'runs');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        for (const id of await fs.readdir(root)) {
            try {
                runId(id);
                const directory = this.paths.run(id);
                const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
                if (meta.runId !== id) continue;
                if (!live(meta.state) && this.now() - Date.parse(meta.endedAt || meta.startedAt) > RETENTION) {
                    await fs.rm(directory, { recursive: true, force: true }); continue;
                }
                if (live(meta.state)) {
                    if (meta.containerName) await this.stopEnvironment({ meta, containerName: meta.containerName }, 'SIGKILL');
                    if (meta.pid && meta.pidStamp && await processStamp(meta.pid) === meta.pidStamp) {
                        try { process.kill(-meta.pid, 'SIGKILL'); } catch { /* Already exited. */ }
                    }
                    meta.state = 'interrupted'; meta.exit = { code: null, signal: 'SERVICE_RESTART' }; meta.endedAt = new Date(this.now()).toISOString();
                }
                const text = await fs.readFile(path.join(directory, 'log.ndjson'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
                const records = [];
                for (const line of text.split('\n')) {
                    if (!line) continue;
                    try { records.push(JSON.parse(line)); } catch { break; }
                }
                const run = { meta, directory, records, bytes: Buffer.byteLength(text), seq: records.at(-1)?.seq || 0, queue: Promise.resolve() };
                this.runs.set(id, run); await this.persist(run);
            } catch (error) {
                if (error.code === 'ENVIRONMENT_STOP_FAILED') throw error;
                // An incomplete start is not an attachable run.
            }
        }
    }

    async persist(run) {
        const text = JSON.stringify(run.meta);
        run.metadataQueue = (run.metadataQueue || Promise.resolve()).then(async () => {
            const temporary = path.join(run.directory, 'meta.tmp');
            await fs.writeFile(temporary, text, { mode: 0o600 });
            await fs.rename(temporary, path.join(run.directory, 'meta.json'));
        });
        return run.metadataQueue;
    }

    get(id) {
        const run = this.runs.get(runId(id));
        if (!run) throw fail('UNKNOWN_RUN', 'Unknown runId', 404);
        return run;
    }

    async start(input) {
        runId(input.runId); robotId(input.robotId);
        if (this.closed) throw fail('SERVICE_STOPPING', 'Service is stopping', 503);
        if (this.starting.has(input.runId)) {
            await this.starting.get(input.runId);
            const existing = this.get(input.runId);
            if (existing.meta.robotId !== input.robotId) throw fail('RUN_CONFLICT', 'runId belongs to another robot', 409);
            return { runId: input.runId, state: existing.meta.state, alreadyRunning: true };
        }
        if (this.runs.has(input.runId)) {
            const existing = this.get(input.runId);
            if (existing.meta.robotId !== input.robotId) throw fail('RUN_CONFLICT', 'runId belongs to another robot', 409);
            return { runId: input.runId, state: existing.meta.state, alreadyRunning: true };
        }
        const work = this.startNew(input);
        this.starting.set(input.runId, work);
        try { return await work; } finally { this.starting.delete(input.runId); }
    }

    async startNew(input) {
        const ala = input.ala;
        if (!ala || typeof ala !== 'object' || typeof ala.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(ala.sessionId)
            || (ala.turnId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(ala.turnId))
            || (ala.permissions !== undefined && !['full-access', 'ask-for-approval'].includes(ala.permissions))
            || (ala.ca !== undefined && !['auto', 'codex', 'opencode', 'pi', 'claude'].includes(ala.ca))) throw fail('INVALID_INPUT', 'Invalid ALA options');
        for (const key of ['resume', 'workflowExecution']) if (ala[key] !== undefined && typeof ala[key] !== 'boolean') throw fail('INVALID_INPUT', 'Invalid ALA option');
        for (const key of ['model', 'effort']) if (ala[key] !== undefined && (typeof ala[key] !== 'string' || !ala[key] || ala[key].length > 512 || /[\x00-\x1f]/u.test(ala[key]))) throw fail('INVALID_INPUT', 'Invalid ALA option');
        const cwd = await this.paths.grant(input.cwd, 'cwd');
        if (!Array.isArray(input.folders || []) || (input.folders || []).length > 128 || !Array.isArray(input.ignore || [])) throw fail('INVALID_INPUT', 'Invalid folder grants');
        const channels = validateChannels(input.channels);
        const aliases = new Set(channels.map(channel => channel.alias)); aliases.add('roboteam-soul');
        const folders = [];
        for (const folder of input.folders || []) {
            if (!folder || typeof folder !== 'object' || Array.isArray(folder)) throw fail('INVALID_INPUT', 'Invalid folder grant');
            const source = await this.paths.grant(folder?.source);
            if (folder.alias !== undefined && (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(folder.alias) || aliases.has(folder.alias))) throw fail('FOLDER_REFUSED', 'Invalid folder alias');
            if (folder.alias) aliases.add(folder.alias);
            if (folder.at !== undefined && (typeof folder.at !== 'string' || !path.isAbsolute(folder.at)
                || path.normalize(folder.at) !== folder.at || folder.alias !== undefined || folder.at.includes('\0')
                || ['/data', '/home', '/usr', '/etc', '/proc', '/dev', '/bin', '/sbin', '/lib', '/lib64'].some(root => within(root, folder.at))
                || aliases.has(folder.at.slice('/workspace/'.length)))) throw fail('FOLDER_REFUSED', 'Invalid folder target');
            folders.push({ ...folder, source });
        }
        if (input.tag !== undefined && (!input.tag || typeof input.tag !== 'object' || Array.isArray(input.tag))) throw fail('INVALID_INPUT', 'Invalid run tag');
        if (Buffer.byteLength(JSON.stringify(input.tag || {})) > 65536) throw fail('INVALID_INPUT', 'Run tag too large');
        await this.robots.require(input.robotId);
        const directory = this.paths.run(input.runId);
        await fs.mkdir(directory, { mode: 0o700 });
        const meta = { runId: input.runId, robotId: input.robotId, state: 'starting', tag: input.tag || {},
            cwd, ala, startedAt: new Date(this.now()).toISOString(), launchId: this.launchId };
        const run = { meta, directory, records: [], bytes: 0, seq: 0, queue: Promise.resolve() };
        this.runs.set(input.runId, run);
        await this.persist(run);
        try {
            run.channels = new RunChannels({ directory: path.join(directory, 'channels'), definitions: channels,
                changed: () => this.events.emit(input.runId) });
            const mounts = await run.channels.prepare();
            const soul = { source: this.paths.soul(input.robotId), target: '/workspace/roboteam-soul', alias: 'roboteam-soul' };
            const environmentFolders = folders.map(folder => ({ source: folder.source,
                target: folder.at || (folder.alias ? '/workspace/' + folder.alias : folder.source), readOnly: true }));
            const robot = await this.robots.require(input.robotId);
            const tools = await this.toolCache.prepareCodingAgents(robot.codingAgents);
            const runtimeEnv = codingAgentEnvironment(tools, { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
                ALA_SESSIONS: path.join(cwd, '.roboteam', '.ala') }, this.toolCache.root);
            const args = ['--home', input.environment ? homeTarget(input.robotId) : this.paths.home(input.robotId), '--cwd', cwd, '--session-id', ala.sessionId,
                '--control-stdin', '--permissions', ala.permissions || 'full-access'];
            if (ala.turnId) args.push('--turn-id', ala.turnId);
            if (ala.model) args.push('--model', ala.model);
            if (ala.effort) args.push('--effort', ala.effort);
            if (ala.ca) args.push('--ca', ala.ca);
            if (ala.resume) args.push('--resume-session');
            if (this.paths.workspaceRoot !== cwd) args.push('--folder', this.paths.workspaceRoot);
            for (const ignored of [path.join(this.paths.workspaceRoot, '.data'), path.join(this.paths.workspaceRoot, '.ploinky'), path.join(this.paths.workspaceRoot, '.env'), path.join(cwd, '.roboteam'), ...input.ignore || []]) {
                if (typeof ignored !== 'string' || !path.isAbsolute(ignored)) throw fail('INVALID_INPUT', 'Ignore path must be absolute');
                if (ignored !== path.join(cwd, '.roboteam') && !await fs.lstat(ignored).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) continue;
                args.push('--ignore', ignored);
            }
            for (const [index, folder] of folders.entries()) {
                args.push('--folder', input.environment ? environmentFolders[index].target : folder.source);
                if (folder.alias) args.push('as', folder.alias);
                else if (folder.at) args.push('at', folder.at);
                if (folder.expose !== undefined && typeof folder.expose !== 'boolean') throw fail('INVALID_INPUT', 'Invalid folder exposure');
                if (folder.expose) args.push('expose');
            }
            for (const mount of [...mounts, soul]) args.push('--folder', input.environment ? mount.target : mount.source, 'as', mount.alias);
            let gui;
            const requestedMcp = Array.isArray(ala.mcpServers) ? ala.mcpServers.join(',') : String(ala.mcpServers || '');
            if (requestedMcp.length > 65536 || /[\x00-\x1f]/u.test(requestedMcp)) throw fail('INVALID_INPUT', 'Invalid MCP servers');
            if (input.gui) {
                if (!this.gui) throw fail('GUI_NOT_READY', 'GUI support is not ready', 503);
                gui = await this.gui.ensure({ ...input.gui, robotId: input.robotId, codingAgents: robot.codingAgents });
            }
            const mcpServers = [requestedMcp, gui ? `${input.gui.mode || 'gui'}=http://127.0.0.1:${gui.mcpPort}/mcp` : ''].filter(Boolean).join(',');
            if (mcpServers) args.push('--MCPServers', mcpServers);
            let launch;
            if (input.environment) {
                if (!this.environment) throw fail('ENVIRONMENT_NOT_READY', 'Environment support is not ready', 503);
                const bundle = await this.runtimeBundle.prepare();
                launch = await this.environment.buildLaunch({ environment: input.environment, runId: input.runId, robotId: input.robotId,
                    home: this.paths.home(input.robotId), workspaceRoot: this.paths.workspaceRoot, cwd,
                    toolCache: { source: this.toolCache.root, target: this.toolCache.root },
                    ala: { source: bundle.ala.path, target: '/opt/robowork-ala', entry: '/opt/robowork-ala/bin/ala.mjs' },
                    bwrap: { source: bundle.bwrap.bin, target: '/opt/robowork-bwrap' },
                    channels: mounts, soul,
                    folders: environmentFolders, args, env: runtimeEnv });
            } else launch = await this.buildLaunch({ paths: this.paths, id: input.robotId, directory,
                command: process.execPath, args: [this.alaEntry, ...args], env: runtimeEnv, guiPort: gui?.mcpPort });
            const child = this.spawnImpl(launch.command, launch.args, launch.options);
            run.child = child; run.containerName = launch.containerName; meta.containerName = launch.containerName;
            child.stdout.on('data', chunk => this.append(run, 'stdout', chunk));
            child.stderr.on('data', chunk => this.append(run, 'stderr', chunk));
            child.once('error', () => { void this.finish(run, null, 'SPAWN_FAILED'); });
            child.once('close', (code, signal) => { void this.finish(run, code, signal); });
            meta.pid = child.pid; meta.servicePid = process.pid;
            meta.pidStamp = await processStamp(child.pid);
            if (!run.finishing) { meta.state = 'running'; await this.persist(run); }
            return { runId: input.runId, state: meta.state, alreadyRunning: false };
        } catch (error) {
            await this.finish(run, null, error.code || 'START_FAILED');
            throw error;
        }
    }

    append(run, stream, chunk) {
        if (run.capped) return;
        for (let offset = 0; offset < chunk.length; offset += 32768) {
            const record = { seq: run.seq + 1, stream, data: chunk.subarray(offset, offset + 32768).toString('base64') };
            const line = JSON.stringify(record) + '\n';
            if (run.bytes + Buffer.byteLength(line) > this.logCap) {
                run.capped = true; run.meta.logCapped = true; this.signal(run, 'SIGTERM');
                run.killTimer = setTimeout(() => this.signal(run, 'SIGKILL'), 1500); run.killTimer.unref();
                return;
            }
            run.seq = record.seq; run.bytes += Buffer.byteLength(line);
            run.queue = run.queue.then(async () => {
                await fs.appendFile(path.join(run.directory, 'log.ndjson'), line, { mode: 0o600 });
                run.records.push(record); this.events.emit(run.meta.runId);
            }).catch(() => { run.meta.logError = true; this.signal(run, 'SIGTERM'); });
        }
    }

    async finish(run, code, signal) {
        if (run.finishing) return run.finishing;
        run.finishing = (async () => {
            clearTimeout(run.killTimer); await run.queue;
            const interrupted = run.interrupting || signal === 'SERVICE_RESTART';
            run.meta.state = interrupted ? 'interrupted' : 'exited';
            run.meta.exit = { code, signal: interrupted ? 'SERVICE_RESTART' : signal || null }; run.meta.endedAt = new Date(this.now()).toISOString();
            await this.persist(run); this.events.emit(run.meta.runId); await run.channels?.close();
        })();
        return run.finishing;
    }

    async read({ runId: id, after = 0, waitMs = 0, maxBytes = 1024 * 1024 }) {
        const run = this.get(id);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 5000
            || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw fail('INVALID_INPUT', 'Invalid read cursor or limit');
        await run.queue;
        if (run.seq <= after && live(run.meta.state) && !run.channels?.list().length && waitMs) {
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); this.events.off(id, done); resolve(); };
                const timer = setTimeout(done, Math.min(100, waitMs)); this.events.once(id, done);
            });
        }
        await run.queue;
        const records = []; let bytes = 0;
        for (const record of run.records) {
            if (record.seq <= after) continue;
            const size = Buffer.byteLength(JSON.stringify(record));
            if (bytes + size > maxBytes) break;
            records.push(record); bytes += size;
        }
        return { records, next: records.at(-1)?.seq ?? after, state: run.meta.state,
            ...(run.meta.exit ? { exit: run.meta.exit } : {}), callbacks: run.channels?.list() || [] };
    }

    async input({ runId: id, data, close, reply }) {
        const run = this.get(id);
        if (close !== undefined && typeof close !== 'boolean') throw fail('INVALID_INPUT', 'Invalid close flag');
        if (reply) await run.channels?.reply(reply);
        if (data !== undefined) {
            if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw fail('INVALID_INPUT', 'Run input must be base64');
            if (!run.child || !live(run.meta.state) || run.child.stdin.destroyed) throw fail('RUN_NOT_RUNNING', 'Run is not running', 409);
            await new Promise((resolve, reject) => run.child.stdin.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve()));
        }
        if (close) run.child?.stdin.end();
        return { ok: true };
    }

    signal(run, signal) {
        if (!live(run.meta.state)) return;
        const stopChild = () => { try { process.kill(-run.child.pid, signal); } catch { run.child?.kill(signal); } };
        if (run.containerName) {
            run.stopQueue = (run.stopQueue || Promise.resolve()).then(() => this.stopEnvironment(run, signal)).then(stopChild);
            void run.stopQueue.catch(() => { run.meta.stopError = true; });
        } else stopChild();
    }

    async stopEnvironment(run, signal) {
        const command = this.environment?.podmanCommand || 'podman';
        try {
            try { await this.execFileImpl(command, ['container', 'exists', run.containerName], { timeout: 15000 }); }
            catch (error) { if (error.code === 1) return; throw error; }
            const result = await this.execFileImpl(command, ['inspect', '--format', '{{json .Config.Labels}}', run.containerName], { timeout: 15000 });
            const labels = JSON.parse(result.stdout);
            if (!/^robowork-env-[a-f0-9]{24}$/u.test(run.containerName)
                || labels['robowork.environment'] !== 'true' || labels['robowork.robot'] !== run.meta.robotId) throw new Error('Container ownership mismatch');
            await this.execFileImpl(command, ['kill', '--signal', signal, run.containerName], { timeout: 15000 });
        } catch { throw fail('ENVIRONMENT_STOP_FAILED', 'Could not stop the owned environment container', 500); }
    }

    async stop({ runId: id, signal = 'SIGTERM' }) {
        if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)) throw fail('INVALID_INPUT', 'Invalid stop signal');
        const run = this.get(id); this.signal(run, signal); await run.stopQueue; return { ok: true };
    }

    list({ robotId: id } = {}) {
        if (id !== undefined) robotId(id);
        return [...this.runs.values()].filter(run => !id || run.meta.robotId === id).map(({ meta }) => ({
            runId: meta.runId, robotId: meta.robotId, state: meta.state, tag: meta.tag, startedAt: meta.startedAt,
            ...(meta.exit ? { exit: meta.exit } : {}),
        }));
    }

    async release({ runId: id }) {
        const run = this.get(id);
        if (live(run.meta.state)) throw fail('RUN_ACTIVE', 'Stop the run before releasing it', 409);
        await run.finishing; await run.channels?.close();
        await fs.rm(run.directory, { recursive: true, force: true }); this.runs.delete(id); return { ok: true };
    }

    async close() {
        this.closed = true;
        await Promise.allSettled([...this.starting.values()]);
        const active = [...this.runs.values()].filter(run => live(run.meta.state));
        for (const run of active) { run.interrupting = true; this.signal(run, 'SIGTERM'); }
        await Promise.all(active.map(run => run.stopQueue));
        if (active.length) await sleep(500);
        for (const run of active) {
            if (live(run.meta.state)) { this.signal(run, 'SIGKILL'); await run.stopQueue; await this.finish(run, null, 'SERVICE_RESTART'); }
        }
        await Promise.allSettled([...this.runs.values()].map(run => run.finishing || run.queue));
    }
}
