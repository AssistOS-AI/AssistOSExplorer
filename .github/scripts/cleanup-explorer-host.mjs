import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOST = 'proxiesserve';
const HOST_HOME = '/home/admin';
const UID = 1001;
const INSTANCE = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
const QA_WORKSPACE = `${HOST_HOME}/explorerQaWorkspace`;
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

export function inspectCleanupPath(row, { home = HOST_HOME, uid = UID, fsApi = fs, file = row.path } = {}) {
    requireProof(path.dirname(row.path) === home && PATH_NAMES.includes(path.basename(row.path)), 'PATH_NOT_AUTHORIZED');
    // A workspace renamed for deletion keeps its identity under a reserved sibling name.
    requireProof(file === row.path || (path.dirname(file) === home
        && new RegExp(`^${path.basename(row.path).replace(/\./g, '\\.')}\\.deleting-[a-f0-9]{12}$`).test(path.basename(file))), 'PATH_NOT_AUTHORIZED');
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

/**
 * Acquires the QA workspace mutation lock from the deployed runtime's lock
 * module. The lock lives inside the QA workspace, so the handle also offers
 * `relinquishDeleted` for the deletion of that workspace.
 */
export async function acquireCleanupLock(module, { instance = INSTANCE, workspaceRoot = QA_WORKSPACE } = {}) {
    const lock = await module.createMutationLockManager().acquire(instance, { workspaceRoot });
    return { assertHeld: value => lock.assertHeld(value), release: () => lock.release(),
        releaseRelocated: root => lock.releaseRelocated(root), relinquishDeleted: () => lock.relinquishDeleted() };
}

/**
 * Structural proof that the lock just acquired is the workspace-resident lock:
 * `.ploinky-box`, `locks` and `workspace.lock` under the QA workspace are real
 * directories, none a symlink. An earlier runtime keeps its lock outside the
 * workspace, so none of this exists there. This is a layout check, not a probe
 * of which methods the lock module offers.
 */
export function workspaceLockLayout(workspace = QA_WORKSPACE, fsApi = fs) {
    let current = workspace;
    for (const name of ['.ploinky-box', 'locks', 'workspace.lock']) {
        current = path.join(current, name);
        let stat;
        try { stat = fsApi.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
}

/**
 * The Box mount proof for the exact-name QA Box (the same D6 clauses the rollback
 * tooling applies): the mounted `/opt/ploinky` checkout is shadowed read-only at
 * its own path, and `.ploinky-box` is masked by its read-only `empty/` directory.
 * `mounts` are engine `Mounts` records. A Box built by an earlier runtime has neither.
 */
export function assertQaBoxMounts(mounts, workspace = QA_WORKSPACE) {
    const list = Array.isArray(mounts) ? mounts : [];
    const checkout = list.find(mount => mount.Destination === '/opt/ploinky')?.Source;
    requireProof(typeof checkout === 'string' && checkout !== '', 'QA_BOX_SOURCE_INVALID');
    const state = path.join(workspace, '.ploinky-box');
    const shadows = list.filter(mount => mount.Destination === checkout);
    const masks = list.filter(mount => mount.Destination === state);
    requireProof(shadows.length === 1 && shadows[0].Source === checkout && shadows[0].RW === false && shadows[0].Type === 'bind'
        && masks.length === 1 && masks[0].Source === path.join(state, 'empty') && masks[0].RW === false
        && masks[0].Type === 'bind', 'QA_BOX_SOURCE_INVALID');
}

export async function applyCleanup(plan, adapters = productionAdapters()) {
    const { engines: expected, paths, aliases } = validateCleanupPlan(plan, adapters.host());
    const receipt = { version: 1, result: 'started', stopped: [], containers: [], images: [], paths: [] };
    let lock, renamedWorkspace = null, relinquished = false, primary = null, completed = null;
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
        // Refuse before the first mutation unless the runtime keeps its lock in the
        // workspace. An earlier runtime's lock would be left held and the workspace
        // stranded at its renamed path.
        requireProof(adapters.workspaceLockLayout(), 'WORKSPACE_LOCK_LAYOUT_INVALID');
        if (paths.some(row => row.path === QA_WORKSPACE)) {
            const planned = ['podman', 'podmanRoot'].flatMap(context => (expected[context].containers || []).map(row => ({ context, id: row.id })));
            for (const box of adapters.qaBoxes(planned)) {
                try { assertQaBoxMounts(box.mounts); } catch (error) { fail('QA_BOX_SOURCE_INVALID'); }
            }
        }
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
        // The lock lives inside the QA workspace, so that row runs last: rename it
        // away, prove it absent through the lock, then delete the renamed tree.
        // The lock is never asserted or released again.
        const ordered = [...paths.filter(row => row.path !== QA_WORKSPACE), ...paths.filter(row => row.path === QA_WORKSPACE)];
        for (const row of ordered) {
            lock.assertHeld(INSTANCE);
            assertNoReferences([row], checkInventory(), { afterContainers: true });
            adapters.inspectPath(row); assertUnmounted(row.path, adapters.mountPoints());
            if (row.path === QA_WORKSPACE) {
                const renamed = `${row.path}.deleting-${crypto.randomBytes(6).toString('hex')}`;
                renamedWorkspace = renamed;
                adapters.renameWorkspace(row, renamed);
                requireProof(!adapters.pathExists(row.path), 'PATH_DELETE_UNCONFIRMED');
                lock.relinquishDeleted();
                relinquished = true;
                adapters.deleteRenamedWorkspace(row, renamed);
                requireProof(!adapters.pathExists(renamed), 'PATH_DELETE_UNCONFIRMED');
            } else adapters.deletePath(row);
            requireProof(!adapters.pathExists(row.path), 'PATH_DELETE_UNCONFIRMED');
            receipt.paths.push(row.path);
        }
        checkInventory();
        completed = { ...receipt, result: 'complete' };
    } catch (error) {
        error.receipt = { ...receipt, result: 'failed', code: error.code || 'HOST_CLEANUP_FAILED' };
        primary = error;
    }
    // After relinquishment the lock is gone with its workspace. A renamed but still
    // present workspace holds the lock at its new path. A release failure is
    // secondary information on the primary error and never replaces it or its receipt.
    let releaseFailure = null;
    if (lock && !relinquished) {
        try {
            if (renamedWorkspace && adapters.pathExists(renamedWorkspace)) lock.releaseRelocated(renamedWorkspace);
            else lock.release();
        } catch (error) { releaseFailure = error; }
    }
    if (primary) {
        if (releaseFailure) {
            primary.receipt.releaseFailure = releaseFailure.code || 'HOST_CLEANUP_LOCK_RELEASE_FAILED';
            primary.secondary = releaseFailure;
        }
        throw primary;
    }
    if (releaseFailure) {
        releaseFailure.receipt = { ...receipt, result: 'failed', code: releaseFailure.code || 'HOST_CLEANUP_LOCK_RELEASE_FAILED' };
        throw releaseFailure;
    }
    return completed;
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
    const rootScript = (source, input, timeout) => command('/usr/bin/sudo', ['-n', '/usr/bin/node', '--input-type=module', '-e', source],
        { input: JSON.stringify(input), timeout });
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
            return acquireCleanupLock(module);
        },
        workspaceLockLayout: () => workspaceLockLayout(QA_WORKSPACE),
        qaBoxes: rows => rows.flatMap(({ context, id: containerId }) => {
            const records = JSON.parse(engine(context, ['container', 'inspect', containerId]));
            requireProof(records.length === 1 && records[0].Id === containerId, 'INVALID_INVENTORY');
            if (String(records[0].Name).replace(/^\//, '') !== INSTANCE) return [];
            return [{ context, id: containerId, mounts: (records[0].Mounts || []).map(({ Source, Destination, RW, Type }) => ({ Source, Destination, RW, Type })) }];
        }),
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
        renameWorkspace: (row, renamed) => rootScript(workspaceDeletionScript('rename'), { row, renamed }, 60000),
        deleteRenamedWorkspace: (row, renamed) => rootScript(workspaceDeletionScript('delete'), { row, renamed }, 300000),
    };
}

/**
 * The root scripts for the workspace row, whose lock lives inside it: an
 * exact same-parent rename to an absent reserved name, then, only after the lock
 * has been relinquished, deletion of that renamed tree with the same identity.
 * Tests run the same source with their own home and uid and without root.
 */
export function workspaceDeletionScript(step, { home = HOST_HOME, uid = UID, requireRoot = true, mountInfo = null } = {}) {
    const body = {
        rename: [
            'inspectCleanupPath(row); assertUnmounted(row.path,mounts());',
            "requireProof(row.path===path.join(HOST_HOME,'explorerQaWorkspace')&&path.dirname(renamed)===HOST_HOME",
            "    &&/^explorerQaWorkspace\\.deleting-[a-f0-9]{12}$/.test(path.basename(renamed)),'PATH_NOT_AUTHORIZED');",
            "let occupied=true; try{fs.lstatSync(renamed);}catch(error){if(error.code!=='ENOENT')throw error; occupied=false;}",
            "requireProof(!occupied,'RENAME_TARGET_EXISTS');",
            'fs.renameSync(row.path,renamed); inspectCleanupPath(row,{file:renamed});',
        ],
        delete: ['inspectCleanupPath(row,{file:renamed}); assertUnmounted(renamed,mounts()); fs.rmSync(renamed,{recursive:true});'],
    }[step];
    requireProof(body, 'INVALID_STEP');
    return [
        "import fs from 'node:fs'; import path from 'node:path';",
        `const HOST_HOME=${JSON.stringify(home)}, UID=${uid}, PATH_NAMES=${JSON.stringify(PATH_NAMES)};`,
        `const MOUNT_INFO=${JSON.stringify(mountInfo)}; const mounts=()=>MOUNT_INFO===null?mountPoints():mountPoints(MOUNT_INFO);`,
        fail.toString(), requireProof.toString(), inspectCleanupPath.toString(), mountPoints.toString(), assertUnmounted.toString(),
        requireRoot ? "if(process.getuid()!==0)fail('ROOT_REQUIRED');" : '',
        "const {row,renamed}=JSON.parse(fs.readFileSync(0,'utf8'));",
        ...body,
    ].join('\n');
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
