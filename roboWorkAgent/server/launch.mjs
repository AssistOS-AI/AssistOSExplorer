import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeEnvironment } from './native-environment.mjs';
import { homeTarget, fail } from './robot-paths.mjs';

export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

// Mount isolation narrows ALA's host view without an outer bwrap dropping namespace capabilities.
export async function buildPrivateLaunch({ paths, id, directory, command, args, env = {}, guiPort }) {
    const robot = paths.robot(id);
    const bindings = [[robot, robot], [directory, directory], [path.join(paths.dataDir, 'tool-cache'), path.join(paths.dataDir, 'tool-cache')]];
    const script = ['#!/bin/sh', 'set -eu', 'mount --make-rprivate /',
        'stage=$(mktemp -d /tmp/robowork-mount.XXXXXX)'];
    for (const [index, [source]] of bindings.entries()) {
        script.push(`mkdir "$stage/${index}"`, `mount --bind ${shellQuote(source)} "$stage/${index}"`);
    }
    script.push(`mount -t tmpfs tmpfs ${shellQuote(paths.dataDir)}`);
    for (const [index, [, target]] of bindings.entries()) {
        script.push(`mkdir -p ${shellQuote(target)}`, `mount --bind "$stage/${index}" ${shellQuote(target)}`);
    }
    for (const index of bindings.keys()) script.push(`umount "$stage/${index}"`, `rmdir "$stage/${index}"`);
    script.push('rmdir "$stage"', `exec ${[command, ...args].map(shellQuote).join(' ')}`);
    const wrapper = path.join(directory, 'launch.sh');
    await fs.writeFile(wrapper, script.join('\n') + '\n', { mode: 0o700 });
    const pastaArgs = ['--netns-only', '--runas', '0:0', '--config-net', '--no-map-gw', '-t', 'none', '-u', 'none'];
    if (guiPort !== undefined) {
        if (!Number.isInteger(guiPort) || guiPort < 1 || guiPort > 65535) throw fail('INVALID_INPUT', 'Invalid GUI port');
        pastaArgs.push('-T', String(guiPort));
    }
    pastaArgs.push('-U', 'none', '--', '/bin/sh', '-c', `exec unshare --mount /bin/sh ${shellQuote(wrapper)}`);
    const native = nativeEnvironment(env, paths.home(id));
    native.ALA_SANDBOX_HOME = homeTarget(id);
    return { command: 'pasta', args: pastaArgs, options: { env: native, detached: true, stdio: ['pipe', 'pipe', 'pipe'] } };
}
