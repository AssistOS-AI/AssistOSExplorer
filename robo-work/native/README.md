# RoboWork native components (keeper and per-grant file server)

Rust sources for the execution keeper (plan section 5.5) and the per-grant file server (plan section 5.4). Pure logic is host-tested; Linux layers are compiled for `x86_64-unknown-linux-musl`. Unit tests that need only an unprivileged Linux kernel (private stage channel, pidfds, pinned sockets, no-follow opens) run in the musl test container. Runtime properties remain G1/G6 obligations; the evidence of record for a candidate names exactly which ones were exercised on Linux and in which environment.

## Crates

| Crate | Content | Tested how |
|---|---|---|
| `crates/proto` (`rw-proto`) | Strict bounded JSON, the length-prefixed frame codec (frameCodec.mjs format and bounds), the gate protocol (commit byte 0x43), view limits, the frozen `mount_view` / `unmount_view` / `view_root_lease` frames and replies, the keeper's root-lease model | Host unit tests plus golden vectors recorded from the frozen Node modules (`tests/vectors/node-golden.json`) |
| `crates/fsview` (`rw-fsview`) | File-server policy core: protected-name fold and predicate, operation policy, descriptor ledger, D2 marker, FUSE settings checker, view engine over an injected backing | Shared S5 vectors (byte copies), every code point and a 300 000-string corpus against Node's fold, engine scenarios with an in-memory backing, D2/settings against Node |
| `crates/confine` (`rw-confine`) | Seccomp BPF programs (file server; orchestration and workload domains) with a host interpreter; Linux capability, no_new_privs, rlimit, parent-death and subreaper helpers | BPF through the interpreter on the host; Linux helpers type-checked |
| `crates/keeper` (`rw-keeper`, binary `keeper`) | v1 argv, /proc and mountinfo parsers, the v1 dispatcher (pure core behind `KeeperOs`), the portable fd-3 channel writer, the Linux OS layer and event loop, and the first-G1 process-bearing construction (pidfd anchor, single unchanged Bubblewrap, private stage channel, positive exec observation) | Pure core and the channel's no-ancillary property host-tested; Linux kernel unit tests in the musl container; runtime behaviour per candidate evidence |
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

## First-G1 process-bearing construction (Linux)

Endpoint and process-tree (endpoint, orchestration and workload roles) creation is implemented behind the core's pending create/commit contract (`linux::launcher`). PTY allocation and terminal domains still refuse `setup_failed` (S2 sub-checkpoint). Public frames, limits and golden vectors are unchanged.

| Step | Mechanism |
|---|---|
| Image policy | `image_policy` document embedded at build time only with the `apparatus-policy` feature (`RW_KEEPER_APPARATUS_POLICY_FILE`). A default build has none and refuses every process-bearing create. At startup every pinned file is opened without following symlinks, required to be regular, SHA-256 checked and identity-recorded (`linux::policy`). The keeper's own entry is `"sha256": "self"`: it must be the running `/proc/self/exe` |
| Startup custody | `main` hands HOME, keeper fd 4, fds 5-7 and a keeper-created provider socketpair to the launcher once (`StartupCustody`); each goes to exactly one domain and the keeper's copy closes after the hand-off |
| Anchor | `clone3(CLONE_PIDFD | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWNS [| CLONE_NEWNET])` as the keeper's direct child (legacy `clone` with `CLONE_PIDFD` when a container seccomp profile answers ENOSYS). It arms `PR_SET_PDEATHSIG(SIGKILL)`, checks the keeper through an inherited pidfd, joins the committed netns or brings `lo` up, mounts a fresh `/proc`, keeps exactly the planned descriptors and execs the unchanged `/usr/bin/bwrap` with an empty environment (`linux::domain`) |
| View | One Bubblewrap invocation without `--unshare-pid`; every view source is a held descriptor (`--ro-bind-fd`/`--bind-fd`), robot identity `1000 <keeper uid> 1`, `--cap-drop ALL`, `--disable-userns` (`bwrap`) |
| Stage | Keeper `stage` mode: closes everything but its declared descriptors, installs endpoint/orchestration channels, applies `--nofile`, sets no_new_privs, requires empty capability sets, installs the domain seccomp filter, then sends READY on the private SOCK_SEQPACKET channel (`linux::stage_exec`) |
| READY binding | Sender from SCM_CREDENTIALS only; direct child of the anchor in its PID namespace, marker in argv, stage image identity, anchor runs the pinned Bubblewrap; pidfd and `/proc/<pid>` held before `create` is answered with the anchor identity |
| Commit | Workload streams connect through `O_PATH|O_NOFOLLOW` pins in the keeper-held endpoint stream directory (`connect` to `/proc/self/fd/N`), travel once in `INSTALL_STDIO`, then the gate byte is written |
| Observation | `executed` only after the bound child's `exe` (read relative to the held proc directory, identity before and after) is the pinned intended image; otherwise `exec_failed`, with committed ownership and the one owed exit after the reply |
| Stop and teardown | SIGTERM through the pidfds of the anchor and of the bound child (a namespace init ignores an ancestor's SIGTERM without a handler), SIGKILL of the anchor at the earliest deadline; end steps and shutdown kill through pidfds; anchors are reaped only through their pidfds, other children after a `WNOWAIT` peek |

The keeper must run where it holds CAP_SYS_ADMIN and CAP_NET_ADMIN in its own user namespace (Ploinky's `nestedPodman` profile); an unprivileged host user cannot create the anchor's namespaces.

| Area | Status |
|---|---|
| Schema, limits, dispatcher, in-flight and per-pty input windows, events, keeper gate, startup checks | Implemented; dispatcher host-tested with a fake OS |
| Linux `KeeperOs`: runtime directory, network namespace by descriptor, tempdir, end steps, views (mount, lease, teardown) | Implemented; runtime directory, network namespace (with `lo` up) and end steps exercised by the first-G1 vehicle, views not yet run on Linux |
| Linux `KeeperOs`: endpoint and process-tree domains | Implemented (first-G1); runtime evidence per candidate, qualifying G1 records pending |
| Linux `KeeperOs`: PTY allocation, terminal domains | NOT implemented: `create` fails closed with `setup_failed` (S2) |

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
