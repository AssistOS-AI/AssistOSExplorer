// Pure builder of the per-role bwrap arguments (plan Revision 10, sections B and G).
//
// API
//   buildBwrapArgs(spec) -> Buffer of NUL-terminated OPTIONS, for `bwrap --args <fd>` (bwrap reads them in place). The
//     buffer holds every option, including every environment value (`--setenv`), but NOT the command: bwrap takes the
//     command only from its real argv (observed with bwrap 0.12.0: a `--` and command inside the --args data are ignored
//     and bwrap prints its usage).
//   bwrapCommand(spec) -> string[] : the command, for the real argv after `--`. orchestration and endpoint: spec.argv
//     (node directly, no shell). workload and terminal: ['/bin/sh', stageScript, 'final', <fd allowlist csv>,
//     <env names csv>, ...argv]; the environment VALUES are in the buffer and reach the command through stage.sh final.
//   bwrapRealArgv({ argsFd, marker, command? }) -> string[] : the REAL argv of the bwrap process (publication barrier):
//        ['/usr/bin/bwrap', '--unshare-uts', '--unsetenv', marker, '--args', String(argsFd), '--', ...command]
//     The marker (the S1 reservation id) must be a literal element of the real argv so that recovery can match it with
//     `cmdline.includes`; it is never put in the --args buffer. `--unsetenv <marker>` unsets a name that does not exist (no effect inside the sandbox; the sandbox keeps the worker's hostname in its private UTS namespace); `--unshare-uts` stays because bwrap
//     requires it; the buffer repeats `--unshare-uts` harmlessly. stage.sh prep execs this argv.
//   BWRAP_PATH, ROLES, FIXED_DESTINATIONS
//
// spec
//   role            'orchestration' | 'endpoint' | 'workload' | 'terminal'
//   marker          the S1 reservation id, [A-Za-z0-9_-]{8,64}, see marker.mjs (validated; used by bwrapRealArgv and the workload/terminal stage argument)
//   seccompFd, blockFd, infoFd, jsonStatusFd   control fd numbers, as seen by bwrap
//   roBinds         [{ source, dest }]  image paths, read-only   (dest within FIXED_DESTINATIONS)
//   roFiles         [{ source, dest }]  generated single files bound read-only; dest only /etc/resolv.conf or /etc/hosts. Not for
//                   orchestration (no network). The workload gets the nameservers its firewall allows and a minimal hosts file.
//   binds           [{ source, dest, mode: 'ro' | 'rw' }]  directories of the execution runtime directory (path binds)
//   stageBinds      [{ name, dest, mode }]  anchored directories bound by prep at <stagingDir>/binds/<name> (orchestration,
//                   endpoint; workload and terminal always get <stagingDir>/binds/home at /home/robot)
//   symlinks        [{ target, dest }]  e.g. { target: 'usr/bin', dest: '/bin' }
//   env             allowlisted environment, always as `--setenv` in the buffer (never on a command line). Workload and
//                   terminal names must be [A-Z_][A-Z0-9_]* and not one the shell itself honours (IFS, BASH_ENV, ENV, LD_*,
//                   ...), because the values reach stage.sh's shell first; stage.sh final then keeps exactly the names
//                   listed on its command line
//   cwd, argv       working directory and the command (argv[0] must be non-empty, not start with '-', contain no '=')
//   orchestration, endpoint: netMode 'none' (orchestration: --unshare-net) or 'join' (endpoint: joins the execution
//     netns through nsenter before bwrap, so no --unshare-net); fixed NODE_CHANNEL_FD=3 and
//     NODE_CHANNEL_SERIALIZATION_MODE=json are set, bwrap execs argv directly (no shell)
//   workload, terminal: stagingDir, channelsDir, stageScript (absolute path of stage.sh), fdAllow (default
//     [0,1,2]), grants [{ name, mode: 'ro' | 'rw', skill? }] bound from `<stagingDir>/projects/<name>` to `/projects/<name>`;
//     an entry with `skill` (workload only; M-22 skills view, T2) is a skill staged by prep like a grant under a reserved stage
//     name (SKILL_STAGE_NAME, never a project grant name) and is bound read-only at `/run/robo-work/skills/<skill>` instead. Every
//     workload gets the view: `--perms 0555 --tmpfs /run/robo-work/skills`, one `--ro-bind` per skill, then `--remount-ro` of the
//     tmpfs, so the view and every skill in it are read-only (EROFS) and nothing but the admitted skills is in it (empty when none);
//     bwrap runs `/bin/sh <stageScript> final <fdAllow csv> <env names csv> <argv…>`; workload adds --new-session,
//     terminal does not. Orchestration also gets --new-session.
//   grantPaths      optional extra absolute paths that no source may be under
//   procMasks       [{ path, kind, bwrap }] from procMasks.mjs (the worker container's /proc masks, re-applied after
//                   `--proc /proc` in every role); each path must be /proc/<name>
//   tmpDir          workload and terminal only: a runtime directory bound at /tmp over the tmpfs, so that a temporary
//                   directory made by `tempdir` is shared by every workload of the execution
//
// Throws Error with code 'invalid_request' for an unknown role, a destination outside the fixed set, a source under a
// grant (or under /projects), or malformed fields.

