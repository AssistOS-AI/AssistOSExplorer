# A hostile ALA written in Python, started by the non-Node parent with its end of the provider channel as fd 3. Node's
# IPC with JSON serialization is newline-delimited JSON, so this peer can speak it directly, never stop reading, send
# a line without a newline, and attach raw SCM_RIGHTS descriptors, none of which a Node fixture can do.
#
#   python3 -I rawAlaPeer.py flood-never-read <count> <interval_ms>   valid requests, paced, replies never read
#   python3 -I rawAlaPeer.py burst <count>                              valid requests in one write
#   python3 -I rawAlaPeer.py long-line <mebibytes>                      a line with no newline
#   python3 -I rawAlaPeer.py many-fds <per message> <messages>          raw sendmsg carrying many descriptors
#   python3 -I rawAlaPeer.py raw-handle                                 a NODE_HANDLE message with a real descriptor
import array
import json
import os
import select
import socket
import sys
import time

channel = socket.socket(fileno=3)
result = {'mode': sys.argv[1], 'sent': 0, 'error': None, 'answered': None, 'closed': False}


def line(message):
    return (json.dumps(message, separators=(',', ':')) + '\n').encode()


def drain_answers(seconds):
    """Reads whatever the endpoint answered and reports whether it is still connected."""
    texts = b''
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([channel], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = channel.recv(65536)
        except OSError:
            result['closed'] = True
            break
        if not chunk:
            result['closed'] = True
            break
        texts += chunk
    messages = []
    for text in texts.split(b'\n'):
        try:
            messages.append(json.loads(text))
        except ValueError:
            pass
    return messages


try:
    channel.settimeout(10)
    channel.sendall(line({'type': 'hello', 'protocol': 'ala-execution-provider', 'versions': [1]}))
    # Wait for the endpoint's hello answer, so the attack starts against a running endpoint and is not delivered as one
    # burst while the endpoint is still starting.
    pending = b''
    while b'\n' not in pending:
        chunk = channel.recv(65536)
        if not chunk:
            raise ConnectionResetError('the endpoint closed before it answered hello')
        pending += chunk
    result['hello'] = json.loads(pending.split(b'\n')[0]).get('type')
    mode = sys.argv[1]
    if mode == 'flood-never-read':
        count, interval = int(sys.argv[2]), int(sys.argv[3]) / 1000
        for index in range(1, count + 1):
            channel.sendall(line({'type': 'inventory', 'id': index}))
            result['sent'] = index
            time.sleep(interval)
    elif mode == 'burst':
        count = int(sys.argv[2])
        channel.sendall(b''.join(line({'type': 'inventory', 'id': index}) for index in range(1, count + 1)))
        result['sent'] = count
        messages = drain_answers(2)
        result['answered'] = len([m for m in messages if m.get('type') == 'result'])
        result['failure'] = next((m['error']['message'] for m in messages if m.get('type') == 'failure'), None)
    elif mode == 'long-line':
        block = b'a' * (1024 * 1024)
        for _ in range(int(sys.argv[2])):
            channel.sendall(block)
            result['sent'] += 1
    elif mode == 'many-fds':
        per_message, messages_count = int(sys.argv[2]), int(sys.argv[3])
        ends = []
        for _ in range(per_message):
            read_end, write_end = os.pipe()
            os.close(write_end)
            ends.append(read_end)
        for index in range(messages_count):
            channel.sendmsg([line({'type': 'inventory', 'id': index + 1})],
                            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', ends))])
            result['sent'] += per_message
        channel.sendall(line({'type': 'inventory', 'id': 9999}))
        messages = drain_answers(3)
        result['answered'] = any(m.get('type') == 'result' and m.get('id') == 9999 for m in messages)
    elif mode == 'raw-handle':
        left, right = socket.socketpair()
        wrapped = {'cmd': 'NODE_HANDLE', 'type': 'net.Socket', 'msg': {'type': 'inventory', 'id': 1}}
        channel.sendmsg([line(wrapped)], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [left.fileno()]))])
        left.close()
        messages = drain_answers(3)
        result['failure'] = next((m['error']['message'] for m in messages if m.get('type') == 'failure'), None)
        result['answered'] = any(m.get('type') == 'result' for m in messages)
        # The endpoint must have closed the descriptor it received: its peer sees end-of-stream.
        right.settimeout(3)
        try:
            result['peerClosed'] = right.recv(16) == b''
        except OSError:
            result['peerClosed'] = True
except (BrokenPipeError, ConnectionResetError, OSError, socket.timeout) as error:
    result['error'] = type(error).__name__
sys.stdout.write(json.dumps(result) + '\n')
sys.stdout.flush()
