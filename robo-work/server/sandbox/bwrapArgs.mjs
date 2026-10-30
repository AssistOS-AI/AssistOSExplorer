// Pure builder of the per-role bwrap arguments (plan Revision 10, sections B and G).
//
// API
//   buildBwrapArgs(spec) -> Buffer of NUL-terminated arguments, for `bwrap --args <fd>` (bwrap reads them in place).
//   bwrapRealArgv({ argsFd, marker }) -> string[] : the REAL argv of the bwrap process (publication barrier):
//        ['/usr/bin/bwrap', '--unshare-uts', '--hostname', marker, '--args', String(argsFd)]
//     The marker `rw-<hex>` must be a literal element of the real argv so that recovery can match it with
//     `cmdline.includes`; it is never put in the --args buffer. `--unshare-uts` precedes `--hostname` because bwrap
//     requires it; the buffer repeats `--unshare-uts` harmlessly. stage.sh prep execs exactly this argv.
//   BWRAP_PATH, ROLES, FIXED_DESTINATIONS
//
// spec
//   role            'orchestration' | 'endpoint' | 'workload' | 'terminal'
//   marker          'rw-<hex>' (validated; used by bwrapRealArgv and the workload/terminal stage argument)
//   seccompFd, blockFd, infoFd, jsonStatusFd   control fd numbers, as seen by bwrap
//   roBinds         [{ source, dest }]  image paths, read-only   (dest within FIXED_DESTINATIONS)
//   fdBinds         [{ fd, dest, mode: 'ro' | 'rw' }]  anchored `--ro-bind-fd` / `--bind-fd`
//   symlinks        [{ target, dest }]  e.g. { target: 'usr/bin', dest: '/bin' }
//   env             allowlisted environment: orchestration and endpoint get it as `--setenv`; workload and terminal get
//                   it only as assignments to the final `env -i` in stage.sh
//   cwd, argv       working directory and the command (argv[0] must be non-empty, not start with '-', contain no '=')
//   orchestration, endpoint: netMode 'none' (orchestration: --unshare-net) or 'join' (endpoint: joins the execution
//     netns through nsenter before bwrap, so no --unshare-net); fixed NODE_CHANNEL_FD=3 and
//     NODE_CHANNEL_SERIALIZATION_MODE=json are set, bwrap execs argv directly (no shell)
//   workload, terminal: homeFd, stagingDir, channelsDir, stageScript (absolute path of stage.sh), fdAllow (default
//     [0,1,2]), grants [{ name, mode: 'ro' | 'rw' }] bound from `<stagingDir>/projects/<name>` to `/projects/<name>`;
//     bwrap runs `/bin/sh <stageScript> final <fdAllow csv> <KEY=value…> <argv…>`; workload adds --new-session,
//     terminal does not. Orchestration also gets --new-session.
//   grantPaths      optional extra absolute paths that no source may be under
//
// Throws Error with code 'invalid_request' for an unknown role, a destination outside the fixed set, a source under a
// grant (or under /projects), or malformed fields.

import { isValidComponentName } from '../views/protectedNames.mjs';

export const BWRAP_PATH = '/usr/bin/bwrap';
export const ROLES = Object.freeze(['orchestration', 'endpoint', 'workload', 'terminal']);
// A destination must equal one of these or be below it. /projects/<name> is produced only from `grants`.
export const FIXED_DESTINATIONS = Object.freeze([
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/alternatives',
    '/opt/robo-work', '/run/robo-work', '/home/robot', '/session', '/config', '/stream'
]);

const MARKER = /^rw-[0-9a-f]{8,48}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIXED_NODE_ENV = Object.freeze({ NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' });

function invalid(message) {
    const error = new Error(message);
    error.code = 'invalid_request';
    return error;
}

const isFd = (value) => Number.isInteger(value) && value >= 3 && value < 1024;

function requireFd(spec, key) {
    if (!isFd(spec[key])) throw invalid(`${key} must be a file descriptor number`);
}

function cleanPath(value, what) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\n')) {
        throw invalid(`${what} must be an absolute path`);
    }
    const parts = value.split('/');
    if (parts.some((part) => part === '..' || part === '.') || value.includes('//') || (value.length > 1 && value.endsWith('/'))) {
        throw invalid(`${what} must be normalised`);
    }
    return value;
}

const isUnder = (path, base) => path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);

function checkDestination(dest) {
    cleanPath(dest, 'destination');
    if (!FIXED_DESTINATIONS.some((base) => isUnder(dest, base))) throw invalid(`Destination outside the fixed set: ${dest}`);
    return dest;
}

function checkSource(source, spec) {
    cleanPath(source, 'source');
    const grantRoots = ['/projects', ...(typeof spec.stagingDir === 'string' ? [`${spec.stagingDir}/projects`] : []),
        ...(Array.isArray(spec.grantPaths) ? spec.grantPaths : [])];
    for (const root of grantRoots) {
        if (typeof root === 'string' && root.startsWith('/') && root !== '/' && isUnder(source, root)) {
            throw invalid(`Source is under a grant: ${source}`);
        }
    }
    return source;
}