import { isValidComponentName } from '../views/protectedNames.mjs';
import { isMarker } from './marker.mjs';
import { procMaskArgs } from './procMasks.mjs';

export const BWRAP_PATH = '/usr/bin/bwrap';
export const ROLES = Object.freeze(['orchestration', 'endpoint', 'workload', 'terminal']);
// A destination must equal one of these or be below it. /projects/<name> is produced only from `grants`.
export const FIXED_DESTINATIONS = Object.freeze([
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/alternatives',
    '/opt/robo-work', '/opt/robo-work-tools', '/run/robo-work', '/home/robot', '/session', '/config', '/stream', '/rw-stage'
]);

export const STAGE_BIND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
// Skills view (T2). A reserved stage name is ONLY ever a skill's and a skill always has one, in both directions, so a skill can never be
// mounted as a project grant and a project grant never into the view (whatever a caller passes through).
export const SKILL_STAGE_NAME = /^s[0-9]{1,2}$/u;
export const SKILLS_VIEW = '/run/robo-work/skills';
export const RUN_ROBO_WORK = '/run/robo-work';
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WORKLOAD_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHELL_HONOURED = /^(IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|LD_[A-Z0-9_]*|BASH_FUNC_[A-Z0-9_]*|_)$/;
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

export function bwrapRealArgv({ argsFd, marker, command = [] }) {
    if (!isFd(argsFd)) throw invalid('argsFd must be a file descriptor number');
    if (!isMarker(marker)) throw invalid('Invalid marker');
    if (!Array.isArray(command) || command.some((item) => typeof item !== 'string' || item.includes('\0'))) throw invalid('Invalid command');
    return [BWRAP_PATH, '--unshare-uts', '--unsetenv', marker, '--args', String(argsFd), ...(command.length > 0 ? ['--', ...command] : [])];
}

export function bwrapCommand(spec) {
    if (spec === null || typeof spec !== 'object' || !ROLES.includes(spec.role)) throw invalid('Unknown role');
    checkArgv(spec.argv);
    if (spec.role === 'orchestration' || spec.role === 'endpoint') return [...spec.argv];
    cleanPath(spec.stageScript, 'stageScript');
    const fdAllow = spec.fdAllow === undefined ? [0, 1, 2] : spec.fdAllow;
    if (!Array.isArray(fdAllow) || fdAllow.some((fd) => !Number.isInteger(fd) || fd < 0 || fd > 1023)) throw invalid('Invalid fdAllow');
    return ['/bin/sh', spec.stageScript, 'final', fdAllow.join(','), Object.keys(spec.env || {}).join(','), ...spec.argv];
}

