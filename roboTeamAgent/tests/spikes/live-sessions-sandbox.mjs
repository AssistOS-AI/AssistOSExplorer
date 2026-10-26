import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SOCKET_PATHS, connectProbe, processIdentity } from './live-sessions-process-probe.mjs';
import { connectProductionProbe } from './live-sessions-production-probe.mjs';

export const PLAN_FILE = '.p3-spike-plan.json';
export const PRODUCTION_GRANTS = Object.freeze(['ploinky-runtime', 'roboflow-human-input', 'roboteam-task-failure',
    'report-task-blocked'].map(name => `/workspace/${name}`));
const MOUNT_DEVICE = /^\d+:\d+$/;
const MOUNT_NAMESPACE = /^mnt:\[\d+\]$/;
const inside = (root, value) => value === root || value.startsWith(root === '/' ? '/' : `${root}/`);
const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));

export function parseMountInfo(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        assert.ok(separator >= 6, 'Malformed mountinfo');
        return { id: fields[0], parent: fields[1], device: fields[2], root: unescapeMount(fields[3]),
            target: unescapeMount(fields[4]), options: fields[5], type: fields[separator + 1] };
    });
}

export function captureGrants(args) {
    const grants = [];
    for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        if (['--bind', '--ro-bind', '--dev-bind'].includes(args[i])) {
            grants.push({ source: args[++i], target: args[++i], permission: args[i - 2] === '--ro-bind' ? 'ro' : 'rw', kind: 'bind' });
        } else if (['--tmpfs', '--dev', '--proc'].includes(args[i])) {
            grants.push({ kind: args[i].slice(2), target: args[++i], permission: 'private' });
        } else if (args[i] === '--symlink') {
            grants.push({ kind: 'symlink', source: args[++i], target: args[++i], permission: 'link' });
        }
    }
    assert.ok(grants.some(grant => grant.kind === 'dev' && grant.target === '/dev'), 'Missing actual ALA /dev isolation');
    assert.ok(grants.some(grant => grant.kind === 'tmpfs' && grant.target === '/tmp'), 'Missing actual ALA /tmp isolation');
    return grants;
}

// Filesystem coordinate of an absolute path: the backing device and the path
// below that filesystem's root. The deepest covering mount wins; among stacked
// mounts on one target, the last listed entry is the visible one.
export function mountCoordinate(value, mounts) {
    const mount = mounts.map((entry, index) => ({ entry, index })).filter(({ entry }) => inside(entry.target, value))
        .sort((a, b) => b.entry.target.length - a.entry.target.length || b.index - a.index)[0]?.entry;
    assert.ok(mount, 'Missing mount source identity');
    return { device: mount.device, file: path.posix.join(mount.root, path.posix.relative(mount.target, value)) };
}

// Linux dev_t encoding (glibc gnu_dev_major/minor) for a bigint stat device.
export function linuxDevice(dev) {
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
    return `${major}:${minor}`;
}

// Mount entries inside the sandbox that expose a recorded socket's backing
// filesystem at or above the socket. A fresh tmpfs has a different device.
export function socketDeviceExposures(observedMounts, socketDevices) {
    return observedMounts.filter(mount => socketDevices.some(socket => mount.device === socket.device
        && inside(unescapeMount(mount.root), socket.file)));
}

