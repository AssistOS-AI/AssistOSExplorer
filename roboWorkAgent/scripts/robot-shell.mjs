import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isatty } from 'node:tty';
import { RobotPaths, homeTarget, fail } from '../server/robot-paths.mjs';
import { parseTerminalProfile, terminalDirectory } from '../server/terminal-profiles.mjs';
import { buildPrivateLaunch } from '../server/launch.mjs';
import { nativeEnvironment } from '../server/native-environment.mjs';
import { EnvironmentManager } from '../server/environment.mjs';

const script = fileURLToPath(import.meta.url);
const codeRoot = path.dirname(path.dirname(script));

export async function loadTerminalDescriptor(env = process.env, cwd = process.cwd()) {
    if (env.PLOINKY_WEBTTY_PROFILE_PROVIDER !== 'roboWorkAgent') throw fail('PROFILE_REFUSED', 'Terminal profile is unavailable');
    const profile = env.PLOINKY_WEBTTY_PROFILE_ID;
    const paths = new RobotPaths({ dataDir: '/data', workspaceRoot: env.PLOINKY_WORKSPACE_ROOT });
    return readTerminalDescriptor(paths, profile, env.HOME, cwd);
}

export async function readTerminalDescriptor(paths, profile, selectedHome, cwd) {
    const { id } = parseTerminalProfile(profile);
    const stateRoot = path.join(paths.dataDir, 'server-state', 'terminal');
    await terminalDirectory(stateRoot);
    const descriptorPath = path.join(stateRoot, profile + '.json');
    const handle = await fs.open(descriptorPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || stat.uid !== process.getuid()) throw new Error();
        descriptor = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    const stub = path.join(paths.workspaceRoot, '.data', 'roboWorkAgent', 'terminal', id);
    const stat = await terminalDirectory(stub, { empty: true });
    if (!selectedHome) throw fail('PROFILE_REFUSED', 'Terminal profile is unavailable');
    // The Router may reach the stub through a container bind alias. Its canonical
    // path differs, but the service-owned empty directory must be the same inode.
    const selectedStat = await terminalDirectory(selectedHome, { empty: true });
    if (descriptor.profile !== profile || descriptor.id !== id || descriptor.dataDir !== paths.dataDir
        || descriptor.workspaceRoot !== paths.workspaceRoot || descriptor.stub?.path !== stub
        || descriptor.stub.dev !== stat.dev || descriptor.stub.ino !== stat.ino
        || selectedStat.dev !== stat.dev || selectedStat.ino !== stat.ino) throw fail('PROFILE_REFUSED', 'Terminal profile is unavailable');
    const directory = await fs.realpath(cwd);
    descriptor.cwd = directory === stub || directory === selectedHome ? null : await paths.grant(directory, 'cwd');
    descriptor.cwdIdentity = descriptor.cwd ? await paths.identity(descriptor.cwd, 'cwd') : null;
    return { descriptor, paths };
}

