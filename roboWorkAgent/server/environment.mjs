import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const REF = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/u;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const SAFE_ENV = new Set(['LANG', 'LC_ALL', 'TERM', 'TZ', 'ALA_SESSIONS', 'ALA_EVENT_STREAM', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']);
const TOOL_ENV = new Set(['CODEX_BIN', 'OPENCODE_BIN', 'PI_BIN', 'CLAUDE_BIN']);
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function isEnvironmentRef(value) {
    return typeof value === 'string' && REF.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
}

function failure(code, message, statusCode = 409) {
    return Object.assign(new Error(message), { code, statusCode });
}

async function defaultMarketplace() {
    const agentLib = process.env.PLOINKY_AGENT_LIB_DIR || '/Agent';
    const { requestMarketplace } = await import(pathToFileURL(path.join(agentLib, 'client/AgentMcpClient.mjs')).href);
    return requestMarketplace('GET', null, undefined, 'agents');
}

function absolute(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[:,\n\r\0]/u.test(value)) {
        throw failure('ENVIRONMENT_PATH_INVALID', 'Invalid environment mount path', 400);
    }
    return path.resolve(value);
}

function within(root, value) {
    const relative = path.relative(root, value);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privateData(manifest) {
    return Object.entries(manifest.volumes || {}).some(([source, target]) =>
        /(?:^|\/)\.data\/\.private(?:\/|$)/u.test(source)
        || /(?:^|\/)\.data\/\.private(?:\/|$)/u.test(String(target)));
}

// Only the selected manifest's image is reused. Live agent containers never participate.
export class EnvironmentManager {
    constructor({ loadMarketplace = defaultMarketplace, readManifest = async file => JSON.parse(await fs.readFile(file, 'utf8')),
        ensureImage, imageExists, execFileImpl = execute, spawnImpl = spawn, podmanCommand = 'podman', ttlMs = 15000, now = Date.now } = {}) {
        Object.assign(this, { loadMarketplace, readManifest, execFileImpl, spawnImpl, podmanCommand, ttlMs, now });
        this.imageExists = imageExists || (async image => {
            try {
                await this.execFileImpl(this.podmanCommand, ['image', 'exists', image]);
                return true;
            } catch { return false; }
        });
        this.ensureImage = ensureImage || (async (image, { signal } = {}) => {
            if (!await this.imageExists(image)) {
                await this.execFileImpl(this.podmanCommand, ['pull', image], { maxBuffer: 1024 * 1024, signal });
            }
            const result = await this.execFileImpl(this.podmanCommand, ['image', 'inspect', '--format', '{{json .Config.Env}}', image], { timeout: 15000 });
            const variables = JSON.parse(result.stdout || '[]') || [];
            return { path: variables.find(value => value.startsWith('PATH='))?.slice(5) || DEFAULT_PATH };
        });
        this.cached = null;
        this.pullFailures = new Map();
    }

    async _entries() {
        const marketplace = await this.loadMarketplace();
        const entries = [], seen = new Set();
        for (const agent of marketplace?.agents || []) {
            const ref = `${agent.repo}/${agent.name}`;
            if (!agent.active || agent.enableMode !== 'global' || !isEnvironmentRef(ref) || seen.has(ref)
                || ['roboTeamAgent', 'roboWorkAgent'].includes(agent.name)) continue;
            seen.add(ref);
            let manifest;
            const base = { ref, key: Buffer.from(ref).toString('base64url'), name: agent.name, repo: agent.repo, about: String(agent.about || '') };
            try {
                manifest = await this.readManifest(absolute(agent.manifestPath));
                if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid manifest');
            } catch {
                entries.push({ ...base, available: false, reason: 'manifest unavailable' });
                continue;
            }
            if (privateData(manifest)) continue;
            const image = manifest.container;
            let reason = '';
            if (typeof image !== 'string' || !image.trim()) reason = 'image unavailable';
            else if (/[{}$\s]/u.test(image) || image.startsWith('-')) reason = 'templated or invalid image';
            else {
                const exists = await this.imageExists(image);
                if (!exists && this.pullFailures.has(image)) reason = this.pullFailures.get(image);
            }
            entries.push({ ...base, available: !reason, reason, image });
        }
        return entries.sort((a, b) => Number(b.available) - Number(a.available) || a.ref.localeCompare(b.ref));
    }

    async list({ fresh = false } = {}) {
        if (fresh || !this.cached || this.now() - this.cached.at >= this.ttlMs) {
            this.cached = { at: this.now(), value: await this._entries() };
        }
        return this.cached.value.map(({ image, imagePath, ...entry }) => ({ ...entry }));
    }

    async require(ref, { retry = false } = {}) {
        if (!isEnvironmentRef(ref)) throw failure('ENVIRONMENT_INVALID', 'Invalid agent environment', 400);
        const entry = (await this._entries()).find(item => item.ref === ref);
        if (!entry) throw failure('ENVIRONMENT_UNAVAILABLE', 'Agent environment is not enabled in global mode');
        if (!entry.available && !(retry && entry.reason === 'image cannot be pulled')) {
            throw failure('ENVIRONMENT_UNAVAILABLE', `Agent environment unavailable: ${entry.reason}`);
        }
        return { ...entry };
    }

    // Only an actual selected step prepares an image. Discovery and profile resolution stay read-only.
    async prepare(ref, { signal } = {}) {
        const entry = await this.require(ref, { retry: true });
        let imageInfo;
        try { imageInfo = await this.ensureImage(entry.image, { signal }) || {}; } catch (error) {
            if (signal?.aborted) throw error;
            this.pullFailures.set(entry.image, 'image cannot be pulled');
            this.cached = null;
            throw failure('ENVIRONMENT_UNAVAILABLE', 'Agent environment unavailable: image cannot be pulled');
        }
        this.pullFailures.delete(entry.image);
        this.cached = null;
        return { ...entry, available: true, reason: '', imagePath: imageInfo.path || DEFAULT_PATH };
    }

    async buildLaunch({ environment, runId, robotId, home, workspaceRoot, cwd, toolCache, ala, bwrap,
        channels = [], soul, folders = [], args = [], env = {}, tty = false, signal }) {
        if (!ID.test(robotId) || typeof runId !== 'string' || !runId) throw failure('ENVIRONMENT_INVALID', 'Invalid environment run identity', 400);
        const entry = await this.prepare(environment, { signal });
        signal?.throwIfAborted();
        const homeTarget = `/home/${robotId}`;
        // Without a cwd the container starts in the robot home. The workspace root is never a cwd.
        const workspace = await fs.realpath(absolute(workspaceRoot));
        const directory = cwd ? await fs.realpath(absolute(cwd)) : homeTarget;
        if (cwd && (directory === workspace || !within(workspace, directory)
            || ['.data', '.ploinky'].some(name => within(path.join(workspace, name), directory)))) {
            throw failure('ENVIRONMENT_PATH_INVALID', 'Environment cwd must be a public workspace directory', 400);
        }
        const containerName = `robowork-env-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
        const launch = ['run', '--rm', tty ? '-it' : '-i', '--name', containerName,
            '--label', 'robowork.environment=true', '--label', `robowork.robot=${robotId}`,
            '--user', '0:0', '--network', 'pasta:--no-map-gw', '--security-opt', 'unmask=/proc/*',
            '--workdir', directory, '--entrypoint', '/usr/bin/env'];
        const mount = (source, target, readOnly) => launch.push('--volume', `${absolute(source)}:${absolute(target)}:${readOnly ? 'ro' : 'rw'}`);
        if (cwd) mount(directory, directory, false);
        mount(home, homeTarget, false);
        mount(toolCache.source, toolCache.target, true);
        mount(ala.source, ala.target, true);
        mount(bwrap.source, bwrap.target, true);
        for (const folder of folders) mount(folder.source, folder.target, folder.readOnly !== false);
        for (const channel of channels) mount(channel.source, channel.target, false);
        if (soul) mount(soul.source, soul.target, true);
        const variables = { PATH: entry.imagePath, HOME: homeTarget, USER: robotId, LOGNAME: robotId,
            ALA_BWRAP: absolute(bwrap.target), ALA_SANDBOX_HOME: homeTarget,
            CODEX_HOME: `${homeTarget}/.codex`, XDG_CONFIG_HOME: `${homeTarget}/.config`,
            XDG_DATA_HOME: `${homeTarget}/.local/share`, XDG_CACHE_HOME: `${homeTarget}/.cache`,
            PI_CODING_AGENT_DIR: `${homeTarget}/.pi/agent`, CLAUDE_CONFIG_DIR: `${homeTarget}/.claude` };
        const mapToolPath = async value => {
            if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
            const source = await fs.realpath(absolute(toolCache.source));
            let resolved;
            try { resolved = await fs.realpath(absolute(value)); } catch { return null; }
            if (resolved === source || !within(source, resolved)) return null;
            return path.join(absolute(toolCache.target), path.relative(source, resolved));
        };
        for (const name of TOOL_ENV) {
            if (env[name] === undefined) continue;
            const mapped = await mapToolPath(env[name]);
            if (!mapped) throw failure('ENVIRONMENT_PATH_INVALID', 'Coding agent executable must be inside the tool cache', 400);
            variables[name] = mapped;
        }
        for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
            // Parent runtime PATH entries never enter the container unless they name cached tools.
            if (!within(absolute(toolCache.source), path.resolve(directory))) continue;
            const mapped = await mapToolPath(directory);
            if (mapped) variables.PATH += `:${mapped}`;
        }
        for (const [name, value] of Object.entries(env)) {
            if (SAFE_ENV.has(name) && typeof value === 'string' && !value.includes('\0')) variables[name] = value;
        }
        launch.push(entry.image, '-i', ...Object.entries(variables).map(([name, value]) => `${name}=${value}`),
            'node', absolute(ala.entry), ...args);
        return { command: this.podmanCommand, args: launch, options: { stdio: ['pipe', 'pipe', 'pipe'] }, containerName };
    }

    async spawn(options) {
        const launch = await this.buildLaunch(options);
        const child = this.spawnImpl(launch.command, launch.args, launch.options);
        child.containerName = launch.containerName;
        return child;
    }
}
