import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE_SCHEMA = 'roboteam-tool-cache-v1';
const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
const TOOL_MOUNT_PATH = '/opt/roboteam-tools';

function safeVersion(value, label) {
    const version = String(value || '').trim().replace(/^v(?=\d)/u, '');
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(version)) {
        throw new Error(`${label} returned an invalid version`);
    }
    return version;
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
        this.root = path.resolve(options.root || path.join(options.dataDir || '/data', 'tool-cache'));
        this.podmanCommand = options.podmanCommand || '/usr/bin/podman';
        this.npmCommand = options.npmCommand || '/usr/local/bin/npm';
        this.images = {
            desktop: options.desktopImage || 'docker.io/assistos/roboteam-desktop:runtime',
            browser: options.browserImage || 'docker.io/assistos/roboteam-browser:runtime',
        };
        this.execFileImpl = options.execFileImpl || execFileAsync;
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.arch = options.arch || process.arch;
        this.log = options.log || ((message) => console.log(message));
        this.refreshIntervalMs = Math.max(60000, Number(options.refreshIntervalMs) || 6 * 60 * 60 * 1000);
        this.now = options.now || Date.now;
        this.inflight = new Map();
    }

    prepareCodex() {
        return this._once('codex', () => this._prepareCodex());
    }

    prepareMode(mode) {
        if (mode !== 'desktop' && mode !== 'browser') throw new Error('tool cache mode must be desktop or browser');
        return this._once(mode, () => (mode === 'desktop' ? this._prepareDesktop() : this._prepareBrowser()));
    }

    _once(key, operation) {
        const existing = this.inflight.get(key);
        if (existing && (existing.pending || this.now() - existing.checkedAt < this.refreshIntervalMs)) return existing.promise;
        const entry = { promise: null, pending: true, checkedAt: 0 };
        entry.promise = Promise.resolve().then(operation).then((result) => {
            entry.pending = false;
            entry.checkedAt = this.now();
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
            env: process.env,
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

    async _npmInstallHost(directory, packageName, version, { global = false } = {}) {
        const args = [NPM_INSTALL_ARGS[0], ...(global ? ['--global'] : []), ...NPM_INSTALL_ARGS.slice(1)];
        await this.execFileImpl(this.npmCommand, [...args, '--prefix', directory, `${packageName}@${version}`], {
            timeout: 10 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
        });
    }

    async _npmInstallContainer(directory, image, packageName, version) {
        await this.execFileImpl(this.podmanCommand, [
            'run', '--rm', '--network', 'pasta', '--user', '0:0',
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
            'run', '--rm', '--network', 'none',
            '-v', `${directory}:${TOOL_MOUNT_PATH}:ro`,
            '--entrypoint', `${TOOL_MOUNT_PATH}/${executable}`, image,
            ...args,
        ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: process.env });
    }

    async _prepareCodex() {
        return this._prepare('codex', async () => {
            const version = await this._npmVersion('@openai/codex');
            return {
                identity: { package: '@openai/codex', version, runtime: process.versions.node },
                versions: { codex: version },
                install: (directory) => this._npmInstallHost(directory, '@openai/codex', version, { global: true }),
                validate: async (directory) => {
                    const executable = path.join(directory, 'bin', 'codex');
                    if (!(await isExecutable(executable))) throw new Error('prepared Codex executable is missing');
                    await this.execFileImpl(executable, ['--version'], { timeout: 30000, maxBuffer: 1024 * 1024, env: process.env });
                },
                result: (directory) => ({ path: directory, binPath: path.join(directory, 'bin'), versions: { codex: version } }),
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
            if (!(await this._generationIsUsable(target, plan.validate))) {
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
            const required = name === 'codex'
                ? [path.join(directory, 'bin', 'codex')]
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
                ...(name === 'codex' ? { binPath: path.join(directory, 'bin') } : {}),
                versions: descriptor.versions || stamp.versions || {},
                fallback: true,
            };
        } catch (fallbackError) {
            throw new Error(`could not prepare ${name} tools: ${cause.message}; no valid fallback cache: ${fallbackError.message}`);
        }
    }
}

export const toolCacheInternals = { CACHE_SCHEMA, NPM_INSTALL_ARGS, TOOL_MOUNT_PATH, generationName, safeVersion };