function checkEnv(env) {
    const entries = Object.entries(env || {});
    for (const [key, value] of entries) {
        if (!ENV_NAME.test(key) || typeof value !== 'string' || value.includes('\0')) throw invalid(`Invalid environment entry ${key}`);
    }
    return entries;
}

function checkArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string' || item.includes('\0'))) {
        throw invalid('argv must be a non-empty array of strings');
    }
    if (argv[0] === '' || argv[0].startsWith('-') || argv[0].includes('=')) throw invalid('argv[0] is not a plain command');
    return argv;
}

export function bwrapRealArgv({ argsFd, marker }) {
    if (!isFd(argsFd)) throw invalid('argsFd must be a file descriptor number');
    if (typeof marker !== 'string' || !MARKER.test(marker)) throw invalid('Invalid marker');
    return [BWRAP_PATH, '--unshare-uts', '--hostname', marker, '--args', String(argsFd)];
}

export function buildBwrapArgs(spec) {
    if (spec === null || typeof spec !== 'object') throw invalid('spec must be an object');
    if (!ROLES.includes(spec.role)) throw invalid(`Unknown role: ${String(spec.role)}`);
    if (typeof spec.marker !== 'string' || !MARKER.test(spec.marker)) throw invalid('Invalid marker');
    for (const key of ['seccompFd', 'blockFd', 'infoFd', 'jsonStatusFd']) requireFd(spec, key);
    cleanPath(spec.cwd, 'cwd');
    checkArgv(spec.argv);
    const envEntries = checkEnv(spec.env);

    const args = [
        '--unshare-user', '--uid', '1000', '--gid', '1000', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
        '--unshare-cgroup-try', '--die-with-parent', '--cap-drop', 'ALL', '--disable-userns', '--assert-userns-disabled',
        '--clearenv', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm',
        '--seccomp', String(spec.seccompFd), '--block-fd', String(spec.blockFd),
        '--info-fd', String(spec.infoFd), '--json-status-fd', String(spec.jsonStatusFd)
    ];

    for (const bind of spec.roBinds || []) {
        args.push('--ro-bind', checkSource(bind.source, spec), checkDestination(bind.dest));
    }
    for (const link of spec.symlinks || []) {
        if (typeof link.target !== 'string' || link.target.includes('\0')) throw invalid('Invalid symlink');
        args.push('--symlink', link.target, checkDestination(link.dest));
    }
    for (const bind of spec.fdBinds || []) {
        if (!isFd(bind.fd) || !['ro', 'rw'].includes(bind.mode)) throw invalid('Invalid fd bind');
        args.push(bind.mode === 'ro' ? '--ro-bind-fd' : '--bind-fd', String(bind.fd), checkDestination(bind.dest));
    }

    if (spec.role === 'orchestration' || spec.role === 'endpoint') {
        if (spec.role === 'orchestration') {
            if (spec.netMode !== 'none') throw invalid('orchestration needs netMode none');
            args.push('--unshare-net', '--new-session');
        } else if (spec.netMode !== 'join') {
            throw invalid('endpoint needs netMode join');
        }
        const fixed = Object.entries(FIXED_NODE_ENV);
        for (const [key] of envEntries) if (key in FIXED_NODE_ENV) throw invalid(`${key} is fixed`);
        for (const [key, value] of [...fixed, ...envEntries]) args.push('--setenv', key, value);
        args.push('--chdir', spec.cwd, '--', ...spec.argv);
        return toBuffer(args);
    }

    // workload and terminal
    if (spec.netMode !== 'join') throw invalid(`${spec.role} needs netMode join`);
    if (!isFd(spec.homeFd)) throw invalid('homeFd must be a file descriptor number');
    cleanPath(spec.stagingDir, 'stagingDir');
    checkSource(spec.channelsDir, spec);
    cleanPath(spec.stageScript, 'stageScript');
    const fdAllow = spec.fdAllow === undefined ? [0, 1, 2] : spec.fdAllow;
    if (!Array.isArray(fdAllow) || fdAllow.some((fd) => !Number.isInteger(fd) || fd < 0 || fd > 1023)) throw invalid('Invalid fdAllow');
    if (spec.role === 'workload') args.push('--new-session');
    args.push('--bind-fd', String(spec.homeFd), '/home/robot');
    const seen = new Set();
    for (const grant of spec.grants || []) {
        if (!grant || !isValidComponentName(grant.name) || !['ro', 'rw'].includes(grant.mode) || seen.has(grant.name)) {
            throw invalid('Invalid grant');
        }
        seen.add(grant.name);
        args.push(grant.mode === 'ro' ? '--ro-bind' : '--bind', `${spec.stagingDir}/projects/${grant.name}`, `/projects/${grant.name}`);
    }
    args.push('--ro-bind', spec.channelsDir, '/run/robo-work/channels');
    args.push('--chdir', spec.cwd, '--', '/bin/sh', spec.stageScript, 'final', fdAllow.join(','),
        ...envEntries.map(([key, value]) => `${key}=${value}`), ...spec.argv);
    return toBuffer(args);
}

function toBuffer(args) {
    for (const arg of args) if (arg.includes('\0')) throw invalid('Argument contains NUL');
    return Buffer.from(args.map((arg) => `${arg}\0`).join(''), 'utf8');
}
