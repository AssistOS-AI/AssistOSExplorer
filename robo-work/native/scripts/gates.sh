#!/usr/bin/env bash
# Runs every native gate and writes logs. Usage: bash scripts/gates.sh <task-root> <evidence-dir>
#   <task-root>     the accepted task-local toolchain root (holds rustup/, vendor/, native-r9/env.sh)
#   <evidence-dir>  where logs go (created; must not exist yet)
# Exit status is non-zero if any gate fails. Every gate is written so that it can fail (see the negative controls).
# NOTE: bash ignores errexit inside a function called from an `if` condition, so EVERY check below ends in an explicit
# `|| return 1` (or is the function's last command). GATES_NEGATIVE_CONTROL=<gate id> makes that gate's input wrong on
# purpose, to show the gate fails.
set -euo pipefail

TASK_ROOT=${1:?task root}
EVIDENCE=${2:?evidence dir}
NATIVE=$(cd "$(dirname "$0")/.." && pwd)
ROBO_WORK=$(cd "$NATIVE/.." && pwd)
EXPLORER=$(cd "$ROBO_WORK/.." && pwd)
PLAN_EVIDENCE=/Users/danielsava/.codex/plans/robo-work-2026-10-27/evidence-r9
# Frozen Node revisions the native code ports from (update when a newer one is frozen).
S4_MANIFEST=s4-candidate-r10.1
S5_MANIFEST=s5-candidate-r7
# The S4 revision that publishes keeper-wire.v1.json (contract section 7, R1.5 M-4).
S4_VECTORS_MANIFEST=s4-candidate-r10.1
NODE=/opt/homebrew/bin/node
mkdir "$EVIDENCE"
# Build outputs of this run live in a fresh directory named after the evidence directory; nothing is ever deleted
# (review N4: earlier runs' artifacts stay where their handoffs cite them).
# Keyed on the full evidence path (a basename alone collided across runs, e.g. two control-G07 directories).
EVIDENCE=$(cd "$(dirname "$EVIDENCE")" && pwd)/$(basename "$EVIDENCE")
RUN_ROOT="$TASK_ROOT/native-r9/runs/$(printf '%s' "$EVIDENCE" | shasum -a 256 | cut -c1-12)-$(basename "$EVIDENCE")"
mkdir -p "$TASK_ROOT/native-r9/runs"
mkdir "$RUN_ROOT"
# shellcheck disable=SC1091
source "$TASK_ROOT/native-r9/env.sh"
cd "$NATIVE"

status=0
gate() { # gate <id> <description> <command...>
    local id=$1 description=$2
    shift 2
    # GATES_ONLY="G03 G04" runs only the named gates (used for the negative-control runs).
    if [ -n "${GATES_ONLY:-}" ] && ! printf ' %s ' "$GATES_ONLY" | grep -q " $id "; then return 0; fi
    # Each gate runs in a subshell from the native tree, so a gate that changes directory cannot affect the next one.
    if (cd "$NATIVE" && "$@") > "$EVIDENCE/$id.log" 2>&1; then
        printf '%s PASS %s\n' "$id" "$description" | tee -a "$EVIDENCE/summary.txt"
    else
        printf '%s FAIL %s (see %s.log)\n' "$id" "$description" "$id" | tee -a "$EVIDENCE/summary.txt"
        status=1
    fi
}

identity() {
    rustc --version --verbose
    cargo --version
    if [ -x "$NODE" ]; then printf 'node %s (%s)\n' "$("$NODE" --version)" "$NODE"; else echo "node: not found at $NODE"; fi
    shasum -a 256 "$TASK_ROOT/native-r9/cargo-home/config.toml" Cargo.lock
}
gate G00 "toolchain identity" identity

host_tests() {
    local out
    out=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline 2>&1) || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out"
    if printf '%s\n' "$out" | grep -E 'FAILED|panicked|^warning' > /dev/null; then return 1; fi
    printf '%s\n' "$out" | awk '/^test result:/ { split($4, a, "."); passed += a[1]; failed += $6; ignored += $8 } END { print "TOTAL passed=" passed " failed=" failed " ignored=" ignored; exit (failed != 0 || ignored != 0 || passed < 136) }'
}
gate G01 "host cargo test (pure logic)" host_tests

musl_tests() {
    local out
    out=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --no-run --target x86_64-unknown-linux-musl --locked --offline 2>&1) || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out"
    if printf '%s\n' "$out" | grep -E '^(warning|error)' > /dev/null; then return 1; fi
}
gate G02 "Linux (musl) type-check of every test target" musl_tests

