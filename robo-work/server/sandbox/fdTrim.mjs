// Preload for `node --import` in the orchestration and endpoint sandboxes (plan Revision 10, section B "fd allowlist").
// Node sets O_CLOEXEC on every fd and has no fcntl, so inherited fds cannot be passed through a Node exec; instead this
// module closes, before any other code loads, every fd >= 3 that is not in the allowlist `RW_FD_ALLOW` (e.g. "0,1,2,3").
// An absent or malformed allowlist throws (fail closed). The variable is removed from process.env afterwards.
//
// Node's own fds are also >= 3 and must stay open, and Node marks every fd O_CLOEXEC (inherited ones too), so no flag
// tells them apart. They are recognised by shape and skipped: `anon_inode:[eventpoll]`, `[eventfd]` and `[io_uring]`
// links, `/dev/null` (libuv's reserve descriptor), and a pipe whose inode is open twice in this process (libuv's
// in-process pipe pairs). Everything else is closed: files, directories, sockets, a pipe with a single local end, pidfds.
// Residual, recorded for review: an inherited epoll, eventfd, /dev/null or both ends of one pipe would survive.

import fs from 'node:fs';

const INTERNAL_LINKS = new Set(['anon_inode:[io_uring]', 'anon_inode:[eventpoll]', 'anon_inode:[eventfd]', '/dev/null']);

export function parseAllowlist(value) {
    if (typeof value !== 'string' || !/^[0-9]+(,[0-9]+)*$/.test(value)) throw new Error('RW_FD_ALLOW is missing or malformed');
    return new Set(value.split(',').map(Number));
}

// Returns the list of closed fds.
export function trimFds(allow) {
    const links = new Map();
    for (const name of fs.readdirSync('/proc/self/fd')) {
        try {
            links.set(Number(name), fs.readlinkSync(`/proc/self/fd/${name}`));
        } catch {
            // the readdir's own descriptor, already closed
        }
    }
    const pipeUse = new Map();
    for (const target of links.values()) if (target.startsWith('pipe:')) pipeUse.set(target, (pipeUse.get(target) || 0) + 1);
    const closed = [];
    for (const [fd, target] of links) {
        if (!Number.isInteger(fd) || fd < 3 || allow.has(fd) || INTERNAL_LINKS.has(target)) continue;
        if (target.startsWith('pipe:') && pipeUse.get(target) >= 2) continue;
        try {
            fs.closeSync(fd);
            closed.push(fd);
        } catch {
            // already closed
        }
    }
    return closed;
}

trimFds(parseAllowlist(process.env.RW_FD_ALLOW));
delete process.env.RW_FD_ALLOW;
