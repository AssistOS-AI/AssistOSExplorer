#!/usr/bin/env bash
# Runs every negative control and checks that each fails FOR ITS OWN REASON (review F-3): the controlled gate must FAIL,
# its log must contain the expected failure text, and every gate it depends on must PASS in the same run.
# Then runs the seccomp body mutants M1-M4 and keeper mutants K1-K30, including the portable launch foundation.
# of the tree: each must turn its named test red
# while the unmutated base passes.
# Usage: bash scripts/negative-controls.sh <task-root> <evidence-dir>   (the evidence dir must not exist yet)
set -euo pipefail

TASK_ROOT=${1:?task root}
EVIDENCE=${2:?evidence dir}
NATIVE=$(cd "$(dirname "$0")/.." && pwd)
mkdir "$EVIDENCE"
SUMMARY="$EVIDENCE/summary.txt"
status=0

# id | gates to run (dependencies first) | expected text in the controlled gate's log
CONTROLS=(
    "G03|G03|forbidden mount API use"
    "G04|G04|got=0000"
    "G05|G05|^[<>] "
    "G07|G06a G07|mount-creation code is linked"
    "G08|G08|DIFFERENT server/views/mountFrames.mjs vs s5-candidate-r5"
)
if [ -f "$NATIVE/crates/proto/tests/vectors/keeper-wire.v1.json" ]; then CONTROLS+=("G09|G09|got=0000"); fi

for control in "${CONTROLS[@]}"; do
    IFS='|' read -r id gates expected <<< "$control"
    out="$EVIDENCE/control-$id"
    GATES_ONLY="$gates" GATES_NEGATIVE_CONTROL="$id" bash "$NATIVE/scripts/gates.sh" "$TASK_ROOT" "$out" > "$EVIDENCE/control-$id.run.log" 2>&1 || true
    verdict=ok
    if [ ! -f "$out/summary.txt" ]; then
        verdict="the gate run aborted before any gate (see control-$id.run.log)"
    elif ! grep -q "^$id FAIL" "$out/summary.txt"; then
        verdict="the gate did not fail"
    fi
    if [ "$verdict" = ok ] && ! grep -Eq -- "$expected" "$out/$id.log"; then verdict="failed for another reason (expected: $expected)"; fi
    for dependency in $gates; do
        [ "$dependency" = "$id" ] && continue
        grep -q "^$dependency PASS" "$out/summary.txt" || verdict="dependency $dependency did not pass"
    done
    if [ "$verdict" = ok ]; then
        printf '%s OK fails for its own reason: %s\n' "$id" "$(grep -Em1 -- "$expected" "$out/$id.log")" | tee -a "$SUMMARY"
    else
        printf '%s BAD %s\n' "$id" "$verdict" | tee -a "$SUMMARY"
        status=1
    fi
done

# Seccomp body mutants (the reviewer's M1, M2b, M3, M4). Each is one edit in a scratch copy of the tree.
EVIDENCE_ABS=$(cd "$EVIDENCE" && pwd)
MUTANT_ROOT="$TASK_ROOT/native-r9/runs/$(printf '%s' "$EVIDENCE_ABS" | shasum -a 256 | cut -c1-12)-mutants"
mkdir -p "$TASK_ROOT/native-r9/runs"
mkdir "$MUTANT_ROOT"
# shellcheck disable=SC1091
source "$TASK_ROOT/native-r9/env.sh"
TESTS="file_server_cannot_signal_or_rlimit_other_processes fcntl_is_narrowed probe_inputs_are_not_vacuous"
run_tests() { (cd "$1" && CARGO_TARGET_DIR="$2" cargo test --locked --offline -p rw-confine -- $TESTS 2>&1) || true; }

base="$MUTANT_ROOT/base"
mkdir "$base"
cp -R "$NATIVE/." "$base"
run_tests "$base" "$MUTANT_ROOT/target" > "$EVIDENCE/mutant-base.txt"
if grep -q 'test result: ok. 3 passed; 0 failed' "$EVIDENCE/mutant-base.txt"; then
    echo "base OK 3 passed" | tee -a "$SUMMARY"