export function aliasesFor(socketPath, grants, mounts, realpath = value => fs.realpathSync(value)) {
    const coordinate = value => mountCoordinate(realpath(value), mounts);
    const socket = coordinate(socketPath);
    const aliases = new Set([socketPath, realpath(socketPath)]);
    for (const grant of grants.filter(entry => entry.kind === 'bind')) {
        const grantSource = realpath(grant.source);
        // Recursive bind grants also project nested mounts, including /data's
        // workspace alias; looking only at the grant root misses those paths.
        const projected = [grantSource, ...mounts.filter(mount => inside(grantSource, mount.target)).map(mount => mount.target)];
        for (const projectedSource of projected) {
            const source = coordinate(projectedSource);
            if (source.device === socket.device && inside(source.file, socket.file)) {
                const target = path.posix.join(grant.target, path.posix.relative(grantSource, projectedSource));
                aliases.add(path.posix.join(target, path.posix.relative(source.file, socket.file)));
            }
        }
    }
    // Include paths created through bwrap's explicit symlinks as well.
    for (let pass = 0; pass < grants.length; pass++) {
        const size = aliases.size;
        for (const link of grants.filter(entry => entry.kind === 'symlink')) {
            const source = path.posix.resolve(path.posix.dirname(link.target), link.source);
            for (const alias of [...aliases]) if (inside(source, alias)) aliases.add(path.posix.join(link.target, path.posix.relative(source, alias)));
        }
        if (aliases.size === size) break;
        assert.ok(aliases.size < 256, 'Alias expansion limit exceeded');
    }
    return [...aliases].sort();
}

// Pure checks over a recorded sandbox result. The harness runs them before
// reporting success and the evidence assembler re-runs them on the record.
export function verifySandboxRecord({ plan, observed, socketDevices }, serviceMountNamespace) {
    assert.equal(plan?.kind, 'actual-bwrap-spawn', 'Sandbox plan must come from the actual bwrap spawn');
    assert.ok(Array.isArray(plan.grants), 'Sandbox grants are required');
    const binds = plan.grants.filter(grant => grant?.kind === 'bind' && typeof grant.target === 'string');
    for (const target of PRODUCTION_GRANTS) assert.ok(binds.some(grant => grant.target === target), `Missing production ${target} grant`);
    assert.ok(binds.some(grant => grant.target.endsWith('/.agents/skills')), 'Missing production skill overlay');
    assert.equal(observed?.kind, 'sandbox-socket-probe', 'Sandbox observation must come from the diagnostic backend');
    assert.ok(typeof serviceMountNamespace === 'string' && MOUNT_NAMESPACE.test(serviceMountNamespace), 'Service mount namespace is required');
    assert.ok(typeof observed.mountNamespace === 'string' && MOUNT_NAMESPACE.test(observed.mountNamespace), 'Sandbox mount namespace is required');
    assert.notEqual(observed.mountNamespace, serviceMountNamespace, 'Backend must execute in a distinct mount namespace');
    assert.ok(Array.isArray(observed.mounts) && observed.mounts.length > 0, 'Sandbox mountinfo must be observed');
    assert.ok(observed.mounts.every(mount => typeof mount?.device === 'string' && MOUNT_DEVICE.test(mount.device)
        && typeof mount.root === 'string' && mount.root.startsWith('/')
        && typeof mount.target === 'string' && mount.target.startsWith('/')), 'Sandbox mountinfo entries must be complete');
    assert.ok(observed.mounts.some(mount => mount.target === '/'), 'Sandbox mountinfo must include its root mount');
    assert.ok(Array.isArray(socketDevices), 'Socket device identities are required');
    assert.deepEqual(socketDevices.map(entry => entry?.socketPath).sort(), [...SOCKET_PATHS].sort(),
        'Socket device identities must cover exactly the selected socket set');
    for (const socket of socketDevices) {
        assert.ok(typeof socket.device === 'string' && MOUNT_DEVICE.test(socket.device), 'Socket device is required');
        assert.equal(socket.statDevice, socket.device, 'Socket mountinfo and stat devices must agree');
        assert.ok(typeof socket.file === 'string' && path.posix.isAbsolute(socket.file), 'Socket filesystem path is required');
    }
    assert.deepEqual(socketDeviceExposures(observed.mounts, socketDevices), [],
        'No sandbox mount may expose the socket filesystem at or above the socket');
    assert.ok(Array.isArray(plan.sockets) && Array.isArray(observed.results), 'Sandbox aliases and results are required');
    assert.deepEqual(plan.sockets.map(entry => entry?.socketPath).sort(), [...SOCKET_PATHS].sort(),
        'Sandbox plan must cover exactly the selected socket set');
    for (const socket of plan.sockets) {
        assert.ok(typeof socket.realpath === 'string' && path.posix.isAbsolute(socket.realpath), 'Socket realpath is required');
        assert.ok(Array.isArray(socket.aliases), 'Socket aliases are required');
        assert.equal(new Set(socket.aliases).size, socket.aliases.length, 'Socket aliases must be unique');
        assert.ok(socket.aliases.every(alias => typeof alias === 'string' && path.posix.isAbsolute(alias)), 'Socket aliases must be absolute paths');
        assert.ok(socket.aliases.includes(socket.socketPath), 'Socket aliases must include the direct path');
        assert.ok(socket.aliases.includes(socket.realpath), 'Socket aliases must include its realpath');
    }
    const aliases = [...new Set(plan.sockets.flatMap(entry => entry.aliases))].sort();
    assert.deepEqual(observed.results.map(entry => entry.path).sort(), aliases);
    for (const entry of observed.results) assert.equal(entry.error, 'ENOENT', 'Every socket alias must be absent inside ALA');
}

