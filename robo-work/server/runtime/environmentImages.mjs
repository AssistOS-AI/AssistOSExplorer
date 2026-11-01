import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { environmentError, openImageRoot } from '../sandbox/environmentRootfs.mjs';
import { createRootfsRecovery } from '../sandbox/environmentRootfs.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REF = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/u;
const PATH_DEFAULT = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const OWNED = /^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|OPENCODE_CONFIG|XDG_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu;
const SHELL = /^(IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|LD_.*|BASH_FUNC_.*|_)$/u;
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const WRAPPER_TARGETS = Object.freeze({
    codex: '/opt/robo-work-tools/node_modules/@openai/codex/bin/codex.js',
    claude: '/opt/robo-work-tools/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    opencode: '/opt/robo-work-tools/node_modules/opencode-ai/bin/opencode.exe',
    pi: '/opt/robo-work-tools/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
});

export function defaultAgentImagesFetch({ env = process.env } = {}) {
    const directory = String(env.ROBO_WORK_PLOINKY_AGENT_DIR || '/Agent');
    let reader = null;
    return async ({ signal } = {}) => {
        reader ??= import(pathToFileURL(path.join(directory, 'lib', 'agentImages.mjs')).href).catch((error) => { reader = null; throw error; });
        const module = await reader;
        if (typeof module.fetchAgentImages !== 'function') throw environmentError('runtime_unavailable');
        return module.fetchAgentImages({ env, signal });
    };
}

export function filterImageEnv(entries = []) {
    if (!Array.isArray(entries) || entries.length > 64 || Buffer.byteLength(JSON.stringify(entries)) > 16384) throw environmentError('image_mismatch');
    const env = {};
    let imagePath = PATH_DEFAULT;
    for (const entry of entries) {
        if (typeof entry !== 'string' || entry.includes('\0')) throw environmentError('image_mismatch');
        const split = entry.indexOf('=');
        const key = entry.slice(0, split);
        const value = entry.slice(split + 1);
        if (split < 1 || !/^[A-Z_][A-Z0-9_]*$/u.test(key) || SHELL.test(key)) continue;
        if (key === 'PATH') { if (value && value.length <= 4096) imagePath = value; continue; }
        if (!OWNED.test(key)) env[key] = value;
    }
    return { ...env, PATH: `/rw-opt/bin:${imagePath}` };
}

export function compareAbi(left, right) {
    const parse = (value) => {
        if (typeof value !== 'string' || !/^\d+(?:\.\d+)+$/u.test(value)) throw environmentError('runtime_unavailable');
        const parts = value.split('.').map(Number);
        if (parts.some((part) => !Number.isSafeInteger(part))) throw environmentError('runtime_unavailable');
        return parts;
    };
    const a = parse(left); const b = parse(right);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
    }
    return 0;
}

// Read the ELF definition table, not strings or required-version tags (which cannot prove that a library supplies an ABI).
export function elfDefinedVersions(bytes) {
    if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1) return [];
    const off = Number(bytes.readBigUInt64LE(40));
    const size = bytes.readUInt16LE(58); const count = bytes.readUInt16LE(60);
    if (size < 64 || off + size * count > bytes.length) return [];
    const section = (index) => {
        const at = off + index * size;
        return { type: bytes.readUInt32LE(at + 4), start: Number(bytes.readBigUInt64LE(at + 24)), length: Number(bytes.readBigUInt64LE(at + 32)), link: bytes.readUInt32LE(at + 40) };
    };
    const versions = [];
    for (let i = 0; i < count; i += 1) {
        const table = section(i);
        if (table.type !== 0x6ffffffd || table.link >= count || table.start + table.length > bytes.length) continue;
        const strings = section(table.link);
        if (strings.start + strings.length > bytes.length) continue;
        let cursor = table.start;
        for (let n = 0; n < 4096 && cursor + 20 <= table.start + table.length; n += 1) {
            const aux = cursor + bytes.readUInt32LE(cursor + 12);
            if (aux + 8 > table.start + table.length) break;
            const name = strings.start + bytes.readUInt32LE(aux);
            if (name >= strings.start + strings.length) break;
            const end = bytes.indexOf(0, name);
            if (end < name || end >= strings.start + strings.length) break;
            versions.push(bytes.subarray(name, end).toString('ascii'));
            const next = bytes.readUInt32LE(cursor + 16);
            if (!next) break;
            cursor += next;
        }
    }
    return versions;
}

