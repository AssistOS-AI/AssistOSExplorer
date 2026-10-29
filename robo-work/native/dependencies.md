# Native dependency exception (RoboWork keeper and file server)

The plan (section 5.4, Revision 8; R21) selects a separate Rust file-server binary using exactly `fuser = 0.18.0`, built into the immutable worker image with a committed lock and recorded integrity, and a small Rust keeper (section 5.5). Node has no FUSE interface without a native component. This file records that exception for the native tree. The AssistOSExplorer DS001 entry and the image `dependencies.md` entry are handed to the coordinator for integration (this tree does not edit shared specifications).

## Direct dependencies

| Crate | Pin | Used by | Why |
|---|---|---|---|
| `fuser` | `=0.18.0`, `default-features = false`, Linux only | `rw-file-server` | FUSE protocol. Only `Session::from_fd` on the keeper-provided `/dev/fuse` descriptor is used. No mount function, no `fusermount`, no libfuse (the default-free build selects fuser's pure-Rust mount code, which is linked but unreachable: a source gate forbids every mount API and the file server's seccomp filter kills the process on `execve`) |
| `libc` | `=0.2.191`, `default-features = false`; Linux only in `rw-confine` and `rw-file-server`, on every target in `rw-keeper` (r3, N-E: the portable channel writer and its host test) | `rw-confine`, `rw-keeper`, `rw-file-server` | System calls (namespaces, mount, prctl, seccomp, `*at` calls). Already in fuser's graph; the x86_64 syscall numbers written out in `rw-confine` are checked against it at compile time |

No other crate is a direct dependency. JSON, the frame codec, the protected-name fold (NFKC and default-ignorable tables generated from Node's ICU, Unicode 17.0), seccomp BPF and ELF checking are implemented in this tree.

## Integrity

| Item | Value |
|---|---|
| Source | R-B task-local vendor directory (coordinator approval 1ca364d8, accepted 0527fc92); crates.io checksums verified by cargo against each crate's `.cargo-checksum.json` on every build |
| fuser crates.io checksum | `b82b6597d216503555ead6b358f341ef748869bf5c6fbae6a0cb9dd231baecfd` |
| Third-party lock set | Identical to the R-B proof lock (same 44 third-party packages, versions and checksums); `scripts/gates.sh` diffs it |
| Builds | `--locked --offline`, source replacement to the vendor directory only (`cargo-config.template.toml`) |

## Licences of the crates linked into the musl binaries

From each vendored crate's `Cargo.toml` (`cargo tree --target x86_64-unknown-linux-musl -e normal`). Proc-macro and build-time crates run on the build host only. No copyleft licence. The R-B proof's full table (all 44 vendored crates) is `evidence-r9/rb-toolchain-proof-20261028T194021Z/proof4-licenses/license-table.md`.

Linked into the binaries:

| Licence | Crates |
|---|---|
| MIT | fuser, memoffset, nix |
| MIT OR Apache-2.0 (any spelling) | bitflags, cfg-if, libc, lock_api, log, page_size, parking_lot, parking_lot_core, ref-cast, scopeguard, smallvec |

Build-time only (proc-macro graph, run on the build host; review N1: earlier listed as linked):

| Licence | Crates |
|---|---|
| MIT | winnow |
| MIT OR Apache-2.0 (any spelling) | equivalent, hashbrown, indexmap, toml_datetime, toml_edit, toml_parser, proc-macro-crate, proc-macro2, quote, ref-cast-impl, rustversion, syn |
| Unlicense OR MIT (linked) | memchr |
| BSD-3-Clause OR MIT OR Apache-2.0 | num_enum (linked), num_enum_derive (build-time) |
| BSD-2-Clause OR Apache-2.0 OR MIT | zerocopy (linked), zerocopy-derive (build-time) |
| (MIT OR Apache-2.0) AND Unicode-3.0 | unicode-ident (build-time) |

The fold tables in `crates/fsview/src/unicode_tables.rs` are derived from Unicode Character Database data through ICU (Unicode License v3).
