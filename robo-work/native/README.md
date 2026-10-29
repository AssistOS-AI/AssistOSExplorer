# RoboWork native components (keeper and per-grant file server)

Rust sources for the execution keeper (plan section 5.5) and the per-grant file server (plan section 5.4). Pure logic is host-tested on the Mac; Linux layers are compiled for `x86_64-unknown-linux-musl` and type-checked. Nothing here has been executed on Linux: every runtime property is a G1/G6 obligation.

## Crates

| Crate | Content | Tested how |
|---|---|---|
| `crates/proto` (`rw-proto`) | Strict bounded JSON, the length-prefixed frame codec (frameCodec.mjs format and bounds), the gate protocol (commit byte 0x43), view limits, the frozen `mount_view` / `unmount_view` / `view_root_lease` frames and replies, the keeper's root-lease model | Host unit tests plus golden vectors recorded from the frozen Node modules (`tests/vectors/node-golden.json`) |
| `crates/fsview` (`rw-fsview`) | File-server policy core: protected-name fold and predicate, operation policy, descriptor ledger, D2 marker, FUSE settings checker, view engine over an injected backing | Shared S5 vectors (byte copies), every code point and a 300 000-string corpus against Node's fold, engine scenarios with an in-memory backing, D2/settings against Node |
| `crates/confine` (`rw-confine`) | Seccomp BPF programs (file server; orchestration and workload domains) with a host interpreter; Linux capability, no_new_privs, rlimit, parent-death and subreaper helpers | BPF through the interpreter on the host; Linux helpers type-checked |
| `crates/keeper` (`rw-keeper`, binary `keeper`) | v1 argv, /proc and mountinfo parsers, the v1 dispatcher (pure core behind `KeeperOs`), the portable fd-3 channel writer, the Linux OS layer and event loop; PROVISIONAL: the single-bwrap domain construction and the gated stage | Pure core and the channel's no-ancillary property host-tested; Linux type-checked |
| `crates/file-server` (`rw-file-server`, binary `rw-file-server`) | fuser glue through `Session::from_fd` only, the Linux backing (anchored no-follow `*at` resolution), SIGTERM root revocation | Settings and source gates on the host; Linux type-checked |
| `tools/elfcheck` | Static ELF check (no PT_INTERP, no DT_NEEDED) | Gate script with negative controls |

## Keeper wire contract (v1)

The keeper speaks the v1 wire contract on fd 3. The R3 combined delta governs cgroup subtree custody, lease admission and stop refusals. `crates/proto/src/keeper_frames.rs` and `keeper_limits.rs` mirror the Node `keeperFrames.mjs` and `keeperLimits.mjs`, and `crates/keeper/src/core.rs` dispatches every op. The shared vectors `crates/proto/tests/vectors/keeper-wire.v1.json` are a byte copy of the S4 r10 Node file. Gate G09 checks that copy against the frozen manifest.

The optional `--cgroup-subtree <dev>:<ino>:<abs>` binds a supervisor-owned cgroup-v2 directory before hello. Its normalized path is at most 989 bytes, leaving room for the resource suffix within the 1024-byte locator limit. Linux opens and holds the directory, checks its filesystem, identity and ownership, and reads the two delegation control-file identities without following symlinks. A missing subtree causes `create cgroup` to refuse `cgroup_not_delegated`. A configured subtree requires each locator's parent to equal that subtree exactly. Every supported locator also carries this keeper's own reservation. Linux cgroup creation still refuses even when the startup checks succeed; R3 adds no cgroupfs writes.

Only `mount_view` and `unmount_view` consume the four mount slots. Lease requests use the channel limit of 16 and allow at most one outstanding request per grant until its reply is flushed. A stop on a created or aborted stage refuses `resource_not_committed` without signalling it. An already observed exit answers `exited`, including a stage that exited before commit.

## Portable launch foundation