else
    echo "base BAD (the unmutated tree must pass)" | tee -a "$SUMMARY"
    status=1
fi

# name | old text | new text | test that must fail
MUTANTS=(
    "M1|        jump(BPF_JMP_JEQ_K, 0, 0, 8),|        jump(BPF_JMP_JEQ_K, 0, 0, 0),|fcntl_is_narrowed"
    "M2b|        stmt(BPF_LD_W_ABS, offset_arg_low(2)),\n        jump(BPF_JMP_JEQ_K, 0, 0, 2),|        stmt(BPF_LD_W_ABS, offset_arg_low(3)),\n        jump(BPF_JMP_JEQ_K, 0, 0, 2),|file_server_cannot_signal_or_rlimit_other_processes"
    "M3|        jump(BPF_JMP_JSET_K, O_ASYNC, 0, 1),|        jump(BPF_JMP_JSET_K, O_ASYNC, 1, 0),|fcntl_is_narrowed"
    "M4|    nr::GETTID, nr::POLL,|    nr::GETTID, nr::TKILL, nr::POLL,|file_server_cannot_signal_or_rlimit_other_processes"
)
for mutant in "${MUTANTS[@]}"; do
    IFS='|' read -r name old new named <<< "$mutant"
    copy="$MUTANT_ROOT/$name"
    mkdir "$copy"
    cp -R "$NATIVE/." "$copy"
    python3 -I - "$copy/crates/confine/src/seccomp.rs" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2].replace('\\n', '\n'), sys.argv[3].replace('\\n', '\n')
text = open(path).read()
if text.count(old) != 1:
    sys.exit(f'mutation anchor found {text.count(old)} times')
open(path, 'w').write(text.replace(old, new))
PY
    diff -u "$NATIVE/crates/confine/src/seccomp.rs" "$copy/crates/confine/src/seccomp.rs" > "$EVIDENCE/mutant-$name.diff" || true
    [ -s "$EVIDENCE/mutant-$name.diff" ] || { echo "$name BAD empty diff" | tee -a "$SUMMARY"; status=1; continue; }
    run_tests "$copy" "$MUTANT_ROOT/target" > "$EVIDENCE/mutant-$name.txt"
    if grep -q "test seccomp::tests::$named ... FAILED" "$EVIDENCE/mutant-$name.txt"; then
        echo "$name OK $named turns red" | tee -a "$SUMMARY"
    else
        echo "$name BAD $named did not fail" | tee -a "$SUMMARY"
        status=1
    fi
done

# r6 keeper mutants (E-1 to E-4, R2.1, R2.2, R2.6 A5, F-4, F-5, RK-7, RK-8): name ^ file ^ old ^ new ^ test that must fail.
run_keeper() { (cd "$1" && CARGO_TARGET_DIR="$2" cargo test --locked --offline -p rw-keeper --lib 2>&1) || true; }
run_keeper "$base" "$MUTANT_ROOT/target" > "$EVIDENCE/keeper-mutant-base.txt"
if grep -Eq 'test result: ok\. [0-9]+ passed; 0 failed' "$EVIDENCE/keeper-mutant-base.txt"; then
    echo "keeper base OK" | tee -a "$SUMMARY"
else
    echo "keeper base BAD (the unmutated tree must pass)" | tee -a "$SUMMARY"
    status=1
