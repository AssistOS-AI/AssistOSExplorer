import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, TOOL_REFRESH_INTERVAL_MS, TOOL_FALLBACK_RETRY_MS, BROWSER_IMAGE, DESKTOP_IMAGE } from './constants.mjs';
import { OPENCODE_PLUGIN_PACKAGE, openCodePluginState } from './opencode-plugin-seed.mjs';
import { RUNTIME_BUNDLE_FILES } from './runtime-bundle.mjs';

const execFileAsync = promisify(execFile);
const CACHE_SCHEMA = 'roboteam-tool-cache-v1';
const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
// The OpenCode plugin template keeps package-lock.json: OpenCode skips its own dependency
// installation only when the lock lists the dependency. Scripts stay off, as OpenCode runs them.
const PLUGIN_TEMPLATE_NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
const PLUGIN_TEMPLATE_BUNDLE = 'opencode-plugin';
const TOOL_MOUNT_PATH = '/opt/roboteam-tools';
const NESTED_CONTAINER_ARGS = ['--ipc', 'none'];
const CODING_AGENT_PACKAGES = Object.freeze({
    codex: Object.freeze({ packageName: '@openai/codex', executable: 'codex' }),
    opencode: Object.freeze({ packageName: 'opencode-ai', executable: 'opencode' }),
    pi: Object.freeze({ packageName: '@earendil-works/pi-coding-agent', executable: 'pi' }),
    // OMP (Oh My Pi) is a Bun program (`#!/usr/bin/env bun`), so Bun is installed into the same prefix and
    // linked beside it: ALA puts that prefix's bin first on the sandbox PATH, and the shell view links it too.
    omp: Object.freeze({ packageName: '@oh-my-pi/pi-coding-agent', executable: 'omp',
        companions: Object.freeze([Object.freeze({ packageName: 'bun', executable: 'bun' })]) }),
    claude: Object.freeze({ packageName: '@anthropic-ai/claude-code', executable: 'claude' }),
    // Mistral Vibe is a Python program published on PyPI. uv installs it with a managed CPython into its own
    // virtual environment inside the generation; see _prepareUvAgent.
    vibe: Object.freeze({ packageName: 'mistral-vibe', executable: 'vibe', installer: 'uv' }),
    // Google's Antigravity CLI is a native binary published through its updater's release manifest; see
    // _prepareManifestAgent.
    agy: Object.freeze({ packageName: 'antigravity-cli', executable: 'agy', installer: 'agy-manifest' }),
});
const AGY_MANIFEST_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
// A virtual environment records absolute paths (its interpreter, script headers), so a uv generation is installed at
// its final path under an exclusive lock instead of being renamed from staging. A lock older than this is abandoned.
const IN_PLACE_LOCK_STALE_MS = 30 * 60 * 1000;
const UV_PYTHON = '3.12';

const PIN_VARIABLES = Object.freeze(Object.fromEntries(
    Object.keys(CODING_AGENT_PACKAGES).map((name) => [name, `ROBOTEAM_${name.toUpperCase()}_VERSION`]),
));
// Canonical semver only, so the recorded string is the version npm installs:
// no leading zeros, no empty or zero-padded prerelease identifiers, no build metadata.
const PIN_NUMBER = '(?:0|[1-9]\\d*)';
const PIN_PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const PIN_PATTERN = new RegExp(`^${PIN_NUMBER}\\.${PIN_NUMBER}\\.${PIN_NUMBER}(?:-${PIN_PRERELEASE_ID}(?:\\.${PIN_PRERELEASE_ID})*)?$`, 'u');

// Operator pins: exact versions only. Unset or empty means unpinned (track upstream);
// anything else that is not an exact version throws so a typo never silently unpins.
function codingAgentVersionPins(environment = process.env) {
    const pins = {};
    for (const [name, variable] of Object.entries(PIN_VARIABLES)) {
        const value = environment?.[variable];
        if (value === undefined || value === '') continue;
        if (typeof value !== 'string' || value.length > 64 || !PIN_PATTERN.test(value)) {
            throw new TypeError(`invalid ${variable}`);
        }
        pins[name] = value;
    }
    return Object.freeze(pins);
}

function toolProcessEnv(environment = process.env) {
    const sanitized = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR', 'XDG_CACHE_HOME']) {
        if (typeof environment[key] === 'string') sanitized[key] = environment[key];
    }
    return sanitized;
}

function safeVersion(value, label) {
    const version = String(value || '').trim().replace(/^v(?=\d)/u, '');
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(version)) {
        throw new Error(`${label} returned an invalid version`);
    }
    return version;
}

// The executables a coding agent's generation provides under bin/: its own and those of its companions.
function agentExecutables(nameOrDefinition) {
    const definition = typeof nameOrDefinition === 'string' ? CODING_AGENT_PACKAGES[nameOrDefinition] : nameOrDefinition;
    return [definition.executable, ...(definition.companions || []).map(companion => companion.executable)];
}