no_mount_helper() {
    local hits roots=crates
    if [ "${GATES_NEGATIVE_CONTROL:-}" = G03 ]; then roots="crates $TASK_ROOT/vendor/fuser/src/lib.rs"; fi
    # Review R5: also an imported `mount` (`use fuser::{..., mount, ...}`).
    hits=$(grep -rnE 'fuser::mount|fuser::\{[^}]*\bmount\b|spawn_mount|Session::new\(|MountOption|fusermount|detect_fusermount|fuse_pure|AutoUnmount' $roots --include='*.rs' | grep -v 'crates/file-server/tests/no_mount_helper.rs' | grep -vE '^\S+:[0-9]+:\s*//' || true)
    if [ -n "$hits" ]; then printf 'forbidden mount API use:\n%s\n' "$hits"; return 1; fi
    local calls
    calls=$(grep -rn 'Session::from_fd(' crates --include='*.rs' | grep -vE '^\S+:[0-9]+:\s*//' | grep -v tests/ || true)
    printf 'from_fd call sites:\n%s\n' "$calls"
    [ "$(printf '%s\n' "$calls" | grep -c .)" -eq 1 ] || return 1
    # The vendored fuser mount helper exists (it is linked) but nothing here reaches it; record where it lives.
    grep -n 'fn detect_fusermount_bin\|fusermount3' "$TASK_ROOT/vendor/fuser/src/mnt/fuse_pure.rs" | head -5
    # The INIT defaults the settings pin (settings::INIT_CAPABILITIES) are the vendored ones.
    grep -n 'const INIT_FLAGS: InitFlags = InitFlags::FUSE_ASYNC_READ.union(InitFlags::FUSE_BIG_WRITES);' "$TASK_ROOT/vendor/fuser/src/lib.rs" || return 1
    grep -n 'flags |= InitFlags::FUSE_MAX_PAGES;' "$TASK_ROOT/vendor/fuser/src/lib.rs" || return 1
}
gate G03 "no fuser mount function or helper; one Session::from_fd; INIT defaults pinned" no_mount_helper

vectors_identity() {
    local manifest="$PLAN_EVIDENCE/$S5_MANIFEST.manifest.sha256"
    for name in operation-policy.json protected-names.json; do
        local want got
        want=$(grep "robo-work/tests/views/vectors/$name" "$manifest" | cut -d' ' -f1)
        got=$(shasum -a 256 "crates/fsview/tests/vectors/$name" | cut -d' ' -f1)
        if [ "${GATES_NEGATIVE_CONTROL:-}" = G04 ]; then got=0000; fi
        printf '%s want=%s got=%s\n' "$name" "$want" "$got"
        { [ -n "$want" ] && [ "$want" = "$got" ]; } || return 1
    done
}
gate G04 "shared S5 vectors are the frozen S5 bytes ($S5_MANIFEST)" vectors_identity

lock_set() {
    local rb="$TASK_ROOT/src/p3-frozen/Cargo.lock"
    extract() { awk '/^\[\[package\]\]/{if(n)print n"|"v"|"c; n=v=c=""} /^name = /{n=$3} /^version = /{v=$3} /^checksum = /{c=$3} END{print n"|"v"|"c}' "$1" | grep -v '|$' | sort; }
    local mine=Cargo.lock
    if [ "${GATES_NEGATIVE_CONTROL:-}" = G05 ]; then mine="$TASK_ROOT/src/p1/Cargo.lock"; fi
    diff <(extract "$rb") <(extract "$mine") || return 1
    echo "third-party packages identical to the R-B lock: $(extract Cargo.lock | wc -l)"
}
gate G05 "third-party lock set (names, versions, checksums) identical to R-B" lock_set

release_build() { # release_build <target-dir>
    local dir=$1
    # A fresh directory every run; an existing one is refused, never deleted (review N4).
    [ ! -e "$dir" ] || { echo "refusing existing target dir $dir"; return 1; }
    CARGO_TARGET_DIR=$dir cargo build --release --target x86_64-unknown-linux-musl --locked --offline -p rw-keeper -p rw-file-server || return 1
    shasum -a 256 "$dir/x86_64-unknown-linux-musl/release/keeper" "$dir/x86_64-unknown-linux-musl/release/rw-file-server"
}
gate G06a "clean static release build A" release_build "$RUN_ROOT/release-a"
gate G06b "clean static release build B" release_build "$RUN_ROOT/release-b"
compare_builds() {
    for binary in keeper rw-file-server; do
        local a b
        a=$(shasum -a 256 "$RUN_ROOT/release-a/x86_64-unknown-linux-musl/release/$binary" | cut -d' ' -f1)
        b=$(shasum -a 256 "$RUN_ROOT/release-b/x86_64-unknown-linux-musl/release/$binary" | cut -d' ' -f1)
        printf '%s A=%s B=%s %s\n' "$binary" "$a" "$b" "$([ "$a" = "$b" ] && echo identical || echo DIFFERENT)"
        [ "$a" = "$b" ] || return 1
    done
}
gate G06c "two clean builds byte-identical (same paths, same host)" compare_builds