`domain_policy.rs` defines explicit image-file pins, direct-ELF inventory, per-role mounts and descriptor mappings, bounded final environment, and single-owner startup descriptor custody. It contains no production image policy. A missing policy refuses construction. Host tests use synthetic facts; they do not establish the image's actual runtime closure or Bubblewrap descriptor behavior.

`launch.rs` models the separate namespace anchor and exec child, private bounded READY/INSTALL_STDIO/INSTALLED/FAIL records, credential and descriptor validation, and positive executable observation. READY followed by EOF cannot establish exec success. A program that runs and exits before observation is conservatively classified `exec_failed`, remains committed and must not be resubmitted automatically. The model retains one absolute commit budget across stream connection, installation, release and observation.

The core supports nonblocking pending creates and commits. It retains each request's admission slot until its reply flushes, keys completions by handle and original request ID, and discards cancelled late results through the adapter's ownership callback. Accepted commits retain ownership and reply before the one owed anchor exit. Host tests exercise cancellation races, simultaneous completions, stream failures, deadlines, channel progress and descriptor closure.

Positive commit completions carry the original observation time. The adapter retains that latch independently of queue delivery, so the expiry sweep can honor proof obtained within the original budget even when the bounded completion drain is late. Already cancelled work cannot be revived. Create notifications replay metadata for one allocation per operation token; a duplicate for a published resource neither replies again nor discards its live custody. Cleanup resolves the full token, never a notification's PID or handle alone. Once create work is scheduled, any failure becomes `failure: setup_failed` and reconciles partial custody; validation refusals before scheduling retain their original result.

Linux endpoint/process-tree/PTY creation still refuses. Startup custody is not wired from main, and the private stage channel, positive `/proc/exe` observation, pinned-socket connector and new domain topology are not implemented on Linux. Existing provisional domain/stage code is unchanged. These require the reviewed image-policy artifact, actual Bubblewrap inheritance proof and later authorized Linux integration. Public frames, limits and golden vectors remain unchanged.

| Area | Status in r3 |
|---|---|
| Schema, limits, dispatcher, in-flight and per-pty input windows, events, keeper gate, startup checks | Implemented; dispatcher host-tested with a fake OS |
| Linux `KeeperOs`: runtime directory, network namespace by descriptor, tempdir, end steps, views (mount, lease, teardown) | Implemented; type-checked only |
| Linux `KeeperOs`: endpoint and process-tree domains, PTY allocation | NOT implemented: `create` fails closed with `setup_failed` (needs the domain construction proven on Linux, G1) |
| `bwrap`, `stage`, `linux::domain`, `linux::stage_exec` | PROVISIONAL construction mechanics (contract "Out of scope": the native owner's), type-checked only |

## Build and test

All cargo commands run with `source <task-root>/native-r9/env.sh` (RUSTUP_HOME, CARGO_HOME, TMPDIR and CARGO_TARGET_DIR inside the task-local root; offline; vendored sources only). `scripts/gates.sh <task-root> <evidence-dir>` runs every gate and writes its logs.

| Gate | Command |
|---|---|
| Host tests | `cargo test --locked --offline` |
| Linux type-check of tests | `cargo test --no-run --target x86_64-unknown-linux-musl --locked --offline` |
| Static release build (twice, clean) | `cargo build --release --target x86_64-unknown-linux-musl --locked --offline` |
| ELF | `elfcheck <binary>` must report no PT_INTERP and no DT_NEEDED |

Regenerating vectors (read-only imports of the frozen Node modules): `node scripts/gen-node-vectors.mjs <robo-work> crates/proto/tests/vectors/node-golden.json crates/fsview/tests/vectors/node-views.json` and `node scripts/gen-unicode-tables.mjs <robo-work> crates/fsview/src/unicode_tables.rs crates/fsview/tests/vectors/unicode-diff.json` (requires Unicode 17.0).

Dependency exception and licences: `dependencies.md`.
