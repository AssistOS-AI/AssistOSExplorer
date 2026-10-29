# A compromised provider endpoint written in Python: it holds the endpoint end of the framed supervisor channel (fd 4)
# and sends hostile bytes to the supervisor's real fd-4 parser. Frames are a 4-byte big-endian length and JSON.
#
#   python3 -I rawEndpointPeer.py oversize                 a length prefix far above the frame maximum, then more bytes
#   python3 -I rawEndpointPeer.py partial                  a frame that is started and never finished
#   python3 -I rawEndpointPeer.py overflow <count>         <count> valid requests with ids 1..count, none ever answered
#   python3 -I rawEndpointPeer.py never-read <count>       <count> valid requests that are answered at once; the answers are never read
#   python3 -I rawEndpointPeer.py scm <per message>        valid frames that carry SCM_RIGHTS descriptors
import array
import json
import os
import socket
import struct
import sys
import time

channel = socket.socket(fileno=4)
channel.settimeout(5)
result = {'mode': sys.argv[1], 'error': None, 'sent': 0}


def frame(value):
    body = json.dumps(value, separators=(',', ':')).encode()
    return struct.pack('>I', len(body)) + body


try:
    mode = sys.argv[1]
    if mode == 'oversize':
        channel.sendall(struct.pack('>I', 0x7fffffff))
        channel.sendall(b'x' * 65536)
        result['sent'] = 1
    elif mode == 'partial':
        channel.sendall(struct.pack('>I', 200) + b'{"id":1')
        time.sleep(3)
    elif mode == 'overflow':
        for index in range(1, int(sys.argv[2]) + 1):
            channel.sendall(frame({'id': index, 'op': 'tempdir'}))
            result['sent'] = index
        time.sleep(1)
    elif mode == 'never-read':
        # Wait for the first answer so that the supervisor is serving, then never read again.
        channel.sendall(frame({'id': 1, 'op': 'inventory'}))
        header = b''
        while len(header) < 4:
            header += channel.recv(4 - len(header))
        remaining = struct.unpack('>I', header)[0]
        while remaining > 0:
            remaining -= len(channel.recv(remaining))
        for index in range(2, int(sys.argv[2]) + 1):
            channel.sendall(frame({'id': index, 'op': 'inventory'}))
            result['sent'] = index
            # Paced, so that each request is answered before the next arrives: only the unread answers can accumulate.
            time.sleep(0.001)
        time.sleep(1)
    elif mode == 'scm':
        per_message = int(sys.argv[2])
        for index in range(3):
            ends = []
            for _ in range(per_message):
                read_end, write_end = os.pipe()
                os.close(write_end)
                ends.append(read_end)
            channel.sendmsg([frame({'id': index + 1, 'op': 'inventory'})],
                            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', ends))])
            for descriptor in ends:
                os.close(descriptor)
            result['sent'] += per_message
        time.sleep(0.5)
except (BrokenPipeError, ConnectionResetError, OSError, socket.timeout) as error:
    result['error'] = type(error).__name__
sys.stdout.write(json.dumps(result) + '\n')
sys.stdout.flush()
