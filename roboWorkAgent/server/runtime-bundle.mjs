import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { waitForPreparation, preparationCancelled } from './preparation.mjs';

// The tools a robot phase needs inside another Ploinky agent's container, kept in the tool cache
// (`/data/tool-cache`, the workspace folder `.data/roboTeamAgent/tool-cache`) beside the coding agents,
// where every global-mode agent sees them at the same path:
//   bwrap - a fully static Bubblewrap, built once in RoboTeam's nested Podman from the checksum-pinned
//           upstream release, for images without bwrap;
//   ala   - ALA itself, only when its package is outside the workspace (normally the link-installed
//           workspace checkout is used as it is).
// Each is a cache generation with stamp.json and current.json like the coding agents. Node.js is not
// shipped: ALA and the coding agents run on the `node` of the target agent's own image.

export const STATIC_BWRAP = Object.freeze({
    version: '0.11.0',
    source: 'https://github.com/containers/bubblewrap/releases/download/v0.11.0/bubblewrap-0.11.0.tar.xz',
    sha256: '988fd6b232dafa04b8b8198723efeaccdb3c6aa9c1c7936219d5791a8b7a8646',
    builder: 'docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
});

// The files that make a cached generation usable when an update cannot be prepared.
export const RUNTIME_BUNDLE_FILES = Object.freeze({
    bwrap: ['bin/bwrap'],
    ala: ['bin/ala.mjs', 'package.json'],
});

const BWRAP_BUILD_SCRIPT = [
    'set -eux',
    'apk add --no-cache build-base meson ninja libcap-dev libcap-static linux-headers pkgconf curl xz >/dev/null',
    `curl --fail --location --silent --show-error ${STATIC_BWRAP.source} -o /tmp/bubblewrap.tar.xz`,
    `printf '%s  %s\\n' ${STATIC_BWRAP.sha256} /tmp/bubblewrap.tar.xz | sha256sum -c -`,
    'tar --no-same-owner -xJf /tmp/bubblewrap.tar.xz -C /tmp',
    `cd /tmp/bubblewrap-${STATIC_BWRAP.version}`,
    'meson setup build -Dselinux=disabled -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled'
        + ' --default-library=static -Dc_link_args=-static --prefer-static >/dev/null',
    'ninja -C build bwrap >/dev/null',
    'strip build/bwrap',
    'if readelf -d build/bwrap | grep -q NEEDED; then echo "bwrap is not static" >&2; exit 1; fi',
    'install -D -m 0755 build/bwrap /out/bin/bwrap',
].join('\n');

async function isExecutable(filePath) {
    try { await fs.access(filePath, constants.X_OK); return true; } catch { return false; }
}

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Copies ALA's runtime files (it has no npm runtime dependencies) into a cache generation.
async function copyAla(packageRoot, target) {
    for (const entry of ['bin', 'src', 'package.json']) {
        await fs.cp(path.join(packageRoot, entry), path.join(target, entry), { recursive: true, dereference: true });
    }
}

export class RuntimeBundle {
    constructor({ toolCache, workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT || '', alaEntry = null, log = message => console.log(message) } = {}) {
        if (!toolCache) throw new Error('runtime bundle requires the tool cache');
        Object.assign(this, { toolCache, workspaceRoot: workspaceRoot ? path.resolve(workspaceRoot) : '', alaEntry, log });
    }

    warmup() {
        if (!this.warming) {
            this.warmupAbort = new AbortController();
            this.warming = this.prepare({ signal: this.warmupAbort.signal });
        }
        return this.warming;
    }

    async close() {
        this.warmupAbort?.abort();
        await this.warming?.catch(() => {});
    }