elf() {
    cargo build --release --locked --offline -p elfcheck --target-dir "$RUN_ROOT/target-tools" || return 1
    local check="$RUN_ROOT/target-tools/release/elfcheck"
    local out="$RUN_ROOT/release-a/x86_64-unknown-linux-musl/release"
    # G07 inspects G06a's output (review F-3): say so instead of failing on a missing file.
    [ -f "$out/keeper" ] && [ -f "$out/rw-file-server" ] || { echo "DEPENDENCY: release-a is missing; run G06a in the same run"; return 1; }
    "$check" "$out/keeper" --sym rw_keeper || return 1
    # Symbol counts are informative only: in the release profile Session::from_fd may be inlined into main.
    "$check" "$out/rw-file-server" --sym from_fd --sym handshake --sym rw_file_server || return 1
    # Review R5: fuser's mount-creation paths are not in the binary at all (linker-stripped); only the never-used
    # umount-on-drop path of an Option<Mount> that from_fd leaves None remains.
    local symbols
    symbols=$("$check" "$out/rw-file-server" --sym fuse_mount_pure --sym fuse_mount_fusermount --sym fuse_mount_sys --sym receive_fusermount_message --sym 5Mount3new --sym spawn_mount --sym 5fuser5mount)
    printf '%s\n' "$symbols" | grep 'SYM\['
    if [ "${GATES_NEGATIVE_CONTROL:-}" = G07 ]; then symbols="$symbols
SYM[fuse_mount_pure] matches=1"; fi
    if printf '%s\n' "$symbols" | grep 'SYM\[' | grep -v 'matches=0$' > /dev/null; then echo "mount-creation code is linked"; return 1; fi
    file "$out/keeper" "$out/rw-file-server"
    # Negative controls: a Mach-O input exits 2; a copy with a program header patched to PT_INTERP exits 1.
    set +e
    "$check" "$check" > /dev/null; local macho=$?
    local patched="$RUN_ROOT/patched-interp"
    python3 -I - "$out/rw-file-server" "$patched" <<'PY'
import struct, sys
data = bytearray(open(sys.argv[1], 'rb').read())
phoff, = struct.unpack_from('<Q', data, 32); phentsize, phnum = struct.unpack_from('<HH', data, 54)
for index in range(phnum):
    offset = phoff + index * phentsize
    if struct.unpack_from('<I', data, offset)[0] == 0x6474e551:  # PT_GNU_STACK -> PT_INTERP
        struct.pack_into('<I', data, offset, 3)
        break
else:
    sys.exit('no PT_GNU_STACK to patch')
open(sys.argv[2], 'wb').write(data)
PY
    "$check" "$patched" > /dev/null; local interp=$?
    set -e
    printf 'negative controls: macho_exit=%s (want 2) patched_interp_exit=%s (want 1)\n' "$macho" "$interp"
    { [ "$macho" -eq 2 ] && [ "$interp" -eq 1 ]; } || return 1
}
gate G07 "ELF static (no PT_INTERP, no DT_NEEDED) with negative controls" elf

frozen_unchanged() {
    # Only the Node modules the native code ports from are compared, each against its own slice's frozen manifest line
    # (review F-3/R6: other files of those slices may be reopened by other writers), and the Node-derived golden vectors
    # must regenerate byte-identically from the live modules (read-only imports).
    cd "$EXPLORER" || return 1
    local s4="$S4_MANIFEST" s5="$S5_MANIFEST"
    # Negative control: a superseded S5 manifest (its mountFrames.mjs predates S5 r7) must fail on an S5 line.
    if [ "${GATES_NEGATIVE_CONTROL:-}" = G08 ]; then s5=s5-candidate-r5; fi
    local entry module manifest want got failed=0
    for entry in "frameCodec.mjs:server/execution:$s4" "gateProtocol.mjs:server/execution:$s4" \
        "keeperFrames.mjs:server/execution:$s4" "keeperLimits.mjs:server/execution:$s4" "providerSchema.mjs:server/execution:$s4" \
        "mountFrames.mjs:server/views:$s5" "rootLease.mjs:server/views:$s5" "viewLimits.mjs:server/views:$s5" \
        "protectedNames.mjs:server/views:$s5" "operationPolicy.mjs:server/views:$s5" "viewEngine.mjs:server/views:$s5" \
        "fuseSettings.mjs:server/views:$s5" "d2Decision.mjs:server/views:$s5" "descriptorLedger.mjs:server/views:$s5" \
        "operation-policy.json:tests/views/vectors:$s5" "protected-names.json:tests/views/vectors:$s5"; do
        module="${entry%%:*}"; manifest="${entry##*:}"; module="$(printf '%s' "$entry" | cut -d: -f2)/$module"
        want=$(grep "  robo-work/$module\$" "$PLAN_EVIDENCE/$manifest.manifest.sha256" | cut -d' ' -f1)
        got=$(shasum -a 256 "robo-work/$module" | cut -d' ' -f1)
        if [ -n "$want" ] && [ "$want" = "$got" ]; then printf 'OK %s (%s)\n' "$module" "$manifest"; else printf 'DIFFERENT %s vs %s\n' "$module" "$manifest"; failed=1; fi
    done
    [ "$failed" -eq 0 ] || return 1
    [ -x "$NODE" ] || { echo "node not found at $NODE"; return 1; }
    local regen="$RUN_ROOT/regenerated"
    mkdir "$regen" || return 1
    "$NODE" "$NATIVE/scripts/gen-node-vectors.mjs" "$ROBO_WORK" "$regen/node-golden.json" "$regen/node-views.json" || return 1
    cmp "$regen/node-golden.json" "$NATIVE/crates/proto/tests/vectors/node-golden.json" || return 1
    cmp "$regen/node-views.json" "$NATIVE/crates/fsview/tests/vectors/node-views.json" || return 1
    echo "node-golden.json and node-views.json regenerate byte-identically from the live (frozen) Node modules"
}
gate G08 "ported Node modules equal their $S4_MANIFEST / $S5_MANIFEST lines; Node-derived vectors regenerate identically" frozen_unchanged