export async function buildShellSandbox(descriptor, { loadSandbox = async entry => import(pathToFileURL(path.join(path.dirname(path.dirname(entry)), 'src/coding-agents/sandbox.mjs')).href) } = {}) {
    const target = homeTarget(descriptor.id);
    // ALA captures its home in static module tables, so this precedes its first import.
    process.env.ALA_SANDBOX_HOME = target;
    const api = await loadSandbox(descriptor.alaEntry);
    const bwrap = descriptor.bwrap;
    if (!api.canMountPrivateProc(bwrap)) throw fail('SANDBOX_UNAVAILABLE', 'A private process namespace is required');
    const home = descriptor.innerEnvironment ? target : path.join(descriptor.dataDir, 'robots', descriptor.id, 'home');
    const cwd = descriptor.cwd || target;
    const shell = await fs.access('/bin/bash', fs.constants.X_OK).then(() => '/bin/bash', () => '/bin/sh');
    const folders = [{ source: descriptor.cacheRoot, target: descriptor.cacheRoot },
        { source: descriptor.innerEnvironment ? '/workspace/roboteam-soul' : path.join(descriptor.dataDir, 'robots', descriptor.id, 'run/soul'),
            target: '/workspace/roboteam-soul' }];
    const env = nativeEnvironment({ PATH: '/usr/local/bin:/usr/bin:/bin', TERM: descriptor.term || 'xterm-256color', LANG: 'C.UTF-8' }, target);
    // The folder is opened once and bound by descriptor. The robot home has no private project data to mask.
    const pin = descriptor.cwd ? api.pinDirectory(descriptor.cwd, descriptor.cwdIdentity) : null;
    const mask = descriptor.cwd ? { ignoredPaths: [path.join(descriptor.cwd, '.roboteam')] } : {};
    if (descriptor.cwd) await fs.mkdir(mask.ignoredPaths[0], { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const args = api.buildSandboxArgs({ workspace: descriptor.cwd || home, workspaceTarget: cwd, ...(pin ? { workspaceFd: pin.fd } : {}), ...mask,
        binary: shell, args: shell.endsWith('/bash') ? ['--login', '-i'] : ['-i'], env, bwrap,
        privateProc: true, home, folders, chdir: cwd, newSession: false });
    // Tool paths are service-selected. Every parent credential and environment value is discarded.
    const boundary = args.indexOf('--');
    args.splice(boundary, 0, '--setenv', 'PATH', `${descriptor.binPath}:/usr/local/bin:/usr/bin:/bin`,
        '--setenv', 'ROBOTEAM_WORKING_DIRECTORY', cwd, '--setenv', 'PS1', '\\w $ ');
    return { command: bwrap, args, options: { env, stdio: pin ? ['inherit', 'inherit', 'inherit', pin.fd] : 'inherit', detached: false } };
}

export async function buildTerminalLaunch(descriptor, paths, { environment = new EnvironmentManager() } = {}) {
    if (descriptor.environment) {
        const entry = await environment.require(descriptor.environment, { retry: true });
        const launch = await environment.buildLaunch({ environment: entry.ref, runId: 'terminal-' + randomUUID(), robotId: descriptor.id,
            home: paths.home(descriptor.id), cwd: descriptor.cwd, cwdIdentity: descriptor.cwdIdentity,
            toolCache: descriptor.cacheRoot,
            ala: { source: codeRoot, target: '/opt/robowork-terminal', entry: '/opt/robowork-terminal/scripts/robot-shell.mjs' },
            bwrap: { source: descriptor.bwrap, target: '/opt/robowork-bwrap' },
            soul: { source: paths.soul(descriptor.id), target: '/workspace/roboteam-soul' },
            folders: [{ source: path.dirname(path.dirname(descriptor.alaEntry)), target: '/opt/robowork-ala', readOnly: true }],
            tty: true, args: ['--inner', JSON.stringify({ ...descriptor, innerEnvironment: true,
                alaEntry: '/opt/robowork-ala/bin/ala.mjs', bwrap: '/opt/robowork-bwrap' })], env: {} });
        return { ...launch, options: { ...launch.options, stdio: 'inherit', detached: false } };
    }
    const stateRoot = path.join(paths.dataDir, 'server-state', 'terminal');
    const directory = await fs.mkdtemp(path.join(stateRoot, 'launch-'));
    try {
        const launch = await buildPrivateLaunch({ paths, id: descriptor.id, directory, command: process.execPath,
            args: [script, '--inner', JSON.stringify(descriptor)], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
        return { ...launch, directory, options: { ...launch.options, stdio: 'inherit', detached: false } };
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

async function run(launch, { inner = false } = {}) {
    return new Promise((resolve, reject) => {
        // A fresh ioctl detects hangup without reading stdin. Exiting the inner
        // namespace's PID 1 also ends children that ignore HUP and TERM.
        const checkTty = () => { if (!isatty(0)) process.exit(129); };
        if (inner && !isatty(0)) { process.exit(129); return; }
        const child = spawn(launch.command, launch.args, launch.options);
        const ttyWatch = inner ? setInterval(checkTty, 100) : undefined;
        // The child shares the controlling TTY and foreground process group. Ctrl-C and
        // Ctrl-Z therefore reach the actual shell, without creating an outer prompt.
        const ignore = () => {};
        process.on('SIGINT', ignore);
        process.on('SIGQUIT', ignore);
        const dispose = () => {
            clearInterval(ttyWatch);
            process.off('SIGINT', ignore); process.off('SIGQUIT', ignore);
        };
        child.once('error', error => { dispose(); reject(error); });
        child.once('exit', (code, signal) => {
            dispose();
            resolve(code ?? (signal ? 128 : 1));
        });
    });
}

export async function main() {
    let launch;
    const inner = process.argv[2] === '--inner';
    try {
        if (inner) {
            const descriptor = JSON.parse(process.argv[3]);
            // The private wrapper inherits only this allowlist, before shell profiles run.
            const env = nativeEnvironment({ PATH: '/usr/local/bin:/usr/bin:/bin' }, homeTarget(descriptor.id));
            for (const key of Object.keys(process.env)) delete process.env[key];
            Object.assign(process.env, env);
            launch = await buildShellSandbox(descriptor);
        } else {
            const { descriptor, paths } = await loadTerminalDescriptor();
            descriptor.term = /^[A-Za-z0-9+_.-]{1,64}$/u.test(process.env.TERM || '') ? process.env.TERM : 'xterm-256color';
            launch = await buildTerminalLaunch(descriptor, paths);
        }
        process.exitCode = await run(launch, { inner });
    } catch (error) {
        process.stderr.write(error?.code === 'CWD_REFUSED'
            ? 'A robot terminal cannot open here. Open it in a project folder below the workspace root, or in the robot home.\n'
            : 'Robot terminal could not start safely. Close this tab and retry.\n');
        process.exitCode = 124;
    } finally {
        if (launch?.directory) await fs.rm(launch.directory, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
