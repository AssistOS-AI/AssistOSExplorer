# T0-03 unfiltered-control syscalls (plan g4-apparatus-target-plan R1.7 M-5), run with the image python3 -I.
# Every control targets this script's own child (Yama ptrace_scope=1 allows only descendants).
# Prints one JSON object: the valid calls (control baselines for later G1 negative controls) and the invalid-target
# calls (the instrument's own negative control: each must fail and report its errno).
import ctypes
import json
import os
import subprocess
import sys

MARKER = sys.argv[1] if len(sys.argv) > 1 else 'g4rw-unknown'
NR = {
    'x86_64': {'keyctl': 250, 'pidfd_getfd': 438},
    'aarch64': {'keyctl': 219, 'pidfd_getfd': 438},
}
KEYCTL_GET_KEYRING_ID = 0
KEY_SPEC_SESSION_KEYRING = -3
INVALID_PID = 1 << 30
CHILD = 'import ctypes, sys\nbuf = ctypes.create_string_buffer(b"G1MARK")\nprint(ctypes.addressof(buf), flush=True)\nsys.stdin.read()\n'

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class IoVec(ctypes.Structure):
    _fields_ = [('iov_base', ctypes.c_void_p), ('iov_len', ctypes.c_size_t)]


def syscall(name, *args):
    ctypes.set_errno(0)
    rc = libc.syscall(ctypes.c_long(NR[ARCH][name]), *[ctypes.c_long(a) for a in args])
    return {'rc': int(rc), 'errno': ctypes.get_errno() if rc == -1 else 0}


def vm_readv(pid, address, length):
    local = ctypes.create_string_buffer(length)
    liov = IoVec(ctypes.cast(local, ctypes.c_void_p), length)
    riov = IoVec(ctypes.c_void_p(address), length)
    libc.process_vm_readv.restype = ctypes.c_ssize_t
    ctypes.set_errno(0)
    rc = libc.process_vm_readv(ctypes.c_int(pid), ctypes.byref(liov), ctypes.c_ulong(1), ctypes.byref(riov), ctypes.c_ulong(1), ctypes.c_ulong(0))
    out = {'rc': int(rc), 'errno': ctypes.get_errno() if rc == -1 else 0}
    if rc == length:
        out['bytesMatch'] = local.raw == b'G1MARK'
    return out


ARCH = os.uname().machine
result = {'marker': MARKER, 'arch': ARCH, 'python': sys.version.split()[0], 'valid': {}, 'invalid': {}}
if ARCH not in NR:
    result['error'] = 'unsupported architecture'
    print(json.dumps(result))
    sys.exit(0)

child = subprocess.Popen([sys.executable, '-I', '-c', CHILD, MARKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
try:
    address = int(child.stdout.readline())
    try:
        pidfd = os.pidfd_open(child.pid)
        result['valid']['pidfd_open'] = {'rc': pidfd, 'errno': 0}
    except OSError as error:
        pidfd = -1
        result['valid']['pidfd_open'] = {'rc': -1, 'errno': error.errno}
    got = syscall('pidfd_getfd', pidfd, 0, 0)
    result['valid']['pidfd_getfd'] = got
    if got['rc'] >= 0:
        os.close(got['rc'])
    result['valid']['process_vm_readv'] = vm_readv(child.pid, address, 6)
    result['valid']['keyctl'] = syscall('keyctl', KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 1)
    result['invalid']['pidfd_getfd_bad_fd'] = syscall('pidfd_getfd', pidfd, 987654, 0)
    result['invalid']['process_vm_readv_bad_pid'] = vm_readv(INVALID_PID, address, 6)
    result['invalid']['keyctl_bad_op'] = syscall('keyctl', 9999, 0, 0)
    if pidfd >= 0:
        os.close(pidfd)
finally:
    child.stdin.close()
    child.wait(timeout=10)
result['childExit'] = child.returncode
print(json.dumps(result))