keeper_vectors_identity() {
    # Contract section 7 and R1.5 M-4: the native copy is byte-identical to the Node file pinned by the S4 r10 manifest.
    local manifest="$PLAN_EVIDENCE/$S4_VECTORS_MANIFEST.manifest.sha256"
    local copy="$NATIVE/crates/proto/tests/vectors/keeper-wire.v1.json"
    [ -f "$manifest" ] || { echo "PENDING: $S4_VECTORS_MANIFEST is not frozen yet (no keeper-wire.v1.json pin)"; return 1; }
    [ -f "$copy" ] || { echo "PENDING: the native copy does not exist yet"; return 1; }
    local want got
    want=$(grep '  robo-work/tests/execution/vectors/keeper-wire.v1.json$' "$manifest" | cut -d' ' -f1)
    got=$(shasum -a 256 "$copy" | cut -d' ' -f1)
    if [ "${GATES_NEGATIVE_CONTROL:-}" = G09 ]; then got=0000; fi
    printf 'want=%s got=%s\n' "$want" "$got"
    { [ -n "$want" ] && [ "$want" = "$got" ]; } || return 1
    local out
    out=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline -p rw-proto --test keeper_wire_vectors 2>&1) || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out" | grep -E '^test |test result'
    printf '%s\n' "$out" | grep -q 'test result: ok\. 11 passed; 0 failed; 0 ignored' || return 1
    out=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline -p rw-keeper --test keeper_wire_vectors_keeper 2>&1) || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out" | grep -E '^test |test result'
    printf '%s\n' "$out" | grep -q 'test result: ok\. 3 passed; 0 failed; 0 ignored' || return 1
}
gate G09 "keeper_vectors_identity: native keeper-wire.v1.json equals the S4 r10 pin; keeper_wire_vectors (11) and keeper-side (3) pass" keeper_vectors_identity

channel_no_ancillary() {
    # AC-16 (R1.4): exactly two tests, both pass, on the host.
    local list run
    list=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline -p rw-keeper --test channel_no_ancillary -- --list 2>/dev/null) || return 1
    printf '%s\n' "$list"
    [ "$(printf '%s\n' "$list" | grep -c ': test$')" -eq 2 ] || return 1
    run=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline -p rw-keeper --test channel_no_ancillary 2>&1) || { printf '%s\n' "$run"; return 1; }
    printf '%s\n' "$run" | grep 'test result'
    printf '%s\n' "$run" | grep -q 'test result: ok. 2 passed; 0 failed; 0 ignored' || return 1
}
gate G10 "channel_no_ancillary: 2 host tests (detector control + writer attaches no control data)" channel_no_ancillary

seccomp_table() {
    # Review I-1: the file server cannot signal or rlimit other processes; fcntl narrowed; the r2 rules are caught.
    local out
    out=$(CARGO_TARGET_DIR="$RUN_ROOT/target" cargo test --locked --offline -p rw-confine -- file_server_cannot_signal_or_rlimit_other_processes fcntl_is_narrowed probe_inputs_are_not_vacuous 2>&1) || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out" | grep -E '^test |test result'
    printf '%s\n' "$out" | grep -q 'test result: ok. 3 passed; 0 failed' || return 1
}
gate G11 "file-server seccomp table: signals, prlimit64 and fcntl (I-1); body mutants in scripts/negative-controls.sh" seccomp_table

echo "overall status: $status" | tee -a "$EVIDENCE/summary.txt"
exit "$status"
