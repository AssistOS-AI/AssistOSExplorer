import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOST = 'proxiesserve';
const HOST_HOME = '/home/admin';
const UID = 1001;
const INSTANCE = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
const CONTEXTS = ['podman', 'podmanRoot', 'docker', 'dockerRoot'];
const PATH_NAMES = ['explorerQaWorkspace', '.qa-e2e', '.qa-reset-20260911-onlyoffice-webmeet', '.qa-reset-20260911-onlyoffice-webmeet-2'];
function fail(code) { throw Object.assign(new Error(code), { code: `HOST_CLEANUP_${code}` }); }
function requireProof(value, code) { if (!value) fail(code); }
function id(value) {
    const result = String(value || '').replace(/^sha256:/, '');
    requireProof(/^[a-f0-9]{64}$/.test(result), 'INVALID_ID');
    return result;
}
function canonical(value) {
    requireProof(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
        && !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_PATH');
    return value;
}
function overlaps(left, right) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function snapshot(raw) {
    requireProof(raw && typeof raw.available === 'boolean', 'INVALID_CONTEXT');
    if (!raw.available) return { available: false };
    requireProof(Array.isArray(raw.containers) && Array.isArray(raw.images), 'INVALID_INVENTORY');
    const containers = raw.containers.map(row => ({
        id: id(row.id), image: id(row.image),
        mounts: (row.mounts || []).map(mount => ({ type: String(mount.type),
            source: canonical(mount.source), destination: canonical(mount.destination) }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const images = raw.images.map(value => id(typeof value === 'string' ? value : value.id)).sort();
    requireProof(new Set(containers.map(row => row.id)).size === containers.length
        && new Set(images).size === images.length, 'DUPLICATE_RESOURCE');
    return { available: true, containers, images };
}
function inventory(raw) {
    requireProof(raw && CONTEXTS.every(context => Object.hasOwn(raw, context)), 'INCOMPLETE_INVENTORY');
    return Object.fromEntries(CONTEXTS.map(context => [context, snapshot(raw[context])]));
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function validateCleanupPlan(plan, host) {
    requireProof(plan?.version === 1 && plan.host === HOST && plan.user === 'admin'
        && host.host === HOST && host.user === 'admin' && host.uid === UID && host.home === HOST_HOME, 'HOST_MISMATCH');
    requireProof(Array.isArray(plan.paths) && plan.paths.length <= PATH_NAMES.length, 'INVALID_PATHS');
    const engines = inventory(plan.engines);
    const aliases = {};
    for (const context of CONTEXTS) {
        const alias = plan.engines[context].aliasOf;
        if (alias !== undefined) {
            requireProof(context === 'dockerRoot' && alias === 'docker'
                && engines.docker.available && same(engines.docker, engines.dockerRoot), 'INVALID_ALIAS');
            aliases[context] = alias;
        }
    }
    const seen = new Set();
    for (const context of CONTEXTS.filter(value => !aliases[value])) {
        for (const row of engines[context].containers || []) {
            requireProof(!seen.has(row.id), 'CROSS_CONTEXT_CONTAINER');
            seen.add(row.id);
        }
    }
    const paths = plan.paths.map(row => {
        const file = canonical(row.path);
        requireProof(path.dirname(file) === HOST_HOME && PATH_NAMES.includes(path.basename(file)), 'PATH_NOT_AUTHORIZED');
        requireProof(/^\d+$/.test(String(row.device)) && /^\d+$/.test(String(row.inode)) && row.uid === UID, 'INVALID_PATH_IDENTITY');
        return { path: file, device: String(row.device), inode: String(row.inode), uid: row.uid };
    });
    requireProof(new Set(paths.map(row => row.path)).size === paths.length, 'DUPLICATE_PATH');
    return { engines, paths, aliases };
}

export function inspectCleanupPath(row, { home = HOST_HOME, uid = UID, fsApi = fs } = {}) {
    const file = row.path;
    requireProof(path.dirname(file) === home && PATH_NAMES.includes(path.basename(file)), 'PATH_NOT_AUTHORIZED');
    const parent = fsApi.lstatSync(home, { bigint: true });
    const stat = fsApi.lstatSync(file, { bigint: true });
    requireProof(parent.isDirectory() && !parent.isSymbolicLink() && String(parent.uid) === String(uid)
        && fsApi.realpathSync(home) === home, 'PARENT_CHANGED');
    requireProof(stat.isDirectory() && !stat.isSymbolicLink() && fsApi.realpathSync(file) === file
        && String(stat.uid) === String(row.uid) && String(stat.dev) === row.device && String(stat.ino) === row.inode,
    'PATH_CHANGED');
}

function mountPoints(text = fs.readFileSync('/proc/self/mountinfo', 'utf8')) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const fields = line.split(' ');
        requireProof(fields.length >= 7 && fields.includes('-'), 'MOUNT_INVENTORY_INVALID');
        return fields[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
    });
}
function assertUnmounted(file, mounts) {
    requireProof(!mounts.some(mount => mount === file || mount.startsWith(`${file}/`)), 'PATH_MOUNTED');
}
function assertNoReferences(paths, engines, { afterContainers = false } = {}) {
    for (const context of CONTEXTS) {
        for (const row of engines[context].containers || []) {
            if (!afterContainers && context.startsWith('podman')) continue;
            for (const mount of row.mounts) {
                requireProof(!paths.some(candidate => overlaps(candidate.path, mount.source)), 'PATH_REFERENCED');
            }
        }
        if (context.startsWith('docker')) {
            const used = new Set((engines[context].containers || []).map(row => row.image));
            requireProof(!(engines[context].images || []).some(image => used.has(image)), 'DOCKER_IMAGE_REFERENCED');
        }
    }
}

export async function applyCleanup(plan, adapters = productionAdapters()) {
    const { engines: expected, paths, aliases } = validateCleanupPlan(plan, adapters.host());
    const receipt = { version: 1, result: 'started', stopped: [], containers: [], images: [], paths: [] };
    let lock;
    const checkInventory = () => {
        const current = inventory(adapters.inventory());
        requireProof(same(current, expected), 'INVENTORY_CHANGED');
        return current;
    };
    const update = (context, key, value) => {
        expected[context][key] = value;
        for (const [alias, source] of Object.entries(aliases)) if (source === context) expected[alias][key] = value;
    };
    const checkPaths = () => {
        const mounts = adapters.mountPoints();
        for (const row of paths) { adapters.inspectPath(row); assertUnmounted(row.path, mounts); }
    };
    try {
        checkInventory(); checkPaths(); assertNoReferences(paths, expected);
        lock = await adapters.acquireLock();
        checkInventory(); checkPaths(); assertNoReferences(paths, expected);
        for (const context of ['podman', 'podmanRoot']) {
            for (const container of [...(expected[context].containers || [])]) {
                lock.assertHeld(INSTANCE); checkInventory();
                adapters.stopContainer(context, container.id);
                receipt.stopped.push({ context, id: container.id });
                checkInventory();
                adapters.removeContainer(context, container.id);
                update(context, 'containers', expected[context].containers.filter(row => row.id !== container.id));
                receipt.containers.push({ context, id: container.id });
                checkInventory();
            }
        }
        for (const context of CONTEXTS.filter(value => !aliases[value])) {
            for (const image of [...(expected[context].images || [])]) {
                lock.assertHeld(INSTANCE);
                const current = checkInventory();
                requireProof(!(current[context].containers || []).some(row => row.image === image), 'IMAGE_REFERENCED');
                adapters.removeImage(context, image);
                update(context, 'images', expected[context].images.filter(value => value !== image));
                receipt.images.push({ context, id: image });
                checkInventory();
            }
        }
        for (const row of paths) {
            lock.assertHeld(INSTANCE);
            assertNoReferences([row], checkInventory(), { afterContainers: true });
            adapters.inspectPath(row); assertUnmounted(row.path, adapters.mountPoints());
            adapters.deletePath(row);
            requireProof(!adapters.pathExists(row.path), 'PATH_DELETE_UNCONFIRMED');
            receipt.paths.push(row.path);
        }
        checkInventory();
        return { ...receipt, result: 'complete' };
    } catch (error) {
        error.receipt = { ...receipt, result: 'failed', code: error.code || 'HOST_CLEANUP_FAILED' };
        throw error;
    } finally { lock?.release(); }
}

export function productionAdapters() {
    const command = (program, args, options = {}) => execFileSync(program, args, {
        encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'], ...options,
    });
    const engine = (context, args) => {
        const podman = context.startsWith('podman');
        const executable = podman ? '/usr/bin/podman' : '/usr/bin/docker';
        const fixed = podman ? ['--remote=false'] : ['--host=unix:///var/run/docker.sock'];
        return context.endsWith('Root')
            ? command('/usr/bin/sudo', ['-n', executable, ...fixed, ...args])
            : command(executable, [...fixed, ...args]);
    };
    return {
        host: () => ({ host: os.hostname(), user: os.userInfo().username, uid: process.getuid(), home: os.homedir() }),
        inventory() {
            return Object.fromEntries(CONTEXTS.map(context => {
                const executable = context.startsWith('podman') ? '/usr/bin/podman' : '/usr/bin/docker';
                if (!fs.existsSync(executable)) {
                    const store = context.startsWith('podman')
                        ? (context.endsWith('Root') ? '/var/lib/containers/storage' : `${HOST_HOME}/.local/share/containers/storage`)
                        : '/var/lib/docker';
                    requireProof(!fs.existsSync(store), 'ENGINE_STORAGE_UNINSPECTED');
                    return [context, { available: false }];
                }
                // An installed but inaccessible daemon is unknown, not empty.
                const ids = engine(context, ['container', 'ls', '-aq', '--no-trunc']).trim().split(/\s+/).filter(Boolean);
                const containers = ids.length ? JSON.parse(engine(context, ['container', 'inspect', ...ids])).map(row => ({
                    id: row.Id, image: row.Image,
                    mounts: (row.Mounts || []).map(mount => ({ type: mount.Type, source: mount.Source, destination: mount.Destination })),
                })) : [];
                const images = [...new Set(engine(context, ['image', 'ls', '-aq', '--no-trunc']).trim().split(/\s+/).filter(Boolean))];
                return [context, { available: true, containers, images }];
            }));
        },
        async acquireLock() {
            const proof = spawnSync('/usr/bin/flock', ['-n', '-E', '75', `${HOST_HOME}/.qa-deployment-operation.lock`, 'true'], { timeout: 5000 });
            requireProof(proof.status === 75, 'HOST_LOCK_REQUIRED');
            const module = await import(pathToFileURL(`${HOST_HOME}/explorerQaWorkspace/.runtime/ploinky/ploinky-box/locks.mjs`).href);
            return module.createMutationLockManager().acquire(INSTANCE);
        },
        stopContainer: (context, container) => engine(context, ['container', 'stop', '--time', '30', container]),
        removeContainer: (context, container) => engine(context, ['container', 'rm', container]),
        removeImage: (context, image) => engine(context, ['image', 'rm', image]),
        inspectPath: row => inspectCleanupPath(row), mountPoints,
        pathExists: file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
        deletePath(row) {
            const script = [
                "import fs from 'node:fs'; import path from 'node:path';",
                `const HOST_HOME=${JSON.stringify(HOST_HOME)}, UID=${UID}, PATH_NAMES=${JSON.stringify(PATH_NAMES)};`,
                fail.toString(), requireProof.toString(), inspectCleanupPath.toString(), mountPoints.toString(), assertUnmounted.toString(),
                "if(process.getuid()!==0)fail('ROOT_REQUIRED');",
                "const row=JSON.parse(fs.readFileSync(0,'utf8')); inspectCleanupPath(row); assertUnmounted(row.path,mountPoints()); fs.rmSync(row.path,{recursive:true});",
            ].join('\n');
            command('/usr/bin/sudo', ['-n', '/usr/bin/node', '--input-type=module', '-e', script], {
                input: JSON.stringify(row), timeout: 300000,
            });
        },
    };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
        const chunks = []; let bytes = 0;
        for await (const chunk of process.stdin) {
            bytes += chunk.length; requireProof(bytes <= 2 * 1024 * 1024, 'PLAN_TOO_LARGE'); chunks.push(chunk);
        }
        const result = await applyCleanup(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify(error.receipt || { result: 'failed', code: /^HOST_CLEANUP_/.test(error.code) ? error.code : 'HOST_CLEANUP_FAILED' })}\n`);
        process.exitCode = 1;
    }
}
