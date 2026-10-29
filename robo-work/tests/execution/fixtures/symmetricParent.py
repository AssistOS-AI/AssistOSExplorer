# A non-Node parent for the symmetric NODE_CHANNEL_FD check (plan section 5.5, first deterministic S4 check).
#
# It stands in for the execution keeper: it creates the socket pairs and starts the children itself, so neither Node
# process created the pair. Run it as: python3 -I symmetricParent.py '<json config>'
#
# Config:
#   children: [{name, argv, env, fds}]  fds maps a child fd number to a source:
#       "devnull"            /dev/null opened read-write
#       "stdout" | "stderr"  this parent's own fd 1 or 2
#       "pair:<name>:<0|1>"  one end of the named socket pair (each end goes to exactly one child)
#       "file"               a fresh regular file
#       "pipe"               the read end of a fresh pipe
#       "parent:<n>"         a descriptor this parent inherited from its own parent
#   pairs: [name, ...]       socket pairs to create
#   wait_for: [name, ...]    the run is over when these children have exited
#   timeout_s: number        hard limit; surviving children are then ended by their recorded PIDs
#   status: "parent:<n>"     where the JSON summary line is written
#
# Every descriptor that is not named in a child's fds map is close-on-exec here, so a child holds only its own
# descriptors. Children are signalled only by PIDs this parent recorded when it started them.

import fcntl
import json
import os
import select
import signal
import socket
import sys
import tempfile
import time

HIGH = 64


def duplicate_high(fd):
    return fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, HIGH)


def main():
    config = json.loads(sys.argv[1])
    initial_parent = os.getppid()
    sources = {}
    # Move every inherited descriptor out of the way of the children's destination numbers.
    for child in config['children']:
        for source in child['fds'].values():
            if source.startswith('parent:') and source not in sources:
                sources[source] = duplicate_high(int(source.split(':')[1]))
    status_fd = None
    if 'status' in config:
        status_fd = duplicate_high(int(config['status'].split(':')[1]))
    for number in range(3, HIGH):
        try:
            os.close(number)
        except OSError:
            pass

    pairs = {}
    for name in config.get('pairs', []):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        pairs[name] = [duplicate_high(left.detach()), duplicate_high(right.detach())]
        # detach() leaves the originals open at low numbers; close them so only the high copies remain.
    for number in range(3, HIGH):
        try:
            os.close(number)
        except OSError:
            pass

    held = []
    children = {}
    spawned = {}

    def resolve(source):
        if source == 'devnull':
            fd = os.open('/dev/null', os.O_RDWR | os.O_CLOEXEC)
        elif source == 'stdout':
            fd = duplicate_high(1)
        elif source == 'stderr':
            fd = duplicate_high(2)
        elif source == 'file':
            handle = tempfile.TemporaryFile()
            fd = duplicate_high(handle.fileno())
            handle.close()
        elif source == 'pipe':
            read_end, write_end = os.pipe()
            os.close(write_end)
            fd = duplicate_high(read_end)
            os.close(read_end)
        elif source.startswith('pair:'):
            _, name, side = source.split(':')
            fd = pairs[name][int(side)]
            spawned.setdefault(source, True)
            return fd
        elif source.startswith('parent:'):
            return sources[source]
        else:
            raise ValueError('unknown fd source ' + source)
        held.append(fd)
        return fd

    for child in config['children']:
        actions = []
        for destination, source in child['fds'].items():
            actions.append((os.POSIX_SPAWN_DUP2, resolve(source), int(destination)))
        pid = os.posix_spawn(child['argv'][0], child['argv'], child['env'], file_actions=actions)
        children[child['name']] = {'pid': pid, 'code': None, 'signal': None}

    # The children now hold their own copies. This parent keeps nothing that could hold a pair open.
    for ends in pairs.values():
        for fd in ends:
            os.close(fd)
    for fd in held:
        os.close(fd)

    def terminate(number=signal.SIGTERM):
        for entry in children.values():
            if entry['code'] is None and entry['signal'] is None:
                try:
                    os.kill(entry['pid'], number)
                except ProcessLookupError:
                    pass

    def on_term(_number, _frame):
        terminate(signal.SIGKILL)
        sys.exit(143)

    signal.signal(signal.SIGTERM, on_term)

    def reap():
        for entry in children.values():
            if entry['code'] is not None or entry['signal'] is not None:
                continue
            try:
                done, state = os.waitpid(entry['pid'], os.WNOHANG)
            except ChildProcessError:
                entry['code'] = -1
                continue
            if done:
                if os.WIFSIGNALED(state):
                    entry['signal'] = os.WTERMSIG(state)
                else:
                    entry['code'] = os.WEXITSTATUS(state)

    def finished(name):
        entry = children[name]
        return entry['code'] is not None or entry['signal'] is not None

    deadline = time.monotonic() + config.get('timeout_s', 30)
    timed_out = False
    while True:
        reap()
        if all(finished(name) for name in config['wait_for']):
            break
        if os.getppid() != initial_parent or time.monotonic() > deadline:
            timed_out = time.monotonic() > deadline
            break
        select.select([], [], [], 0.02)
    # Survivors are ended by the PIDs recorded above: terminate, then kill after a short grace.
    terminate(signal.SIGTERM)
    grace = time.monotonic() + 2
    while time.monotonic() < grace:
        reap()
        if all(finished(name) for name in children):
            break
        select.select([], [], [], 0.02)
    terminate(signal.SIGKILL)
    reap()
    select.select([], [], [], 0.05)
    reap()
    summary = {'timedOut': timed_out, 'children': children}
    if status_fd is not None:
        os.write(status_fd, (json.dumps(summary) + '\n').encode())


main()