    // { root, bwrap, ala } with absolute paths inside the tool cache or the workspace.
    async prepare({ signal } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort, { once: true });
        const operations = [this.prepareBwrap({ signal: controller.signal }), waitForPreparation(this.prepareAla(), controller.signal)];
        let bwrap, ala;
        try { [bwrap, ala] = await Promise.all(operations); }
        catch (error) { controller.abort(); await Promise.allSettled(operations); throw error; }
        finally { signal?.removeEventListener('abort', abort); }
        // A fallback generation (update unavailable) carries only its path; derive the files from it.
        return {
            root: this.toolCache.root,
            bwrap: { ...bwrap, bin: bwrap.bin || path.join(bwrap.path, 'bin', 'bwrap') },
            ala: { ...ala, entry: ala.entry || path.join(ala.path, 'bin', 'ala.mjs') },
        };
    }

    async prepareBwrap({ signal } = {}) {
        if (signal?.aborted) throw preparationCancelled();
        if (this.bwrapPending?.controller.signal.aborted) {
            await this.bwrapPending.promise.catch(() => {});
            return this.prepareBwrap({ signal });
        }
        let pending = this.bwrapPending;
        if (!pending) {
            pending = { controller: new AbortController(), consumers: 0 };
            pending.promise = this.buildBwrap(pending.controller.signal);
            this.bwrapPending = pending;
            void pending.promise.finally(() => { if (this.bwrapPending === pending) this.bwrapPending = null; }).catch(() => {});
        }
        pending.consumers++;
        try { return await waitForPreparation(pending.promise, signal); }
        finally {
            pending.consumers--;
            if (!pending.consumers && this.bwrapPending === pending) {
                pending.controller.abort();
                // An owned builder is gone before the cancelled preparation settles.
                await pending.promise.catch(error => { if (error.code === 'PREPARATION_CLEANUP_FAILED') throw error; });
            }
        }
    }

    buildBwrap(signal) {
        let cleanupError;
        return this.toolCache._prepare('bwrap', async () => ({
            identity: { ...STATIC_BWRAP, arch: process.arch },
            versions: { bwrap: STATIC_BWRAP.version },
            install: async (directory) => {
                this.log(`[tool-cache] building static Bubblewrap ${STATIC_BWRAP.version} in nested Podman`);
                const name = `robowork-bwrap-${randomUUID()}`;
                try {
                    await this.toolCache.execFileImpl(this.toolCache.podmanCommand, [
                        'run', '--rm', '--name', name, '--ipc', 'none', '--network', 'pasta', '--user', '0:0', '-v', `${directory}:/out`,
                        STATIC_BWRAP.builder, 'sh', '-c', BWRAP_BUILD_SCRIPT,
                    ], { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: process.env, signal });
                    if (signal.aborted) throw preparationCancelled();
                } finally {
                    if (signal.aborted) {
                        try {
                            await this.toolCache.execFileImpl(this.toolCache.podmanCommand,
                                ['rm', '-f', '--ignore', name], { timeout: 30000, maxBuffer: 1024 * 1024, env: process.env });
                        } catch {
                            cleanupError = Object.assign(new Error('Could not stop the owned runtime builder'), { code: 'PREPARATION_CLEANUP_FAILED' });
                            throw cleanupError;
                        }
                    }
                }
            },
            validate: async (directory) => {
                const binary = path.join(directory, 'bin', 'bwrap');
                if (!(await isExecutable(binary))) throw new Error('prepared bwrap executable is missing');
                await this.toolCache.execFileImpl(binary, ['--version'], { timeout: 30000, maxBuffer: 64 * 1024 });
            },
            result: (directory) => ({ path: directory, bin: path.join(directory, 'bin', 'bwrap'), version: STATIC_BWRAP.version }),
        })).then(result => {
            if (cleanupError) throw cleanupError;
            if (signal.aborted) throw preparationCancelled();
            return result;
        }, error => { throw cleanupError || error; });
    }

    // ALA from the workspace checkout when another agent can see it there, otherwise a cached copy.
    async prepareAla() {
        const entry = await fs.realpath(this.alaEntry || (await import('./ala-command.mjs')).resolveAlaCommand());
        const packageRoot = path.dirname(path.dirname(entry));
        const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
        if (manifest.name !== 'advanced-language-agent') throw new Error('ALA package root is not advanced-language-agent');
        if (this.workspaceRoot && isWithin(this.workspaceRoot, packageRoot)) {
            return { path: packageRoot, entry, version: manifest.version, source: 'workspace' };
        }
        return this.toolCache._once('runtime-ala', () => this.toolCache._prepare('ala', async () => ({
            identity: { package: manifest.name, version: manifest.version, root: packageRoot },
            versions: { ala: manifest.version },
            install: (directory) => copyAla(packageRoot, directory),
            validate: async (directory) => {
                const copied = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
                if (copied.name !== manifest.name || copied.version !== manifest.version) throw new Error('cached ALA differs');
            },
            result: (directory) => ({ path: directory, entry: path.join(directory, 'bin', 'ala.mjs'), version: manifest.version, source: 'tool-cache' }),
        })));
    }
}
