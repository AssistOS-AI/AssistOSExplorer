# A keeper STAND-IN for the Linux-only keeper client test (keeper wire contract delta AC-15, NC-3b). It speaks just
# enough of the v1 wire on fd 3 to be committed and pinged, and it attaches SCM_RIGHTS descriptors (open /dev/null
# descriptors) to every frame it writes, so that the test can show that the supervisor's plain read() leaves its
# descriptor table unchanged on Linux while every frame is still processed. It never runs on Darwin as evidence.
#
#   scmKeeper.py serve --protocol 1 --reservation <marker> ... --channel-limit name=value ... --view-limit name=value ...
#
# Exits 0 after a shutdown reply, 66 on EOF, 65 on anything it does not expect.
import array
import json
import os
import socket
import struct
import sys

PER_FRAME = 4


def parse(argv):
    out = {'channel': {}, 'view': {}}
    index = argv.index('serve') + 1
    while index < len(argv):
        flag, value = argv[index], argv[index + 1]
        if flag == '--reservation':
            out['marker'] = value
        elif flag in ('--channel-limit', '--view-limit'):
            name, number = value.split('=', 1)
            out['channel' if flag == '--channel-limit' else 'view'][name] = int(number)
        index += 2
    return out


def start_time():
    with open('/proc/self/stat', 'r') as handle:
        text = handle.read()
    return str(int(text[text.rindex(')') + 2:].split(' ')[19]))


args = parse(sys.argv)
channel = socket.socket(fileno=3)
descriptors = [os.open('/dev/null', os.O_RDONLY) for _ in range(PER_FRAME)]


def send(value):
    payload = json.dumps(value, separators=(',', ':')).encode('utf-8')
    frame = struct.pack('>I', len(payload)) + payload
    channel.sendmsg([frame], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', descriptors))])


def read_exact(count):
    data = b''
    while len(data) < count:
        chunk = channel.recv(count - len(data))
        if not chunk:
            sys.exit(66)
        data += chunk
    return data


HELLO = ['maxFrameBytes', 'maxInFlight', 'reservedInFlight', 'partialFrameDeadlineMs', 'ptyChunkBytes', 'ptyMaxCreditBytes',
         'ptyInputWindowFrames', 'ptyInputWindowBytes', 'maxOutboundBytes', 'maxPtysPerKeeper']
limits = {name: args['channel'][name] for name in HELLO}
limits['rootLeaseTtlMs'] = args['view']['rootLeaseTtlMs']
send({'event': 'hello', 'protocol': 'robo-work-keeper', 'version': 1, 'pid': os.getpid(), 'startTime': start_time(),
      'marker': args['marker'], 'limits': limits})
while True:
    length = struct.unpack('>I', read_exact(4))[0]
    frame = json.loads(read_exact(length).decode('utf-8'))
    op = frame.get('op')
    if op in ('commit_keeper', 'ping'):
        send({'id': frame['id'], 'ok': True, 'value': {}})
    elif op == 'shutdown':
        send({'id': frame['id'], 'ok': True, 'value': {}})
        channel.close()
        sys.exit(0)
    else:
        sys.exit(65)