fi
KEEPER_MUTANTS=(
    "K1^crates/keeper/src/core.rs^Executed | State::CommitFailed);^Executed);^a_failure_commit_kills_only_that_stage_by_handle_and_its_exit_follows_the_reply"
    "K2^crates/keeper/src/core.rs^                self.os.kill_stage(&handle);\n^^a_failure_commit_kills_only_that_stage_by_handle_and_its_exit_follows_the_reply"
    "K3^crates/keeper/src/core.rs^ && !self.resources[index].committed => {^ => {^exactly_one_exit_follows_an_ok_commit_and_a_later_commit_is_already_committed"
    "K4^crates/keeper/src/core.rs^                self.outbound.push(stop_bound_reply(waiter.id));\n^^a_stop_on_a_failed_commit_stage_is_answered_at_its_bound_if_the_exit_never_comes"
    "K5^crates/keeper/src/core.rs^                self.resources[index].committed = true;\n                self.fail(id, error_kind, code);^                self.resources[index].committed = false;\n                self.fail(id, error_kind, code);^a_failure_commit_kills_only_that_stage_by_handle_and_its_exit_follows_the_reply"
    "K6^crates/keeper/src/core.rs^                self.outbound.push(stop_bound_reply(waiter.id));\n^                self.outbound.push(stop_bound_reply(waiter.id));\n                resource.stop_waiters.push(StopWaiter { id: waiter.id, deadline: u64::MAX });\n^a_stop_on_an_executed_process_is_answered_stop_timeout_at_the_same_bound"
    "K7^crates/keeper/src/core.rs^                        let _ = self.teardown_view(index, now_ms);\n^^abort_uncommitted_tears_down_an_uncommitted_view_and_refuses_a_committed_one"
    "K8^crates/proto/src/keeper_frames.rs^        if mount && self.mount_in_flight.len() >= self.max_mount_in_flight {^        if false && mount && self.mount_in_flight.len() >= self.max_mount_in_flight {^mount_ops_beyond_max_mount_in_flight_are_a_violation"
    "K9^crates/keeper/src/root_identity.rs^    if held == Some(recorded) && at_path == Some(recorded) {^    if held == Some(recorded) {^a_runtime_root_renamed_or_replaced_after_startup_is_refused"
    "K10^crates/keeper/src/core.rs^runtime_root: Some(&self.runtime_root), cgroup_subtree: self.cgroup_subtree.as_deref(),^runtime_root: None, cgroup_subtree: self.cgroup_subtree.as_deref(),^vector_requests_through_handle_frame_match_the_keeper_verdicts"
    "K11^crates/proto/src/keeper_frames.rs^root.is_none_or(|root| &path[..at] == root)^root.is_none_or(|root| path[..at].starts_with(root))^cgroup_decode_checks_structure_before_undelegated_refusal"
    "K12^crates/proto/src/keeper_frames.rs^if kind == CreateKind::Cgroup && context.cgroup_subtree.is_none() {^if false && kind == CreateKind::Cgroup && context.cgroup_subtree.is_none() {^cgroup_decode_checks_structure_before_undelegated_refusal"
    "K13^crates/proto/src/keeper_frames.rs^pub const MOUNT_OPS: [&str; 2] = [\"mount_view\", \"unmount_view\"];^pub const MOUNT_OPS: [&str; 3] = [\"mount_view\", \"unmount_view\", \"view_root_lease\"];^leases_bypass_mount_slots_but_remain_per_grant_and_channel_bounded"
    "K14^crates/proto/src/keeper_frames.rs^if lease.is_some_and(|grant| self.lease_grants.contains(grant)) {^if false && lease.is_some_and(|grant| self.lease_grants.contains(grant)) {^leases_bypass_mount_slots_but_remain_per_grant_and_channel_bounded"
    "K15^crates/keeper/src/cgroup_subtree.rs^if facts.identity != recorded {^if false && facts.identity != recorded {^startup_facts_require_cgroup2_identity_and_owned_control_files"
    "K16^crates/keeper/src/core.rs^                    _ => self.refuse(id, \"resource_not_committed\"),^                    State::Created => { self.os.stop(&resource, grace_ms); self.refuse(id, \"resource_not_committed\"); }\n                    _ => self.refuse(id, \"resource_not_committed\"),^stop_on_a_created_or_aborted_stage_is_refused_resource_not_committed"
    "K17^crates/proto/src/keeper_frames.rs^if locator.get(\"keeper\").and_then(Value::as_str) != Some(context.keeper_reservation) {^if false && locator.get(\"keeper\").and_then(Value::as_str) != Some(context.keeper_reservation) {^every_locator_is_bound_to_the_keepers_own_reservation"
    "K18^crates/keeper/src/launch.rs^    pub fn status_eof(&mut self, now: u64) {^    pub fn status_eof(&mut self, now: u64) { self.phase = LaunchPhase::Executed;^eof_and_rapid_exec_exit_are_never_positive_observations"
    "K19^crates/keeper/src/launch.rs^observation.before == self.child && observation.after == self.child^observation.before == self.anchor && observation.after == self.anchor^only_the_bound_childs_live_intended_image_can_latch_success"
    "K20^crates/keeper/src/launch.rs^&& observation.executable == Some(self.intended) && observation.executable != Some(self.stage)^&& true^only_the_bound_childs_live_intended_image_can_latch_success"
    "K21^crates/keeper/src/core.rs^self.os.discard_created(operation, created);^let _ = (operation, created);^pending_create_abort_wins_before_and_after_queued_ready"
    "K22^crates/keeper/src/launch.rs^if self.deadline().is_some_and(|deadline| now >= deadline)^if false && self.deadline().is_some_and(|deadline| now >= deadline)^one_deadline_covers_connect_install_release_and_observation"
    "K23^crates/keeper/src/core.rs^        self.resources[index].committed = true;\n        self.resources[index].pending = Some(PendingLaunch^        self.resources[index].committed = false;\n        self.resources[index].pending = Some(PendingLaunch^accepted_pending_commit_rejects_duplicates_and_abort_then_replies_before_exit"
    "K24^crates/keeper/src/launch.rs^if packet.rights.is_empty() => Ok((record, Vec::new()))^if true => Ok((record, Vec::new()))^rejected_ancillary_packets_close_every_owned_right"
    "K25^crates/keeper/src/core.rs^let result = result.and_then(|latch| {\n                            if latch.within(pending.accepted_at, pending.deadline, now_ms)^let result = result.and_then(|latch| {\n                            if now_ms < pending.deadline^review_latched_exec_survives_bounded_completion_drain_delay"
    "K26^crates/keeper/src/core.rs^if let Some(latch) = self.os.take_commit_latch(&pending.operation) {^if let Some(latch) = None::<CommitLatch> {^review_latched_exec_survives_bounded_completion_drain_delay"
    "K27^crates/keeper/src/core.rs^if !self.created_already_published(&operation)^if true^review_duplicate_created_does_not_destroy_the_live_operation"
    "K28^crates/keeper/src/core.rs^Err(_) => self.cancel_pending(index),^Err(error) => self.finish_create(index, Err(error)),^review_pending_create_refusal_is_setup_failure"
    "K29^crates/keeper/src/launch.rs^ && self.observed_at_ms < deadline^^late_or_future_commit_proof_fails_and_cancelled_operations_never_resurrect"
    "K30^crates/keeper/src/core.rs^self.resources[index].create_request == operation.request_id\n            && !matches!^!matches!^stale_and_cancelled_create_cleanup_never_aliases_a_live_operation"
)
for mutant in "${KEEPER_MUTANTS[@]}"; do
    IFS='^' read -r name file old new named <<< "$mutant"
    copy="$MUTANT_ROOT/$name"
    mkdir "$copy"
    cp -R "$NATIVE/." "$copy"
    python3 -I - "$copy/$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2].replace('\\n', '\n'), sys.argv[3].replace('\\n', '\n')
text = open(path).read()
if text.count(old) != 1:
    sys.exit(f'mutation anchor found {text.count(old)} times')
open(path, 'w').write(text.replace(old, new))
PY
    diff -u "$NATIVE/$file" "$copy/$file" > "$EVIDENCE/mutant-$name.diff" || true
    [ -s "$EVIDENCE/mutant-$name.diff" ] || { echo "$name BAD empty diff" | tee -a "$SUMMARY"; status=1; continue; }
    run_keeper "$copy" "$MUTANT_ROOT/target" > "$EVIDENCE/mutant-$name.txt"
    if grep -Eq "^test [a-z_:]*::$named \.\.\. FAILED" "$EVIDENCE/mutant-$name.txt"; then
        echo "$name OK $named turns red" | tee -a "$SUMMARY"
    else
        echo "$name BAD $named did not fail" | tee -a "$SUMMARY"
        status=1
    fi
done

echo "overall status: $status" | tee -a "$SUMMARY"
exit "$status"