export async function runAlaCapture() {
    assert.equal(process.platform, 'linux', 'Real sandbox spike requires Linux');
    const { resolveAlaInstallation } = await import('../../copilot/src/lib/execution/alaInstallation.mjs');
    const installation = await resolveAlaInstallation();
    const cwdIndex = process.argv.indexOf('--cwd');
    assert.ok(cwdIndex > 0);
    const cwd = fs.realpathSync(process.argv[cwdIndex + 1]);
    const original = childProcess.spawn;
    let captures = 0;
    childProcess.spawn = function (command, args, options) {
        if (path.basename(String(command)) === 'bwrap' && args.includes('--input-format') && args.includes('stream-json')) {
            const grants = captureGrants(args);
            const hostMounts = parseMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
            const sockets = SOCKET_PATHS.map(socketPath => ({ socketPath, realpath: fs.realpathSync(socketPath),
                aliases: aliasesFor(socketPath, grants, hostMounts) }));
            const plan = { version: 1, kind: 'actual-bwrap-spawn', capturePid: process.pid, grants, sockets,
                wrapperSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
            fs.writeFileSync(path.join(cwd, PLAN_FILE), JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
            captures++;
        }
        return Reflect.apply(original, this, [command, args, options]);
    };
    syncBuiltinESMExports();
    try {
        const { runCli } = await import(pathToFileURL(path.join(installation.packageRoot, 'src/cli.mjs')).href);
        const code = await runCli();
        assert.equal(captures, 1, 'Exactly one real backend bwrap spawn must be observed');
        process.exitCode = code;
    } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
}

// listener selects the trusted controls: 'diagnostic' (P3.0 listener) or
// 'production' (the production IPC listener, for G2). The sandbox alias
// checks are identical for both.
export async function runSandboxProbe(robotName, workingDir, { listener = 'diagnostic' } = {}) {
    assert.equal(process.platform, 'linux', 'Real sandbox spike requires Linux');
    assert.ok(['diagnostic', 'production'].includes(listener), 'Unknown listener');
    const control = listener === 'production' ? connectProductionProbe : connectProbe;
    assert.match(robotName, /^p3-spike-[a-z0-9-]+$/, 'Select a dedicated diagnostic robot');
    const workspaceRoot = await fsp.realpath(process.env.PLOINKY_WORKSPACE_ROOT);
    const cwd = await fsp.realpath(workingDir);
    assert.ok(cwd !== workspaceRoot && inside(workspaceRoot, cwd), 'Diagnostic cwd must be inside the selected workspace');
    assert.equal((await fsp.readdir(cwd)).length, 0, 'Use an empty task-owned diagnostic cwd');
    const { prepareCopilotContext } = await import('../../server/copilot-context.mjs');
    const context = await prepareCopilotContext(robotName, { prepareTools: false, holdUsage: true });
    const savedClaude = process.env.CLAUDE_BIN;
    const savedHuman = process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY;
    let engine, human;
    try {
        const { createHumanInputChannel } = await import('../../server/human-input-channel.mjs');
        human = await createHumanInputChannel({ request() { throw new Error('Diagnostic callback must not be called'); }, stop() {} });
        process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = human.directory;
        process.env.CLAUDE_BIN = fileURLToPath(new URL('./live-sessions-probe-claude.mjs', import.meta.url));
        const { resolveAlaInstallation } = await import('../../copilot/src/lib/execution/alaInstallation.mjs');
        const { ConversationSessionStore } = await import('../../copilot/src/lib/storage/conversationSessionStore.mjs');
        const { createRobotSkillCatalog } = await import('../../copilot/src/lib/skills/robotSkillCatalog.mjs');
        const { createAlaEngine } = await import('../../copilot/src/lib/execution/alaEngine.mjs');
        const installation = await resolveAlaInstallation();
        const store = new ConversationSessionStore({ workingDir: cwd });
        const session = await store.createSession();
        const catalog = createRobotSkillCatalog({ context, sessionStore: store, workingDir: cwd,
            initialSessionId: session.sessionId, workflowExecution: true, workflowSkills: true });
        engine = createAlaEngine({ workingDir: cwd, sessionStore: store, skillCatalog: catalog,
            installation: { ...installation, entryPath: fileURLToPath(import.meta.url) },
            execution: { robotId: context.robot.id, backend: 'claude', workflowExecution: true } });
        const identity = await processIdentity();
        const before = await Promise.all(SOCKET_PATHS.map(socketPath => control(socketPath, identity)));
        // The trusted controls prove this harness shares the service mount
        // namespace, so its mountinfo identifies the service-side socket device.
        const serviceMounts = parseMountInfo(await fsp.readFile('/proc/self/mountinfo', 'utf8'));
        const socketDevices = await Promise.all(SOCKET_PATHS.map(async socketPath => {
            const realpath = await fsp.realpath(socketPath);
            return { socketPath, realpath, ...mountCoordinate(realpath, serviceMounts),
                statDevice: linuxDevice((await fsp.stat(realpath, { bigint: true })).dev) };
        }));
        const result = await engine.executeTurn({ sessionId: session.sessionId, prompt: 'Run the fixed isolation diagnostic.' });
        const observed = JSON.parse(result.outputText);
        const plan = JSON.parse(await fsp.readFile(path.join(cwd, PLAN_FILE), 'utf8'));
        verifySandboxRecord({ plan, observed, socketDevices }, identity.mountNamespace);
        const after = await Promise.all(before.map(entry => control(entry.socketPath, identity, entry.incarnationDigest)));
        return { kind: 'sandbox-spike', status: 'passed', listener, before, after, plan, observed, socketDevices,
            backendSha256: createHash('sha256').update(await fsp.readFile(process.env.CLAUDE_BIN)).digest('hex'),
            limitation: 'Trusted controls here run in harness; actual Ploinky CLI before/after controls are separately required.' };
    } finally {
        await engine?.close();
        await human?.close();
        await context.releaseUsage?.();
        if (savedClaude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = savedClaude;
        if (savedHuman === undefined) delete process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY; else process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = savedHuman;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.includes('--home')) await runAlaCapture();
        else {
            const listener = { '--diagnostic': 'diagnostic', '--production': 'production' }[process.argv[4]];
            assert.ok(process.argv.length === 5 && listener,
                'Usage: node live-sessions-sandbox.mjs p3-spike-ROBOT /absolute/empty/cwd --diagnostic|--production');
            console.log(JSON.stringify(await runSandboxProbe(process.argv[2], process.argv[3], { listener })));
        }
    } catch (error) {
        console.error(JSON.stringify({ kind: 'sandbox-spike', status: 'failed', code: error.code || error.name,
            frames: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)) }));
        process.exitCode = 1;
    }
}
