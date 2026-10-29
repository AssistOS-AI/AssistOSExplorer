# Reports what this kernel does with SCM_RIGHTS descriptors when the receiver uses a plain read() with no ancillary
# buffer, which is what libuv does for a child's standard-stream pipe: "installs" or "discards".
import array
import json
import os
import socket


def count():
    return len(os.listdir('/dev/fd'))


left, right = socket.socketpair()
ends = []
for _ in range(8):
    read_end, write_end = os.pipe()
    os.close(write_end)
    ends.append(read_end)
baseline = count()
left.sendmsg([b'x\n'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', ends))])
os.read(right.fileno(), 16)
print(json.dumps({'behavior': 'installs' if count() > baseline else 'discards', 'delta': count() - baseline}))
