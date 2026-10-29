# A fake orchestration domain written in Python so that it can attach real descriptors (SCM_RIGHTS) to its writes on
# stdout, stderr and stdin. It first checks that its three standard descriptors are Unix sockets; if they were not,
# the descriptor cases would prove nothing, and it reports that instead.
import array
import json
import os
import socket
import stat
import sys

report = {'sockets': [stat.S_ISSOCK(os.fstat(fd).st_mode) for fd in (0, 1, 2)], 'sent': 0}


def send_with_descriptors(fd, payload, count):
    endpoints = []
    for _ in range(count):
        read_end, write_end = os.pipe()
        os.close(write_end)
        endpoints.append(read_end)
    channel = socket.socket(fileno=os.dup(fd))
    try:
        channel.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', endpoints))])
        report['sent'] += count
    finally:
        channel.close()
        for descriptor in endpoints:
            os.close(descriptor)


per_message = int(sys.argv[1])
messages = int(sys.argv[2])
for index in range(messages):
    send_with_descriptors(1, (json.dumps({'type': 'event', 'n': index}) + '\n').encode(), per_message)
    send_with_descriptors(2, b'diagnostic text\n', per_message)
    try:
        send_with_descriptors(0, b'unread\n', per_message)
    except OSError:
        pass
sys.stdout.write(json.dumps({'type': 'report', **report}) + '\n')
sys.stdout.flush()