export function buildBwrapArgs(spec) {
    if (spec === null || typeof spec !== 'object') throw invalid('spec must be an object');
    if (!ROLES.includes(spec.role)) throw invalid(`Unknown role: ${String(spec.role)}`);
    if (!isMarker(spec.marker)) throw invalid('Invalid marker');
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

    const procMasks = spec.procMasks || [];
    if (!Array.isArray(procMasks) || procMasks.some((mask) => !mask || typeof mask.path !== 'string' || !/^\/proc\/[A-Za-z0-9_.-]+$/u.test(mask.path))) {
        throw invalid('Invalid procMasks');
    }
    args.push(...procMaskArgs(procMasks));

    for (const bind of spec.roBinds || []) {
        args.push('--ro-bind', checkSource(bind.source, spec), checkDestination(bind.dest));
    }
    for (const link of spec.symlinks || []) {
        if (typeof link.target !== 'string' || link.target.includes('\0')) throw invalid('Invalid symlink');
        args.push('--symlink', link.target, checkDestination(link.dest));
    }
    const roFiles = spec.roFiles || [];
    if (!Array.isArray(roFiles) || (roFiles.length > 0 && spec.role === 'orchestration')) throw invalid('roFiles are not allowed here');
    for (const file of roFiles) {
        if (!file || !['/etc/resolv.conf', '/etc/hosts'].includes(file.dest)) throw invalid('roFiles destination');
        args.push('--ro-bind', checkSource(file.source, spec), file.dest);
    }
    // Directories of the execution's own runtime directory (stream, channels, tmp): plain path binds.
    for (const bind of spec.binds || []) {
        if (!['ro', 'rw'].includes(bind.mode)) throw invalid('Invalid bind');
        args.push(bind.mode === 'ro' ? '--ro-bind' : '--bind', checkSource(bind.source, spec), checkDestination(bind.dest));
    }
    // Anchored directories (session storage, config, HOME): prep bound them at <stagingDir>/binds/<name> after verifying
    // their identity. `--bind-fd` cannot be used: the kernel refuses to bind a mount that belongs to another mount
    // namespace, and a descriptor opened before `unshare --mount` refers to one (observed: EINVAL "wrong fs type").
    for (const bind of spec.stageBinds || []) {
        if (!STAGE_BIND_NAME.test(bind.name) || !['ro', 'rw'].includes(bind.mode)) throw invalid('Invalid stage bind');
        cleanPath(spec.stagingDir, 'stagingDir');
        args.push(bind.mode === 'ro' ? '--ro-bind' : '--bind', `${spec.stagingDir}/binds/${bind.name}`, checkDestination(bind.dest));
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
        args.push('--chdir', spec.cwd);
        return toBuffer(args);
    }

    // workload and terminal
    if (spec.netMode !== 'join' && spec.netMode !== 'none') throw invalid(`${spec.role} needs netMode join or none`);
    cleanPath(spec.stagingDir, 'stagingDir');
    checkSource(spec.channelsDir, spec);
    cleanPath(spec.stageScript, 'stageScript');
    const fdAllow = spec.fdAllow === undefined ? [0, 1, 2] : spec.fdAllow;
    if (!Array.isArray(fdAllow) || fdAllow.some((fd) => !Number.isInteger(fd) || fd < 0 || fd > 1023)) throw invalid('Invalid fdAllow');
    if (spec.role === 'workload') args.push('--new-session');
    if (spec.netMode === 'none') args.push('--unshare-net'); // network mode "none": loopback only
    args.push('--bind', `${spec.stagingDir}/binds/home`, '/home/robot');
    const seen = new Set();
    const skills = [];
    const skillNames = new Set();
    for (const grant of spec.grants || []) {
        if (!grant || !isValidComponentName(grant.name) || !['ro', 'rw'].includes(grant.mode) || seen.has(grant.name)) {
            throw invalid('Invalid grant');
        }
        seen.add(grant.name);
        const isSkill = grant.skill !== undefined;
        if (isSkill !== SKILL_STAGE_NAME.test(grant.name)) throw invalid('A skill needs a reserved stage name and only a skill has one');
        if (isSkill) {
            if (spec.role !== 'workload' || grant.mode !== 'ro' || typeof grant.skill !== 'string' || !SKILL_NAME.test(grant.skill) || skillNames.has(grant.skill)) {
                throw invalid('Invalid skill');
            }
            skillNames.add(grant.skill);
            skills.push(grant);
            continue;
        }
        args.push(grant.mode === 'ro' ? '--ro-bind' : '--bind', `${spec.stagingDir}/projects/${grant.name}`, `/projects/${grant.name}`);
    }
    const workload = spec.role === 'workload';
    // M-69 Q2 (workload): /run/robo-work is its own read-only tmpfs holding only the channel bind and the skills view, so nothing can be
    // created there or beside them.
    if (workload) args.push('--perms', '0555', '--tmpfs', RUN_ROBO_WORK);
    if (workload) {
        args.push('--perms', '0555', '--tmpfs', SKILLS_VIEW);
        for (const skill of skills) args.push('--ro-bind', `${spec.stagingDir}/projects/${skill.name}`, checkDestination(`${SKILLS_VIEW}/${skill.skill}`));
        args.push('--remount-ro', SKILLS_VIEW);
    }
    args.push('--ro-bind', spec.channelsDir, '/run/robo-work/channels');
    if (workload) args.push('--remount-ro', RUN_ROBO_WORK);
    if (spec.tmpDir !== undefined) args.push('--bind', checkSource(spec.tmpDir, spec), '/tmp');
    // M-69 Q2 (workload): the sandbox root (bwrap's own tmpfs) is remounted read-only once every mount exists, so a workload can neither
    // create nor rename anything outside its binds (`mv /run/robo-work /run/moved` is EROFS). Every path a workload writes is its own
    // mount: HOME, the project grants, /tmp (the execution's tmp bind), /dev/shm and /dev. The remount is not recursive.
    if (workload) args.push('--remount-ro', '/');
    for (const [key, value] of envEntries) {
        if (!WORKLOAD_ENV_NAME.test(key) || SHELL_HONOURED.test(key)) throw invalid(`Environment name not allowed: ${key}`);
        args.push('--setenv', key, value);
    }
    args.push('--chdir', spec.cwd);
    return toBuffer(args);
}

function toBuffer(args) {
    for (const arg of args) if (arg.includes('\0')) throw invalid('Argument contains NUL');
    return Buffer.from(args.map((arg) => `${arg}\0`).join(''), 'utf8');
}