function generationName(input) {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function executablePath(root, name) {
    return path.join(root, 'node_modules', '.bin', name);
}

async function isExecutable(filePath) {
    try {
        await fs.access(filePath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export class ToolCache {
    constructor(options = {}) {
        this.root = path.resolve(options.root || path.join(options.dataDir || DATA_DIR, 'tool-cache'));
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.npmCommand = options.npmCommand || '/usr/local/bin/npm';
        this.tarCommand = options.tarCommand || '/usr/bin/tar';
        this.images = {
            desktop: options.desktopImage || DESKTOP_IMAGE,
            browser: options.browserImage || BROWSER_IMAGE,
        };
        this.execFileImpl = options.execFileImpl || execFileAsync;
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.arch = options.arch || process.arch;
        this.log = options.log || ((message) => console.log(message));
        this.refreshIntervalMs = Math.max(60000, Number(options.refreshIntervalMs) || TOOL_REFRESH_INTERVAL_MS);
        this.fallbackRetryMs = Math.max(1000, Number(options.fallbackRetryMs) || TOOL_FALLBACK_RETRY_MS);
        this.now = options.now || Date.now;
        if (options.versionPins) {
            for (const name of Object.keys(options.versionPins)) {
                if (!Object.hasOwn(PIN_VARIABLES, name)) throw new TypeError(`unknown version pin: ${name}`);
            }
        }
        this.versionPins = options.versionPins
            ? codingAgentVersionPins(Object.fromEntries(Object.entries(options.versionPins).map(([name, value]) => [PIN_VARIABLES[name], value])))
            : codingAgentVersionPins(options.processEnv || process.env);
        this.processEnv = toolProcessEnv(options.processEnv || process.env);
        this.inflight = new Map();
    }

    prepareCodex() {
        return this.prepareCodingAgent('codex');
    }

    async warmup() {
        this.log('[tool-cache] preparing startup tools');
        const families = ['shell', 'desktop', 'browser'];
        const results = await Promise.allSettled(families.map(async (family) => {
            const tools = await (family === 'shell' ? this.prepareShellTools() : this.prepareMode(family));
            this.log(`[tool-cache] startup ${family} tools ready`);
            return tools;
        }));
        for (const [index, result] of results.entries()) {
            if (result.status === 'rejected') {
                this.log(`[tool-cache] startup ${families[index]} preparation failed: ${result.reason?.message || result.reason}; will retry on demand`);
            }
        }
        return results;
    }

    // `maxAgeMs` asks for a recheck when the last one is older, for a session that should start the current release.
    prepareShellTools(names = Object.keys(CODING_AGENT_PACKAGES), { maxAgeMs } = {}) {
        const selected = [...new Set(names)].sort();
        const shellName = selected.length === Object.keys(CODING_AGENT_PACKAGES).length ? 'shell' : `shell-${selected.join('-')}`;
        return this._once(shellName, async () => {
            const agents = await this.prepareCodingAgents(selected, { maxAgeMs });
            const generation = generationName(Object.fromEntries(Object.entries(agents).map(([name, value]) => [name, value.path])));
            const directory = path.join(this.root, 'shell-generations', generation);
            await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
            const staging = await fs.mkdtemp(path.join(this.root, 'shell-generations', '.staging-'));
            try {
                await fs.mkdir(path.join(staging, 'bin'));
                for (const [name, agent] of Object.entries(agents)) {
                    for (const executable of agentExecutables(name)) {
                        const target = path.resolve(agent.binPath, executable);
                        if (!target.startsWith(this.root + path.sep)) throw new Error('Coding-agent executable is outside the shared cache');
                        const relative = path.relative(path.join(directory, 'bin'), target);
                        await fs.symlink(relative, path.join(staging, 'bin', executable));
                    }
                }
                await fs.rename(staging, directory).catch(error => {
                    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
                });
                for (const name of Object.keys(agents)) {
                    for (const executable of agentExecutables(name)) {
                        if (!await isExecutable(path.join(directory, 'bin', executable))) throw new Error(`Shared ${executable} executable is unavailable`);
                        if (await fs.realpath(path.join(directory, 'bin', executable)) !== await fs.realpath(path.join(agents[name].binPath, executable))) {
                            throw new Error(`Shared ${executable} executable does not match its cache generation`);
                        }
                    }
                }
                const candidate = path.join(this.root, `.shell-${crypto.randomUUID()}`);
                try {
                    await fs.symlink(path.relative(this.root, directory), candidate);
                    await fs.rename(candidate, path.join(this.root, shellName));
                } finally { await fs.unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
                // Keep the same directory depth as shell-generations/<generation> so
                // relative package links also resolve when this view is bind-mounted.
                const selections = path.join(this.root, 'shell-selections');
                await fs.mkdir(selections, { recursive: true, mode: 0o700 });
                const selection = path.join(selections, shellName);
                const stagedSelection = path.join(selections, `.shell-${crypto.randomUUID()}`);
                try {
                    await fs.symlink(path.relative(selections, directory), stagedSelection);
                    await fs.rename(stagedSelection, selection);
                } finally { await fs.unlink(stagedSelection).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
                return { root: this.root, path: directory, binPath: path.join(selection, 'bin'), agents };
            } finally { await fs.rm(staging, { recursive: true, force: true }); }
        });
    }

    // Read-only, network-free view of the shell generation a long-lived service
    // already prepared. Validated from disk on every call (no freshness window);
    // returns null unless every coding-agent executable resolves inside the cache
    // and any operator pin matches the recorded version. Never installs or upgrades.
    async peekShellTools() {
        try {
            const selection = path.join(this.root, 'shell-selections', 'shell');
            const directory = await fs.realpath(selection);
            const realRoot = await fs.realpath(this.root);
            if (!directory.startsWith(realRoot + path.sep)) return null;
            const binPath = path.join(selection, 'bin');
            const agents = {};
            for (const [name, definition] of Object.entries(CODING_AGENT_PACKAGES)) {
                const executable = path.join(binPath, definition.executable);
                if (!(await isExecutable(executable))) return null;
                if (!(await fs.realpath(executable)).startsWith(realRoot + path.sep)) return null;
                // The selection is relinked only by prepareShellTools, while current.json is
                // also advanced per agent elsewhere; require both to name the same binary,
                // and check descriptor, stamp and pin exactly as _fallback does.
                const bundleRoot = path.join(this.root, name);
                const descriptor = JSON.parse(await fs.readFile(path.join(bundleRoot, 'current.json'), 'utf8'));
                if (descriptor?.schema !== CACHE_SCHEMA || descriptor.name !== name || !/^[0-9a-f]{64}$/u.test(descriptor.generation || '')) return null;
                const generation = path.join(bundleRoot, 'generations', descriptor.generation);
                const stamp = JSON.parse(await fs.readFile(path.join(generation, 'stamp.json'), 'utf8'));
                if (stamp?.schema !== CACHE_SCHEMA || stamp.name !== name || stamp.generation !== descriptor.generation) return null;
                const pin = this.versionPins[name];
                if (pin !== undefined && (descriptor.versions?.[name] !== pin || stamp.versions?.[name] !== pin)) return null;
                for (const file of agentExecutables(definition)) {
                    const current = path.join(generation, 'bin', file);
                    const shared = path.join(binPath, file);
                    if (!(await isExecutable(current)) || !(await isExecutable(shared)) || await fs.realpath(current) !== await fs.realpath(shared)) return null;
                }
                // Same per-agent shape as _prepare/_fallback: the agent's own generation, not the aggregate view.
                agents[name] = { path: generation, binPath: path.join(generation, 'bin'), versions: stamp.versions || descriptor.versions || {} };
            }
            return { root: this.root, path: directory, binPath, agents, prepared: true };
        } catch {
            return null;
        }
    }

    prepareCodingAgent(name, { maxAgeMs } = {}) {
        if (!Object.hasOwn(CODING_AGENT_PACKAGES, name)) throw new Error(`unsupported coding agent: ${name}`);
        return this._once(name, () => this._prepareCodingAgent(name), maxAgeMs);
    }

    async prepareCodingAgents(names = Object.keys(CODING_AGENT_PACKAGES), { maxAgeMs } = {}) {
        const uniqueNames = [...new Set(names)];
        const prepared = await Promise.all(uniqueNames.map((name) => this.prepareCodingAgent(name, { maxAgeMs })));
        return Object.fromEntries(uniqueNames.map((name, index) => [name, prepared[index]]));
    }

    // The @opencode-ai/plugin dependency tree OpenCode would otherwise install into every robot
    // home on its first run, prepared once per exact OpenCode version. The generation name
    // derives from the version, platform and architecture, so a different OpenCode never
    // reuses it. There is no fallback to another version: a mismatched plugin is never offered.
    _openCodePluginPlan(version) {
        if (typeof version !== 'string' || !PIN_PATTERN.test(version) || version.length > 64) {
            throw new TypeError('invalid OpenCode version');
        }
        const identity = { package: OPENCODE_PLUGIN_PACKAGE, version, platform: process.platform, arch: this.arch,
            runtime: process.versions.node };
        const generation = generationName(identity);
        return { identity, generation, version,
            directory: path.join(this.root, PLUGIN_TEMPLATE_BUNDLE, 'generations', generation) };
    }

    async _openCodePluginUsable(plan) {
        try {
            const stamp = JSON.parse(await fs.readFile(path.join(plan.directory, 'stamp.json'), 'utf8'));
            if (stamp?.schema !== CACHE_SCHEMA || stamp.name !== PLUGIN_TEMPLATE_BUNDLE || stamp.generation !== plan.generation
                || JSON.stringify(stamp.identity) !== JSON.stringify(plan.identity)) return false;
            const state = await openCodePluginState(plan.directory, plan.version);
            return state.current && !state.unsafe;
        } catch {
            return false;
        }
    }

    // Read-only and network-free; validated from disk on every call. Null when this exact
    // OpenCode version has no prepared template.
    async peekOpenCodePlugin(version) {
        try {
            const plan = this._openCodePluginPlan(version);
            return await this._openCodePluginUsable(plan) ? { path: plan.directory, version } : null;
        } catch {
            return null;
        }
    }

    prepareOpenCodePlugin(version) {
        let plan;
        try { plan = this._openCodePluginPlan(version); } catch (error) { return Promise.reject(error); }
        return this._once(`${PLUGIN_TEMPLATE_BUNDLE}-${plan.generation}`, () => this._prepareOpenCodePlugin(plan));
    }

    async _prepareOpenCodePlugin(plan) {
        const result = { path: plan.directory, version: plan.version };
        if (await this._openCodePluginUsable(plan)) return result;
        const generations = path.dirname(plan.directory);
        await fs.mkdir(generations, { recursive: true, mode: 0o700 });
        const staging = await fs.mkdtemp(path.join(generations, '.staging-'));
        try {
            this.log(`[tool-cache] preparing ${OPENCODE_PLUGIN_PACKAGE} ${plan.version}`);
            await fs.writeFile(path.join(staging, 'package.json'),
                `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_PACKAGE]: plan.version } }, null, 2)}\n`, { mode: 0o600 });
            await this.execFileImpl(this.npmCommand, [...PLUGIN_TEMPLATE_NPM_ARGS, '--prefix', staging], {
                timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: this.processEnv,
            });
            const state = await openCodePluginState(staging, plan.version);
            if (!state.current) throw new Error(`prepared ${OPENCODE_PLUGIN_PACKAGE} is not exactly ${plan.version}`);
            await fs.writeFile(path.join(staging, 'stamp.json'), `${JSON.stringify({
                schema: CACHE_SCHEMA, name: PLUGIN_TEMPLATE_BUNDLE, generation: plan.generation, identity: plan.identity,
                versions: { [OPENCODE_PLUGIN_PACKAGE]: plan.version }, preparedAt: new Date().toISOString(),
            }, null, 2)}\n`, { mode: 0o600 });
            await fs.rename(staging, plan.directory).catch(error => {
                if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
            });
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
        if (!(await this._openCodePluginUsable(plan))) throw new Error(`${OPENCODE_PLUGIN_PACKAGE} template is not usable`);
        return result;
    }

    prepareMode(mode) {
        if (mode !== 'desktop' && mode !== 'browser') throw new Error('tool cache mode must be desktop or browser');
        return this._once(mode, () => (mode === 'desktop' ? this._prepareDesktop() : this._prepareBrowser()));
    }

    // Coalesces concurrent preparations and reuses a finished one while it is fresh: for the refresh interval, for
    // the shorter `maxAgeMs` a caller asks for, and only for the fallback retry delay when the result is a fallback
    // (a shell view counts as one when any of its agents fell back), so an unreachable registry is retried soon.
    _once(key, operation, maxAgeMs = this.refreshIntervalMs) {
        const existing = this.inflight.get(key);
        if (existing && (existing.pending || this.now() - existing.checkedAt < Math.min(maxAgeMs, existing.lifetimeMs))) return existing.promise;
        const entry = { promise: null, pending: true, checkedAt: 0, lifetimeMs: this.refreshIntervalMs };
        entry.promise = Promise.resolve().then(operation).then((result) => {
            entry.pending = false;
            entry.checkedAt = this.now();
            const fellBack = result?.fallback || Object.values(result?.agents || {}).some(agent => agent?.fallback);
            if (fellBack) entry.lifetimeMs = this.fallbackRetryMs;
            return result;
        });
        this.inflight.set(key, entry);
        entry.promise.catch(() => { if (this.inflight.get(key) === entry) this.inflight.delete(key); });
        return entry.promise;
    }

    async _npmVersion(packageName) {
        const result = await this.execFileImpl(this.npmCommand, ['view', `${packageName}@latest`, 'version', '--json'], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            env: this.processEnv,
        });
        let value;
        try { value = JSON.parse(result.stdout); } catch { value = result.stdout; }
        if (Array.isArray(value)) value = value.at(-1);
        return safeVersion(value, packageName);
    }

    async _computerUseRelease() {
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
        const response = await this.fetchImpl('https://api.github.com/repos/agent-sh/computer-use-linux/releases/latest', {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'RoboTeamAgent' },
        });
        if (!response.ok) throw new Error(`computer-use-linux release lookup failed with HTTP ${response.status}`);
        const release = await response.json();
        const target = this.arch === 'x64' ? 'x86_64' : this.arch === 'arm64' ? 'aarch64' : null;
        if (!target) throw new Error(`computer-use-linux does not support architecture ${this.arch}`);
        const assetName = `computer-use-linux-${target}-unknown-linux-gnu`;
        const asset = release.assets?.find((candidate) => candidate?.name === assetName);
        if (!asset?.browser_download_url) throw new Error(`computer-use-linux release has no ${assetName} asset`);
        return {
            version: safeVersion(release.tag_name, 'computer-use-linux'),
            assetName,
            url: asset.browser_download_url,
            upstreamDigest: String(asset.digest || ''),
        };
    }

    // `packageName` may instead be a list of exact `name@version` specifications installed together.
    async _pypiVersion(packageName) {
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
        const response = await this.fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, {
            headers: { accept: 'application/json', 'user-agent': 'RoboTeamAgent' },
        });
        if (!response.ok) throw new Error(`${packageName} release lookup failed with HTTP ${response.status}`);
        const value = await response.json();
        return safeVersion(value?.info?.version, packageName);
    }

    async _uvRelease() {
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
        const response = await this.fetchImpl('https://api.github.com/repos/astral-sh/uv/releases/latest', {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'RoboTeamAgent' },
        });
        if (!response.ok) throw new Error(`uv release lookup failed with HTTP ${response.status}`);
        const release = await response.json();
        const target = this.arch === 'x64' ? 'x86_64' : this.arch === 'arm64' ? 'aarch64' : null;
        if (!target) throw new Error(`uv does not support architecture ${this.arch}`);
        const assetName = `uv-${target}-unknown-linux-gnu.tar.gz`;
        const asset = release.assets?.find((candidate) => candidate?.name === assetName);
        if (!asset?.browser_download_url) throw new Error(`uv release has no ${assetName} asset`);
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(asset.digest || ''))) throw new Error(`uv release asset ${assetName} has no SHA-256 digest`);
        return { version: safeVersion(release.tag_name, 'uv'), assetName, url: asset.browser_download_url, digest: asset.digest };
    }

    // Downloads the uv release archive, checks its upstream digest, and unpacks the static uv binary into `directory`.
    async _downloadUv(directory, release) {
        const response = await this.fetchImpl(release.url, { headers: { 'user-agent': 'RoboTeamAgent' } });
        if (!response.ok) throw new Error(`uv download failed with HTTP ${response.status}`);
        const content = Buffer.from(await response.arrayBuffer());
        const digest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
        if (digest !== release.digest) throw new Error('uv release digest did not match the downloaded asset');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const archive = path.join(directory, release.assetName);
        await fs.writeFile(archive, content, { mode: 0o600 });
        await this.execFileImpl(this.tarCommand, ['--no-same-owner', '--strip-components=1', '-xzf', archive, '-C', directory],
            { timeout: 120000, maxBuffer: 1024 * 1024, env: this.processEnv });
        await fs.rm(archive, { force: true });
        const uv = path.join(directory, 'uv');
        if (!(await isExecutable(uv))) throw new Error('uv archive has no uv executable');
        return uv;
    }

    // The latest Antigravity CLI release: { version, url, sha512 } from Google's manifest for this architecture. Only
    // an HTTPS archive on Google's release storage is accepted.
    async _agyRelease() {
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
        const platform = this.arch === 'x64' ? 'linux_amd64' : this.arch === 'arm64' ? 'linux_arm64' : null;
        if (!platform) throw new Error(`Antigravity CLI does not support architecture ${this.arch}`);
        const response = await this.fetchImpl(`${AGY_MANIFEST_BASE_URL}/${platform}.json`, {
            headers: { accept: 'application/json', 'user-agent': 'RoboTeamAgent' },
        });
        if (!response.ok) throw new Error(`Antigravity CLI release lookup failed with HTTP ${response.status}`);
        const manifest = await response.json();
        let url;
        try { url = new URL(manifest?.url); } catch { throw new Error('Antigravity CLI manifest has no valid release URL'); }
        if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || !url.pathname.endsWith('.tar.gz')) {
            throw new Error('Antigravity CLI manifest does not reference a release archive on Google storage');
        }
        if (!/^[0-9a-f]{128}$/u.test(String(manifest?.sha512 || ''))) throw new Error('Antigravity CLI manifest has no SHA-512 digest');
        return { version: safeVersion(manifest.version, 'Antigravity CLI'), url: url.href, sha512: manifest.sha512 };
    }

    // Downloads the release archive, checks its SHA-512 digest, and unpacks its `antigravity` executable as bin/agy.
    async _downloadAgy(directory, release) {
        const response = await this.fetchImpl(release.url, { headers: { 'user-agent': 'RoboTeamAgent' } });
        if (!response.ok) throw new Error(`Antigravity CLI download failed with HTTP ${response.status}`);
        const content = Buffer.from(await response.arrayBuffer());
        if (crypto.createHash('sha512').update(content).digest('hex') !== release.sha512) {
            throw new Error('Antigravity CLI release digest did not match the downloaded archive');
        }
        const bin = path.join(directory, 'bin');
        await fs.mkdir(bin, { recursive: true, mode: 0o755 });
        const archive = path.join(directory, 'release.tar.gz');
        await fs.writeFile(archive, content, { mode: 0o600 });
        try {
            await this.execFileImpl(this.tarCommand, ['--no-same-owner', '-xzf', archive, '-C', bin, 'antigravity'],
                { timeout: 120000, maxBuffer: 1024 * 1024, env: this.processEnv });
        } finally {
            await fs.rm(archive, { force: true });
        }
        await fs.rename(path.join(bin, 'antigravity'), path.join(bin, 'agy'));
        await fs.chmod(path.join(bin, 'agy'), 0o755);
    }

    async _npmInstallHost(directory, packageName, version, { global = false } = {}) {
        const args = [NPM_INSTALL_ARGS[0], ...(global ? ['--global'] : []), ...NPM_INSTALL_ARGS.slice(1)];
        const specifications = Array.isArray(packageName) ? packageName : [`${packageName}@${version}`];
        await this.execFileImpl(this.npmCommand, [...args, '--prefix', directory, ...specifications], {
            timeout: 10 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            env: this.processEnv,
        });
    }

    async _npmInstallContainer(directory, image, packageName, version) {
        await this.execFileImpl(this.podmanCommand, [
            'run', '--rm', ...NESTED_CONTAINER_ARGS, '--network', 'pasta', '--user', '0:0',
            '-v', `${directory}:/install`, '-w', '/install',
            '--entrypoint', '/usr/local/bin/npm', image,
            ...NPM_INSTALL_ARGS, '--prefix', '/install', `${packageName}@${version}`,
        ], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: process.env });
    }

    async _downloadComputerUse(directory, release) {
        const response = await this.fetchImpl(release.url, { headers: { 'user-agent': 'RoboTeamAgent' } });
        if (!response.ok) throw new Error(`computer-use-linux download failed with HTTP ${response.status}`);
        const content = Buffer.from(await response.arrayBuffer());
        if (!content.length) throw new Error('computer-use-linux download was empty');
        const digest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
        if (release.upstreamDigest && release.upstreamDigest !== digest) {
            throw new Error('computer-use-linux release digest did not match the downloaded asset');
        }
        const target = path.join(directory, 'computer-use-linux');
        await fs.writeFile(target, content, { mode: 0o755 });
        await fs.chmod(target, 0o755);
        return digest;
    }

    async _probeInContainer(image, directory, executable, args = ['--help']) {
        await this.execFileImpl(this.podmanCommand, [
            'run', '--rm', ...NESTED_CONTAINER_ARGS, '--network', 'none',
            '-v', `${directory}:${TOOL_MOUNT_PATH}:ro`,
            '--entrypoint', `${TOOL_MOUNT_PATH}/${executable}`, image,
            ...args,
        ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: process.env });
    }

    // A uv agent: the generation holds bin/<executable> (uv's link), tools/<package> (its virtual environment) and
    // python/ (the managed CPython it was created from). uv itself is used for the installation only.
    async _prepareUvAgent(name) {
        const definition = CODING_AGENT_PACKAGES[name];
        return this._prepare(name, async () => {
            const [version, uv] = await Promise.all([
                this.versionPins[name] ?? this._pypiVersion(definition.packageName),
                this._uvRelease(),
            ]);
            const versions = { [name]: version, uv: uv.version };
            return {
                identity: { package: definition.packageName, version, installer: 'uv', uv: uv.version, python: UV_PYTHON, arch: this.arch },
                versions,
                inPlace: true,
                install: async (directory) => {
                    const work = path.join(directory, '.uv');
                    try {
                        const uvBinary = await this._downloadUv(work, uv);
                        await this.execFileImpl(uvBinary, ['tool', 'install', '--no-config', '--python', UV_PYTHON,
                            `${definition.packageName}==${version}`], {
                            timeout: 15 * 60 * 1000,
                            maxBuffer: 8 * 1024 * 1024,
                            env: { ...this.processEnv, UV_TOOL_DIR: path.join(directory, 'tools'), UV_TOOL_BIN_DIR: path.join(directory, 'bin'),
                                UV_PYTHON_INSTALL_DIR: path.join(directory, 'python'), UV_CACHE_DIR: path.join(work, 'cache'),
                                UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1' },
                        });
                    } finally {
                        await fs.rm(work, { recursive: true, force: true });
                    }
                },
                validate: async (directory) => {
                    const executable = path.join(directory, 'bin', definition.executable);
                    if (!(await isExecutable(executable))) throw new Error(`prepared ${name} executable is missing`);
                    await this.execFileImpl(executable, ['--version'], { timeout: 60000, maxBuffer: 1024 * 1024, env: this.processEnv });
                },
                result: (directory) => ({ path: directory, binPath: path.join(directory, 'bin'), versions }),
            };
        });
    }

    // The manifest names only the latest release. A pin is honoured by installing only when the manifest offers that
    // exact version; otherwise preparation fails and falls back to a stamped generation of the pinned version.
    async _prepareManifestAgent(name) {
        const definition = CODING_AGENT_PACKAGES[name];
        return this._prepare(name, async () => {
            const release = await this._agyRelease();
            const pin = this.versionPins[name];
            if (pin !== undefined && pin !== release.version) {
                throw new Error(`the Antigravity CLI manifest offers ${release.version}, not the pinned ${pin}`);
            }
            const versions = { [name]: release.version };
            return {
                identity: { package: definition.packageName, version: release.version, sha512: release.sha512, arch: this.arch },
                versions,
                install: (directory) => this._downloadAgy(directory, release),
                validate: async (directory) => {
                    const executable = path.join(directory, 'bin', definition.executable);
                    if (!(await isExecutable(executable))) throw new Error(`prepared ${name} executable is missing`);
                    await this.execFileImpl(executable, ['--version'], { timeout: 60000, maxBuffer: 1024 * 1024,
                        env: { ...this.processEnv, AGY_CLI_DISABLE_AUTO_UPDATE: '1' } });
                },
                result: (directory) => ({ path: directory, binPath: path.join(directory, 'bin'), versions }),
            };
        });
    }

    async _prepareCodingAgent(name) {
        const definition = CODING_AGENT_PACKAGES[name];
        if (definition.installer === 'uv') return this._prepareUvAgent(name);
        if (definition.installer === 'agy-manifest') return this._prepareManifestAgent(name);
        const companions = definition.companions || [];
        return this._prepare(name, async () => {
            const version = this.versionPins[name] ?? await this._npmVersion(definition.packageName);
            // Companions track their latest release; their versions are part of the generation identity.
            const companionVersions = Object.fromEntries(await Promise.all(companions.map(async (companion) => (
                [companion.executable, await this._npmVersion(companion.packageName)]))));
            const versions = { [name]: version, ...companionVersions };
            const packages = [`${definition.packageName}@${version}`,
                ...companions.map(companion => `${companion.packageName}@${companionVersions[companion.executable]}`)];
            return {
                identity: { package: definition.packageName, version, runtime: process.versions.node,
                    ...(companions.length ? { companions: companionVersions } : {}) },
                versions,
                install: (directory) => this._npmInstallHost(directory, packages, null, { global: true }),
                validate: async (directory) => {
                    const bin = path.join(directory, 'bin');
                    for (const executable of agentExecutables(definition)) {
                        if (!(await isExecutable(path.join(bin, executable)))) throw new Error(`prepared ${name} executable ${executable} is missing`);
                    }
                    // A companion runtime is found on PATH, as it is in a robot.
                    const env = companions.length ? { ...this.processEnv, PATH: [bin, this.processEnv.PATH].filter(Boolean).join(path.delimiter) } : this.processEnv;
                    await this.execFileImpl(path.join(bin, definition.executable), ['--version'], { timeout: 30000, maxBuffer: 1024 * 1024, env });
                },
                result: (directory) => ({ path: directory, binPath: path.join(directory, 'bin'), versions }),
            };
        });
    }

    async _prepareDesktop() {
        return this._prepare('desktop', async () => {
            const [supergateway, computerUse] = await Promise.all([
                this._npmVersion('supergateway'),
                this._computerUseRelease(),
            ]);
            let computerUseDigest = '';
            return {
                identity: { image: this.images.desktop, supergateway, computerUse: computerUse.version, arch: this.arch },
                versions: { supergateway, computerUseLinux: computerUse.version },
                install: async (directory) => {
                    await this._npmInstallContainer(directory, this.images.desktop, 'supergateway', supergateway);
                    computerUseDigest = await this._downloadComputerUse(directory, computerUse);
                },
                validate: async (directory) => {
                    if (!(await isExecutable(path.join(directory, 'computer-use-linux')))) throw new Error('prepared computer-use-linux executable is missing');
                    if (!(await isExecutable(executablePath(directory, 'supergateway')))) throw new Error('prepared Supergateway executable is missing');
                    await this._probeInContainer(this.images.desktop, directory, 'computer-use-linux');
                    await this._probeInContainer(this.images.desktop, directory, 'node_modules/.bin/supergateway');
                },
                metadata: () => ({ computerUseDigest }),
                result: (directory) => ({ path: directory, versions: { supergateway, computerUseLinux: computerUse.version } }),
            };
        });
    }

    async _prepareBrowser() {
        return this._prepare('browser', async () => {
            const version = await this._npmVersion('@playwright/mcp');
            return {
                identity: { image: this.images.browser, package: '@playwright/mcp', version },
                versions: { playwrightMcp: version },
                install: (directory) => this._npmInstallContainer(directory, this.images.browser, '@playwright/mcp', version),
                validate: async (directory) => {
                    if (!(await isExecutable(executablePath(directory, 'playwright-mcp')))) throw new Error('prepared Playwright MCP executable is missing');
                    await this._probeInContainer(this.images.browser, directory, 'node_modules/.bin/playwright-mcp');
                },
                result: (directory) => ({ path: directory, versions: { playwrightMcp: version } }),
            };
        });
    }

    async _prepare(name, resolvePlan) {
        let plan;
        try {
            plan = await resolvePlan();
        } catch (error) {
            return this._fallback(name, error);
        }
        const bundleRoot = path.join(this.root, name);
        const generationsRoot = path.join(bundleRoot, 'generations');
        const generation = generationName(plan.identity);
        const target = path.join(generationsRoot, generation);
        try {
            await fs.mkdir(generationsRoot, { recursive: true, mode: 0o700 });
            if (!(await this._generationIsUsable(target, plan.validate)) && plan.inPlace) {
                await this._installInPlace(name, target, generation, plan);
            } else if (!(await this._generationIsUsable(target, plan.validate))) {
                const stagingRoot = path.join(bundleRoot, 'staging');
                const staging = path.join(stagingRoot, crypto.randomUUID());
                await fs.mkdir(staging, { recursive: true, mode: 0o700 });
                try {
                    this.log(`[tool-cache] preparing ${name} ${Object.values(plan.versions).join(', ')}`);
                    await plan.install(staging);
                    await plan.validate(staging);
                    await fs.writeFile(path.join(staging, 'stamp.json'), `${JSON.stringify({
                        schema: CACHE_SCHEMA,
                        name,
                        generation,
                        identity: plan.identity,
                        versions: plan.versions,
                        preparedAt: new Date().toISOString(),
                        ...(plan.metadata?.() || {}),
                    }, null, 2)}\n`, { mode: 0o600 });
                    try { await fs.rename(staging, target); } catch (error) {
                        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
                    }
                } finally {
                    await fs.rm(staging, { recursive: true, force: true });
                }
            }
            await plan.validate(target);
            await this._writeCurrent(bundleRoot, { schema: CACHE_SCHEMA, name, generation, versions: plan.versions });
            this.log(`[tool-cache] using ${name} cache generation ${generation.slice(0, 12)}`);
            return plan.result(target);
        } catch (error) {
            return this._fallback(name, error);
        }
    }

    async _installInPlace(name, target, generation, plan) {
        const lock = `${target}.lock`;
        let handle;
        try {
            handle = await fs.open(lock, 'wx', 0o600);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const stat = await fs.stat(lock).catch(() => null);
            if (stat && this.now() - stat.mtimeMs < IN_PLACE_LOCK_STALE_MS) throw new Error(`${name} preparation is already in progress`);
            await fs.rm(lock, { force: true });
            handle = await fs.open(lock, 'wx', 0o600);
        }
        try {
            // A generation without a stamp is an interrupted installation and is started again.
            await fs.rm(target, { recursive: true, force: true });
            await fs.mkdir(target, { recursive: true, mode: 0o700 });
            this.log(`[tool-cache] preparing ${name} ${Object.values(plan.versions).join(', ')}`);
            await plan.install(target);
            await plan.validate(target);
            await fs.writeFile(path.join(target, 'stamp.json'), `${JSON.stringify({
                schema: CACHE_SCHEMA, name, generation, identity: plan.identity, versions: plan.versions,
                preparedAt: new Date().toISOString(), ...(plan.metadata?.() || {}),
            }, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
            await fs.rm(target, { recursive: true, force: true });
            throw error;
        } finally {
            await handle.close();
            await fs.rm(lock, { force: true });
        }
    }

    async _generationIsUsable(directory, validate) {
        try {
            const stamp = JSON.parse(await fs.readFile(path.join(directory, 'stamp.json'), 'utf8'));
            if (stamp?.schema !== CACHE_SCHEMA) return false;
            await validate(directory);
            return true;
        } catch {
            return false;
        }
    }

    async _writeCurrent(bundleRoot, descriptor) {
        await fs.mkdir(bundleRoot, { recursive: true, mode: 0o700 });
        const current = path.join(bundleRoot, 'current.json');
        const temporary = `${current}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, current);
    }

    async _fallback(name, cause) {
        try {
            const bundleRoot = path.join(this.root, name);
            const descriptor = JSON.parse(await fs.readFile(path.join(bundleRoot, 'current.json'), 'utf8'));
            if (descriptor?.schema !== CACHE_SCHEMA || descriptor.name !== name || !/^[0-9a-f]{64}$/u.test(descriptor.generation || '')) throw new Error('invalid current descriptor');
            const directory = path.join(bundleRoot, 'generations', descriptor.generation);
            const stamp = JSON.parse(await fs.readFile(path.join(directory, 'stamp.json'), 'utf8'));
            if (stamp?.schema !== CACHE_SCHEMA || stamp.name !== name || stamp.generation !== descriptor.generation) throw new Error('invalid cached generation stamp');
            const codingAgent = CODING_AGENT_PACKAGES[name];
            const pin = codingAgent ? this.versionPins[name] : undefined;
            if (pin !== undefined && (descriptor.versions?.[name] !== pin || stamp.versions?.[name] !== pin)) {
                throw new Error(`cached generation is not the pinned ${name} version ${pin}`);
            }
            const required = codingAgent
                ? agentExecutables(codingAgent).map(executable => path.join(directory, 'bin', executable))
                : RUNTIME_BUNDLE_FILES[name]
                    ? RUNTIME_BUNDLE_FILES[name].filter(file => file.startsWith('bin/')).map(file => path.join(directory, file))
                    : name === 'browser'
                    ? [executablePath(directory, 'playwright-mcp')]
                    : [path.join(directory, 'computer-use-linux'), executablePath(directory, 'supergateway')];
            for (const executable of required) {
                if (!(await isExecutable(executable))) throw new Error(`cached executable is missing: ${path.basename(executable)}`);
            }
            if (name === 'desktop' && stamp.computerUseDigest) {
                const content = await fs.readFile(path.join(directory, 'computer-use-linux'));
                const digest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
                if (digest !== stamp.computerUseDigest) throw new Error('cached computer-use-linux digest mismatch');
            }
            this.log(`[tool-cache] ${name} update unavailable (${cause.message}); using last valid generation ${descriptor.generation.slice(0, 12)}`);
            return {
                path: directory,
                ...(codingAgent ? { binPath: path.join(directory, 'bin') } : {}),
                versions: descriptor.versions || stamp.versions || {},
                fallback: true,
            };
        } catch (fallbackError) {
            throw new Error(`could not prepare ${name} tools: ${cause.message}; no valid fallback cache: ${fallbackError.message}`);
        }
    }
}

export const toolCacheInternals = { CACHE_SCHEMA, CODING_AGENT_PACKAGES, NESTED_CONTAINER_ARGS, NPM_INSTALL_ARGS, PLUGIN_TEMPLATE_NPM_ARGS, TOOL_MOUNT_PATH, codingAgentVersionPins, generationName, safeVersion, toolProcessEnv };