export function readEnvironmentContract(file = '/opt/robo-work-runtime/environment-contract.json') {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 65536) throw environmentError('runtime_unavailable');
    const contract = JSON.parse(bytes);
    if (contract.schemaVersion !== 1 || !['amd64', 'arm64'].includes(contract.architecture) || !/^\d+\.\d+$/u.test(contract.glibcFloor)
        || !Array.isArray(contract.glibcxxVersions) || !Array.isArray(contract.cxxabiVersions)
        || [...contract.glibcxxVersions, ...contract.cxxabiVersions].some((v) => !/^\d+(?:\.\d+)+$/u.test(v))
        || contract.tools?.node !== '/usr/local/bin/node' || contract.caBundle !== '/opt/robo-work-runtime/ca/ca-bundle.crt'
        || contract.tools?.claude !== WRAPPER_TARGETS.claude || contract.tools?.opencode !== WRAPPER_TARGETS.opencode
        || Object.entries(WRAPPER_TARGETS).some(([name, target]) => contract.wrapperTargets?.[name] !== target)
        || contract.injections?.node !== '/rw-opt/node/bin/node' || contract.injections?.tools !== '/rw-opt/tools'
        || contract.injections?.ca !== '/rw-opt/ca/ca-bundle.crt' || contract.injections?.bin !== '/rw-opt/bin') throw environmentError('runtime_unavailable');
    return { ...contract, fingerprint: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function checkImageCompatibility(root, contract, options = {}) {
    const image = openImageRoot(root, options);
    try {
        for (const executable of ['/bin/sh', '/usr/bin/env']) {
            let st;
            try { st = image.stat(executable); } catch { throw environmentError('image_no_shell'); }
            if (!st.isFile() || !(st.mode & 0o111)) throw environmentError('image_no_shell');
        }
        const multiarch = contract.architecture === 'amd64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu';
        const directories = [`/lib/${multiarch}`, `/usr/lib/${multiarch}`, '/lib64', '/usr/lib64', '/lib', '/usr/lib'];
        const library = (name) => {
            for (const dir of directories) { try { return image.read(`${dir}/${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
            return null;
        };
        const libc = library('libc.so.6');
        if (!libc) {
            let names = [];
            try { names = image.list('/lib'); } catch { /* absent library directory */ }
            const musl = names.some((name) => name.startsWith('ld-musl-'));
            throw environmentError(musl ? 'image_musl' : 'image_glibc_old');
        }
        const glibc = elfDefinedVersions(libc).filter((name) => /^GLIBC_\d+\.\d+$/u.test(name)).map((name) => name.slice(6)).sort(compareAbi).at(-1);
        if (!glibc || compareAbi(glibc, contract.glibcFloor) < 0) throw environmentError('image_glibc_old');
        const stdcpp = library('libstdc++.so.6');
        if (!stdcpp || !library('libgcc_s.so.1')) throw environmentError('image_glibc_old');
        const supplied = new Set(elfDefinedVersions(stdcpp));
        if (contract.glibcxxVersions.some((version) => !supplied.has(`GLIBCXX_${version}`))
            || contract.cxxabiVersions.some((version) => !supplied.has(`CXXABI_${version}`))) throw environmentError('image_glibc_old');
        return { glibc };
    } finally { image.close(); }
}

export function createEnvironmentImages({ dataDir, podman, fetchAgentImages = defaultAgentImagesFetch(), selfId, coordinators = [],
    limits = {}, clock = { now: Date.now }, log = () => {}, contract: suppliedContract = null, checkCompatibility = checkImageCompatibility } = {}) {
    const file = path.join(dataDir, 'environment', 'images.json');
    const flights = new Map();
    const pins = new Map();
    const pending = new Map();
    let collecting = Promise.resolve();
    let acquisitions = 0;
    let records = {};
    let contract = suppliedContract;
    let closed = false;
    const validLimits = ['pullTimeoutMs', 'imageMaxBytes', 'memoryBytes', 'pids', 'retainDays', 'storeMaxBytes'].every((key) => limits[key] === undefined
        || (Number.isSafeInteger(limits[key]) && limits[key] > 0)) && (limits.cpus === undefined || (Number.isFinite(limits.cpus) && limits.cpus > 0))
        && (limits.pullTimeoutMs === undefined || limits.pullTimeoutMs <= 900000) && (limits.imageMaxBytes === undefined || limits.imageMaxBytes <= 8 * 1024 ** 3);
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 2 * 1024 * 1024) throw new Error('Invalid image records');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.schemaVersion === 1 && value.images && typeof value.images === 'object') records = value.images;
    } catch (error) { if (error.code !== 'ENOENT') log('environment_records_unavailable'); }
    const save = () => {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, images: records })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
    };
    async function catalog(signal) {
        let answer;
        try { answer = await fetchAgentImages({ signal }); } catch { throw environmentError('runtime_unavailable'); }
        if (answer?.schemaVersion !== 1 || !Array.isArray(answer.agents) || answer.agents.length > 256) throw environmentError('runtime_unavailable');
        return answer.agents.filter((entry) => REF.test(entry.ref) && !entry.ref.split('/').some((part) => part === '.' || part === '..')
            && entry.enableMode === 'global' && `agent:${entry.ref}` !== selfId && !coordinators.includes(`agent:${entry.ref}`));
    }
    function reasonFor(entry) {
        if (!['podman', 'docker'].includes(entry.runtime)) return 'not_container';
        if (!entry.image) return entry.reason === 'not_container' ? 'not_container' : 'digest_unknown';
        const { reference, digest, imageId } = entry.image;
        if (typeof reference !== 'string' || !/^(?:[a-z0-9.-]+\.[a-z0-9.-]+(?::\d+)?|localhost(?::\d+)?|[a-z0-9-]+:\d+)\/[a-z0-9_./-]+$/u.test(reference)
            || reference.split('/').some((part) => !part || part === '.' || part === '..') || !DIGEST.test(digest) || !(imageId === null || DIGEST.test(imageId))) return 'digest_unknown';
        return null;
    }
    async function acquire(entry, signal) {
        const { reference, digest, imageId } = entry.image;
        const exact = `${reference}@${digest}`;
        let inspected = await podman.run(['image', 'inspect', exact], { signal });
        if (inspected.status !== 0) {
            const pulled = await podman.run(['pull', '--tls-verify=true', '--authfile', path.join(dataDir, 'environment', 'podman-home', 'auth.json'), exact], {
                signal, timeoutMs: limits.pullTimeoutMs ?? 900000,
            });
            if (pulled.status !== 0) throw environmentError('pull_failed');
            log('environment_image_pulled', { digest });
            inspected = await podman.run(['image', 'inspect', exact], { signal });
        }
        let info;
        try { [info] = JSON.parse(inspected.stdout); } catch { throw environmentError('image_mismatch'); }
        if (inspected.status !== 0 || !DIGEST.test(info?.Id) || !info.RepoDigests?.includes(exact)) throw environmentError('image_mismatch');
        if (!Number.isSafeInteger(info.Size) || info.Size < 0) throw environmentError('image_mismatch');
        // Track every verified acquired image, including a refused architecture/config identity, so it counts against the cap.
        records[info.Id] = { ...records[info.Id], ref: entry.ref, digest, reference, size: info.Size, lastUsed: clock.now() };
        save();
        if (imageId !== null && info.Id !== imageId) throw environmentError('image_mismatch');
        if (info.Architecture !== ARCH) throw environmentError('image_arch');
        if (info.Size > (limits.imageMaxBytes ?? 8 * 1024 ** 3)) {
            const removed = await podman.run(['rmi', info.Id], { signal });
            if (removed.status === 0) { delete records[info.Id]; save(); }
            throw environmentError('image_too_large');
        }
        return { imageId: info.Id, imageEnv: filterImageEnv(info.Config?.Env ?? []), size: info.Size };
    }
    async function prepare({ ref, activity = () => {}, signal } = {}) {
        // Until verification yields a pinned config ID, any alias may resolve to any recorded image. Protect the whole
        // store, including unknown-ID resolutions. The collecting queue is the deletion mutex; acquisitions wait it,
        // while GC never waits an acquisition and therefore cannot deadlock this handoff.
        acquisitions += 1;
        let token = null;
        let imagePin = null;
        try {
            if (closed || signal?.aborted || !podman?.available || !validLimits) throw environmentError('runtime_unavailable');
            contract ??= readEnvironmentContract();
            if (contract.architecture !== ARCH) throw environmentError('image_arch');
            const entries = await catalog(signal);
            const entry = entries.find((candidate) => candidate.ref === ref);
            if (!entry) throw environmentError('not_listed');
            const reason = reasonFor(entry);
            if (reason) throw environmentError(reason);
            // Serialize the pin handoff with GC: register the resolution before waiting for any in-flight collection.
            token = `${entry.image.reference}@${entry.image.digest}`;
            pending.set(token, (pending.get(token) ?? 0) + 1);
            await collecting;
            if (closed || signal?.aborted) throw environmentError('runtime_unavailable');
            const flightKey = entry.image.digest;
            let flight = flights.get(flightKey);
            if (!flight) {
                const controller = new AbortController();
                flight = { controller, waiters: new Set(), promise: null };
                flight.promise = acquire(entry, controller.signal).finally(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey); });
                flights.set(flightKey, flight);
            }
            const waiter = {};
            flight.waiters.add(waiter);
            const tick = setInterval(() => { try { activity(); } catch { /* advisory */ } }, 30000);
            let onAbort;
            let acquired;
            try {
                const aborted = new Promise((_, reject) => {
                    onAbort = () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
                    signal?.addEventListener('abort', onAbort, { once: true });
                    if (signal?.aborted) onAbort();
                });
                acquired = await Promise.race([flight.promise, aborted]);
            } finally {
                clearInterval(tick);
                signal?.removeEventListener('abort', onAbort);
                flight.waiters.delete(waiter);
                if (!flight.waiters.size && flights.get(flightKey) === flight) {
                    flight.controller.abort();
                    await flight.promise.catch(() => {});
                }
            }
            if (closed || signal?.aborted) throw environmentError('runtime_unavailable');
            // Each waiter checks its own lease-supplied config ID, even when it shared another ref's acquisition.
            if (entry.image.imageId !== null && acquired.imageId !== entry.image.imageId) throw environmentError('image_mismatch');
            const { imageId } = acquired;
            pins.set(imageId, (pins.get(imageId) ?? 0) + 1);
            imagePin = imageId;
            records[imageId] = { ...records[imageId], ref, digest: entry.image.digest, reference: entry.image.reference, size: acquired.size, lastUsed: clock.now() };
            save();
            let released = false;
            return Object.freeze({ ref, digest: entry.image.digest, imageId, imageEnv: acquired.imageEnv,
                contract, async checkRootfs(root) {
                    const cached = records[imageId]?.compatibility;
                    if (cached?.fingerprint === contract.fingerprint) {
                        if (cached.reason) throw environmentError(cached.reason);
                        return cached;
                    }
                    let verdict;
                    try { verdict = { ...checkCompatibility(root, contract), reason: null, fingerprint: contract.fingerprint }; }
                    catch (error) { verdict = { reason: error.reason ?? 'image_glibc_old', fingerprint: contract.fingerprint }; }
                    records[imageId].compatibility = verdict; save();
                    if (verdict.reason) throw environmentError(verdict.reason);
                    return verdict;
                },
                release() {
                    if (released) return; released = true;
                    const count = (pins.get(imageId) ?? 1) - 1;
                    if (count) pins.set(imageId, count); else pins.delete(imageId);
                    records[imageId].lastUsed = clock.now(); save();
                },
            });
        } catch (error) {
            if (imagePin) { const count = (pins.get(imagePin) ?? 1) - 1; if (count) pins.set(imagePin, count); else pins.delete(imagePin); }
            const reason = error.reason ?? (error.code === 'ETIMEDOUT' ? 'pull_timeout' : error.code === 'ABORT_ERR' ? 'pull_failed' : 'runtime_unavailable');
            log('environment_unavailable', { reason });
            throw environmentError(reason);
        } finally {
            acquisitions -= 1;
            if (token) { const count = (pending.get(token) ?? 1) - 1; if (count) pending.set(token, count); else pending.delete(token); }
        }
    }
    async function gc() {
        const run = async () => {
            if (closed || !podman?.available || acquisitions > 0) return;
            const entries = await catalog();
            const active = new Set(entries.filter((entry) => !reasonFor(entry)).map((entry) => entry.image.digest));
            // --last explicitly includes every state. The cap proves completeness only below the sentinel length.
            const listed = await podman.run(['container', 'list', '--last=257', '--no-trunc', '--format', 'json']);
            let containers;
            try { containers = JSON.parse(listed.stdout); } catch { return; }
            if (listed.status !== 0 || !Array.isArray(containers) || containers.length >= 257) return;
            const refs = new Set();
            for (const container of containers) {
                const imageId = container.ImageID;
                if (typeof imageId !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(imageId)) return;
                refs.add(imageId.startsWith('sha256:') ? imageId : `sha256:${imageId}`);
            }
            const unused = Object.entries(records).filter(([id, record]) => DIGEST.test(id) && Number.isSafeInteger(record.size)
                && Number.isFinite(record.lastUsed) && !pins.has(id) && !refs.has(id)
                && !pending.has(`${record.reference}@${record.digest}`)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            let total = Object.values(records).reduce((sum, record) => sum + (Number.isSafeInteger(record.size) ? record.size : 0), 0);
            for (const [id, record] of unused) {
                const eligible = !active.has(record.digest) || clock.now() - record.lastUsed >= (limits.retainDays ?? 7) * 86400000;
                if (!eligible && total <= (limits.storeMaxBytes ?? 40 * 1024 ** 3)) continue;
                if (acquisitions > 0 || pins.has(id) || pending.has(`${record.reference}@${record.digest}`)) continue;
                const inspected = await podman.run(['image', 'inspect', id]);
                let info;
                try { [info] = JSON.parse(inspected.stdout); } catch { continue; }
                if (inspected.status !== 0 || info?.Id !== id || acquisitions > 0 || pins.has(id) || pending.has(`${record.reference}@${record.digest}`)) continue;
                const removed = await podman.run(['rmi', id]);
                if (removed.status === 0) { total -= record.size; delete records[id]; save(); }
            }
        };
        collecting = collecting.then(run, run).catch(() => { log('environment_gc_unavailable'); });
        await collecting;
    }
    return { prepare, gc,
        async recoverOrphans({ workspaceId, resourceForName }) {
            if (!podman?.available) return;
            const listed = await podman.run(['container', 'list', '--last=257', '--no-trunc', '--format', 'json']);
            let containers;
            try { containers = JSON.parse(listed.stdout); } catch { return; }
            if (listed.status !== 0 || !Array.isArray(containers) || containers.length >= 257) return;
            const recovery = createRootfsRecovery({ podman });
            for (const container of containers) {
                const names = Array.isArray(container.Names) ? container.Names : [container.Names];
                for (const name of names) {
                    if (!/^rw-env-[a-f0-9]{32}$/u.test(name)) continue;
                    const resource = resourceForName(name);
                    if (resource && !['released', 'released_by_operator'].includes(resource.state)) continue;
                    const inspected = await podman.run(['inspect', '--type', 'container', name]);
                    let info;
                    try { [info] = JSON.parse(inspected.stdout); } catch { continue; }
                    if (inspected.status !== 0 || info?.Config?.Labels?.['robo-work.workspace'] !== workspaceId
                        || info.Config.Labels['robo-work.reservation'] !== name.slice(7)) continue;
                    const locator = { name, label: `robo-work.reservation=${name.slice(7)}`, mergedPath: info.GraphDriver?.Data?.MergedDir };
                    if (recovery.remove(locator)) log('environment_orphan_removed', { name });
                    else log('environment_orphan_preserved', { name });
                }
            }
        },
        async list() {
            const entries = await catalog();
            let contractAvailable = true;
            try { contract ??= readEnvironmentContract(); } catch { contractAvailable = false; }
            return entries.filter((entry) => ['podman', 'docker'].includes(entry.runtime)).map((entry) => {
                const [repo, name] = entry.ref.split('/');
                const cached = entry.image?.imageId ? records[entry.image.imageId]?.compatibility : null;
                const reason = reasonFor(entry) ?? (cached?.fingerprint === contract?.fingerprint ? cached?.reason : null);
                const runtimeAvailable = Boolean(podman?.available && contractAvailable && validLimits);
                return { ref: entry.ref, name, repo, about: String(entry.about ?? '').slice(0, 4096), available: !reason && runtimeAvailable, reason: reason ?? (runtimeAvailable ? null : 'runtime_unavailable') };
            });
        },
        markUsed(imageId) { if (records[imageId]) { records[imageId].lastUsed = clock.now(); save(); } },
        close() { closed = true; for (const flight of flights.values()) flight.controller.abort(); podman?.close(); },
    };
}
