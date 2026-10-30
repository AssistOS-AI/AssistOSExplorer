// Syscall numbers and audit architectures for the seccomp compiler (plan Revision 10, section C).
//
// Numbers are from the kernel's generic (aarch64) and x86_64 tables. Only syscalls that exist on the architecture are
// listed; every name below exists on both, so a profile denies the same set on both architectures.

export const AUDIT_ARCH = Object.freeze({ x86_64: 0xc000003e, aarch64: 0xc00000b7 });

// x86_64 syscalls with this bit set are the x32 ABI.
export const X32_SYSCALL_BIT = 0x40000000;

export const SYSCALLS = Object.freeze({
    x86_64: Object.freeze({
        keyctl: 250, add_key: 248, request_key: 249, bpf: 321, perf_event_open: 298, userfaultfd: 323,
        io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
        kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313, delete_module: 176,
        open_by_handle_at: 304, name_to_handle_at: 303,
        mount: 165, umount2: 166, pivot_root: 155,
        fsopen: 430, fsconfig: 431, fsmount: 432, move_mount: 429, open_tree: 428, mount_setattr: 442,
        ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, pidfd_getfd: 438,
        read: 0
    }),
    aarch64: Object.freeze({
        keyctl: 219, add_key: 217, request_key: 218, bpf: 280, perf_event_open: 241, userfaultfd: 282,
        io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
        kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273, delete_module: 106,
        open_by_handle_at: 265, name_to_handle_at: 264,
        mount: 40, umount2: 39, pivot_root: 41,
        fsopen: 430, fsconfig: 431, fsmount: 432, move_mount: 429, open_tree: 428, mount_setattr: 442,
        ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, pidfd_getfd: 438,
        read: 63
    })
});

// Denied with EPERM in every profile.
export const DENIED_ALL = Object.freeze([
    'keyctl', 'add_key', 'request_key', 'bpf', 'perf_event_open', 'userfaultfd',
    'io_uring_setup', 'io_uring_enter', 'io_uring_register',
    'kexec_load', 'kexec_file_load', 'init_module', 'finit_module', 'delete_module',
    'open_by_handle_at', 'name_to_handle_at',
    'mount', 'umount2', 'pivot_root',
    'fsopen', 'fsconfig', 'fsmount', 'move_mount', 'open_tree', 'mount_setattr'
]);

// Denied in addition for the orchestration (and endpoint) profile.
export const DENIED_ORCHESTRATION_EXTRA = Object.freeze(['ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_getfd']);
