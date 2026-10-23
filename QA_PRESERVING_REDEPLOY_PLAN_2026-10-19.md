# SPEC: Explorer QA preserving redeploy

Status: plan only. Nothing here is implemented, dispatched or verified. The base is AssistOSExplorer `main` at `f8c930d66b84b839de1c6a28717aa6e1065e540c`. QA runs AchillesIDE `fa8d9c2510d9fd8779671f7f35ca9bd9ffabafa4` with Ploinky `7d8c04d0`. Both are Observed in the log of run 38403649166, which prints `Selected AchillesIDE/main at fa8d9c25…` and `Ploinky runtime: 7d8c04d0 (master)`.

## Intent

QA has to move from the 16-agent pre-split graph to the 12-agent graph at `main`. The durable state of every remaining agent must survive, rollback must stay available, and the operator has no SSH.

The in-place updater refuses this commit range by design (`update-explorer-qa.mjs:89-97,215`). The guarded Reconcile path already does the work this needs. It moves the workspace into a protected backup, copies durable state back byte for byte, regenerates the registry, and keeps the old Box stopped (`deploy-explorer-qa.yml:1375-1493`). Since `e1eeceb5`, an existing workspace can no longer reach that path.

This change reopens the path behind an explicit, confirmed operator choice. It also filters prior selections against the fresh graph, makes rollback dispatchable, and keeps later in-place updates working while the rollback Box is retained. The trade-off rule: a failed redeploy is acceptable, lost data is not. Every new branch either fails closed before services stop or leaves a backup that can be rolled back.

## Decisions (taken autonomously; user AFK)

| ID | Decision | Rationale / evidence |
| --- | --- | --- |
| D1 | Add a `choice` input `operation` with `update` (default), `redeploy-rehearsal`, `redeploy`, `rollback-plan` and `rollback-execute`. Add string inputs `expected_explorer_commit`, `rollback_backup`, `rollback_current_id` and `confirm`. | The modes are exclusive. A dispatch without inputs still means `update`, so the in-place path stays the default. |
| D2 | Rollback becomes a second job in `deploy-explorer-qa.yml` with a `<<'ROLLBACK'` heredoc, not a new workflow file. | GitHub only dispatches workflows that exist on the default branch (Inferred from its docs, not verified). This keeps the single `<<'REMOTE'` (`deploy-workflow-contract.test.mjs:196-197`). |
| D3 | Dispatch from branch `qa-preserving-redeploy` without merging. | Observed: no `github.ref` use, no `environment:` (`:27-33`), and every deployed source is resolved from its remote HEAD (`:1252-1273,1577-1599`). `--ref` changes only the helpers and the workflow; the deployed source stays `main`. The first dispatch is a read-only rehearsal that proves the branch's inputs are accepted. |
| D4 | `redeploy` requires all of the following, and fails closed otherwise: `confirm=redeploy explorerQaWorkspace`; `expected_explorer_commit` equal to `main` from `git ls-remote`, checked on the runner before SSH and again after source resolution; an existing real workspace directory; exactly one Box with the exact name. | Pins the exact candidate and rules out an accidental first install, which would leave no rollback. |
| D5 | Deploy never re-enables a selection that is missing from the fresh default graph, and it logs one disposition line per prior selection. Graph agents take the fresh policy: userPersisto's profile change `default -> explorer` is logged instead of raising `QA_SELECTION_POLICY_CHANGED`. `ready()` is called with `agents: []`. | `verify-explorer-qa-runtime.mjs:58` requires exactly 12 records. `ready()` still requires every state to be running and the publication to be `ready` (`rollback-explorer-qa.mjs:763-765`). `restorePriorSelections` and `ready` stay unchanged because rollback uses the full old list (`:515,741`). |
| D6 | Principal re-keying is a documented post-step, not automated. | Soul Gateway auto-creates subject rows on the first signed call (`soul-gateway/src/runtime/security/api-key-auth.mjs:93-99`, spot-checked), and its provider and settings rows carry no principal. MCP policy is keyed by route (`ploinky/cli/server/policy/McpToolPolicy.js:67-69`). RoboTeam stores no principal (delegated finding). DPU backfills its defaults (`dpuAgent/lib/dpu-store-internal/storage.mjs:375-381`). Only customized limits and grants are left behind under the old, now inert, keys. |
| D7 | Redeploy regenerates `.ploinky/{enabled_repos,repo_sources,unregistered_agent_repos}.json`. The backup keeps the old copies for rollback. | Delegated finding: a stale unregistered name makes resolution throw (`ploinky/cli/utils/agentRepositorySource.mjs:32-37`), and a stale source entry pins a clone branch (`bootstrapManifest.js:222-245`). Stale `.ploinky/code` and `skills` links are harmless, because enable replaces symlinks (Observed, `ploinky/cli/utils/workspaceStructure.js:56-66`). |
| D8 | Export `currentQaBox()` and use it in the updater and the verifier. It accepts one running exact-name Box plus only stopped `${box}-(rollback\|failed)-redeploy-[A-Za-z0-9]{8}` Boxes. | `boxes()` lists every container with the path-hash label (`rollback-explorer-qa.mjs:653-654`). The retained Box therefore breaks `update-explorer-qa.mjs:176` and `verify-explorer-qa-runtime.mjs:27`. Capture already tolerates such Boxes (`rollback-explorer-qa.mjs:360-361`). This fix reaches `main` only when merged. Until then, every `update` dispatch must use `--ref qa-preserving-redeploy`, because `main` will fail closed with `QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED`. |
| D9 | Check the account-capability digests at `7d8c04d0`. If they differ, admit a second reviewed set; never replace the first. | The digests were pinned once, in `dbc016af` (2026-09-10). Ploinky `db346be0` (2026-10-03) then changed a pinned file before `7d8c04d0`. A mismatch aborts capture before the stop (`deploy-explorer-qa.yml:1384-1391`). The gate exists because some runtimes overwrite saved accounts (`docs/deploy-skills-explorer.md:97`). |
| D10 | Raise `timeout-minutes` from 50 to 90 (`:30`). | Quiesce takes up to about 15 minutes, start plus readiness took 10 minutes on 2026-10-13, and readiness may take up to 30. A runner timeout would drop SSH mid-copy. |
| D11 | Add three log lines: `[deploy-qa] Redeploy backup: <name>` right after `mktemp`; `[deploy-qa] Rollback reference: backup=<name> predecessor=<64hex> current=<64hex>` once the fresh Box exists; `[deploy-qa] Verification expectation: <json>` in the verifier's shape (`verify-explorer-qa-runtime.mjs:11-17`). | Without SSH, the log is the only source of the rollback and verifier inputs. The helper refuses guessed IDs (`rollback-explorer-qa.mjs:393,418-424`). |
| D12 | The rehearsal runs a read-only `previewCapture()`, which applies capture's proofs without `writeNew`. | It surfaces `QA_AGENT_SELECTION_UNSUPPORTED`, `QA_UNSELECTED_ACTIVE_BOX`, `QA_SOURCES_INCOMPLETE` and mounted-source failures before the real run. It also prints the actual prior selections, which confirm T6. |

### Answering the reasons `e1eeceb5` closed the path

| `e1eeceb5` invariant | Answer |
| --- | --- |
| "Deployment never retires an installation"; teardown belongs to destroy (`:731-732`) | Retirement happens only on `operation=redeploy` with the confirm string, and nothing is deleted. The old workspace and Box stay in the backup. |
| No fall-through from a failed update into install (`docs/deploy-skills-explorer.md:36-37`) | Redeploy is selected before the updater runs (exit 43). Updater failures keep their existing mapping, and a test proves that exits 19 and 75 never yield `updated=false`. |
| No large backup and no 25 GiB requirement for an update (`:25-27,85-86`) | That cost is paid only on opt-in, and capacity admission stays mandatory (`:1083-1165`). |
| Fresh install requires proven absence | Unchanged for `update`. Redeploy instead requires proven presence. |

## Out of scope

| Excluded | Note |
| --- | --- |
| Automatic principal re-keying | Handled as a post-step (D6) |
| Removing retained Boxes or backups | Separate operation |
| Replaying optional agents | Re-enable them in Marketplace |
| The `ploinky-proxy` gate | Not this branch |
| `check-no-wait-readiness.mjs` | `main`'s copy runs (`:2101`) |
| Merging to `main` | Needs the user's approval; see the conditional blockers |

## Files

| Path:lines | Change |
| --- | --- |
| new `tests/smoke/lib/deploy-qa-redeploy-workflow.test.mjs` | Inputs, routing, rehearsal exit, rollback job and the D11 lines. |
| `.github/workflows/deploy-explorer-qa.yml:3-4,30,49-80` | D1 inputs; `jobs.deploy.if` excludes `rollback-*`; D10; validate inputs for each operation; runner-side `ls-remote` check. |
| `:313-375` | Pass `$OPERATION` as `$2`. In redeploy modes, before the absence block: if the workspace is a real directory, print `[deploy-qa] Preserving redeploy selected (<op>); the in-place updater was not run.` and exit 43; if absent, exit 1 with `redeploy requires an existing QA workspace`. Exit 43 sets `updated=false` and `operation=<op>`. |
| `:377-385,456-480,627-673` | Pass the operation to Reconcile as env and as the remote `$2`. Redeploy modes refuse to POST a new tunnel. |
| `:730-749` | `assert_qa_install_admission`. `update` keeps today's absence logic verbatim. Redeploy requires a directory, no symlink and exactly one exact-name Box, then prints `[deploy-qa] Preserving redeploy admitted: one existing workspace and exact Box.` Called at `:748` and `:1374`. |
| after `:1249` | Rehearsal only. Run `accountCapability` and `previewCapture` through the transferred helper, then print `[deploy-qa] Rehearsal: prior account runtime reviewed=<bool>` (fail if false) and one line per prior selection. Finish with `[deploy-qa] Redeploy rehearsal passed; no service was stopped and no workspace file was moved.` and `exit 0`. |
| `:1277,1468-1469,1598,1786-1800` | D11 backup and reference lines; D7 regenerated names; fail if the resolved AchillesIDE commit differs from `expected_explorer_commit`. |
| `:2169-2212` | Replace replay with `classifyPriorSelections`, logging and `ready(current, {...authority, agents: []})`. Keep the final success line verbatim. |
| `:2253-2270,2306,2394,2493-2520` | Emit `Verification expectation`; skip the public and topology steps for the rehearsal; add summary lines. |
| end of file | New `rollback` job. Validate `rollback_backup` against `^redeploy-[A-Za-z0-9]{8}$` and `rollback_current_id` against `^([a-f0-9]{64}\|absent)$`; execute also requires `confirm == rollback_backup`. Pin the host key as `verify-explorer-qa-runtime.yml:31-35` does. Read Node from `BACKUP/helpers/node-runtime-path` and require it to match `^/home/admin/\.qa-deployment-tools/node-v24\.19\.0-linux-(x64\|arm64)$`. Run the backup's own helper. `plan` runs under `flock -n -E 75 --close`; `execute` takes no outer lock, because the helper locks itself (`rollback-explorer-qa.mjs:792-798`). Timeout 60 minutes. |
| `.github/scripts/rollback-explorer-qa.mjs:39-62` | D9, only if digests differ: `ACCOUNT_CAPABILITY_SETS`, where any one complete set matches. |
| `rollback-explorer-qa.mjs:74-98,353-389,642-658` | Export `classifyPriorSelections`, `previewCapture` (the shared proof code is factored out of `capture`) and `currentQaBox`. |
| `update-explorer-qa.mjs:175-177`; `verify-explorer-qa-runtime.mjs:26-29,75-79` | Use `currentQaBox`. |
| `tests/smoke/lib/deploy-qa-in-place-workflow.test.mjs:12-21` | Replace the no-inputs assertion. |
| `deploy-qa-auto-selection`, `deploy-qa-preservation`, `qa-rollback` and `qa-in-place-update` tests | Cases T2–T14 and T17. |
| `docs/specs/DS002-ploinky-runtime.md:92`; `docs/deploy-skills-explorer.md:18-27,82-97,101,275-289`; `docs/architecture.html:71` | Describe the opt-in redeploy, rehearsal and rollback. Fix the stale "13 with 7" to 12/6 (`:101` vs `:2082,2120`). Turn `:286-289` into the post-step checklist. |

## Interfaces / contracts

| Item | Contract |
| --- | --- |
| `classifyPriorSelections(selections, registry)` | Pure, keyed on `(repoName, agentName, alias)`. Returns `{dispositions:[{ref, kind:'retained'\|'superseded'\|'renamed'\|'absent', replacement?, changes?}], counts}`. `renamed` means the same agent name and alias under another repository. It never enables anything, and it throws `QA_SELECTION_INVALID` on the same inputs `restorePriorSelections` rejects. |
| Log lines | `[deploy-qa] Prior selection retained: R/A`; `… policy superseded: R/A profile X -> Y` (auth and runMode likewise); `… not replayed: R/A (renamed to R2/A; fresh graph policy applies)`; `… not replayed: R/A (not in the fresh default graph; re-enable through Marketplace if still required)`; `[deploy-qa] Prior selections: N total, K retained, S superseded, M not replayed, 0 enabled.` |
| `currentQaBox(boxes, scope)` | Returns the single running exact-name Box, or throws `QA_EXACT_RUNNING_BOX_REQUIRED`. |
| `previewCapture(scope)` | Same proofs and error codes as `capture`. It writes nothing and returns `{rollbackSupported, agents, sources}`. |
| Inputs | In redeploy modes, `expected_explorer_commit` must match `^[a-f0-9]{40}$` and `confirm` must be exact (D4). Inputs the selected operation does not use must be empty. |

## Data flow

| Step | What happens |
| --- | --- |
| 1 | `inplace` (`:313`) exits 43, which sets `updated=false` and `operation=redeploy`. |
| 2 | Install admission (`:730`), then durable-state and capacity admission (`:1076-1166`). |
| 3 | Capture (`:1375`) records `authority.agents` (16 rows); quiesce and stop; move and copy (`:1409-1484`, minus the D7 files); rename to `-rollback-<backup>` (`:1491`). |
| 4 | Fresh Box (`:1783`); `Rollback reference`; policy restore (`:1813`); `start explorer` and the 12/6 gate (`:2083-2168`). |
| 5 | `classifyPriorSelections` writes 16 disposition lines; `ready(..., agents: [])`; source verification; `Verification expectation`. |

## Reused patterns

| Pattern | Where it already exists |
| --- | --- |
| Lock-held remote helper with exit codes | `deploy-explorer-qa.yml:334-375` |
| Pinned host key and `/tmp` upload | `.github/workflows/verify-explorer-qa-runtime.yml:31-62` |
| Confirmed destructive input | `cleanup-explorer-host-storage.yml:5-6,33` |
| Shell-block extraction tests | `deploy-qa-auto-selection.test.mjs:9-11`, `deploy-qa-preservation.test.mjs:11` |

## Acceptance criteria

FB means the test must fail at base `f8c930d6`.

| # | Check | Expected |
| --- | --- | --- |
| T1 | `node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs` (the CI gate, `:45-47`) | Exit 0, 0 skipped |
| T2 | Auto-selection, workspace directory plus `redeploy`: exit 43, `updated=false`, `operation=redeploy`, updater never called | Pass; FB |
| T3 | Absent workspace plus either redeploy mode: exit 1, never 42 | Pass; FB |
| T4 | No operation, or `update`: the 0/42/19/75 mapping is unchanged | Pass at base and at candidate |
| T5 | Redeploy admission: directory plus one exact Box returns 0; no Box, two Boxes or a symlink returns non-zero | Pass; FB |
| T6 | `classifyPriorSelections` on the old 16 rows against the fresh 12: 6 retained, 1 superseded (userPersisto `default -> explorer`), 5 renamed (soplangAgent, tasksAgent, webAssist, soul-gateway, roboTeamAgent), 4 absent (multimedia, webmeetAgent, liveKitServerAgent, umamiAgent), 0 enables | Pass; FB |
| T7 | The same inputs through `restorePriorSelections` reject with `QA_SELECTION_POLICY_CHANGED` | Documents the base bug and stays green |
| T8 | The selection block contains no `enable:` and passes `agents: []` | Pass; FB |
| T9 | Preservation: the D7 files are absent from the target and present in `backup/workspace`; `.data/*`, `.env`, `master-key`, `.secrets` and `passwords.enc` are byte-equal | Pass; FB |
| T10 | Updater snapshot with a running exact Box plus a stopped `…-rollback-redeploy-AbCd1234` succeeds; with the stopped Box named `…-old` it throws `QA_EXACT_RUNNING_BOX_REQUIRED` | Pass; FB (`:176`) |
| T11 | `currentQaBox` throws for a running retained Box, for two exact Boxes, and when no exact Box is running | Pass; FB |
| T12 | Rollback job: backup `redeploy-1234567` or `../x`, or execute with a mismatched confirm, fails before SSH; the job calls `"$BACKUP/helpers/rollback-explorer-qa.mjs"`; execute has no outer `flock` | Pass; FB |
| T13 | The rehearsal `exit 0` comes after `Capacity admission passed` and before `mkdir -p "$HOME/.qa-deployment-backups"` | Pass; FB |
| T14 (D9 only) | Set A or set B matches; a mixed A/B returns false | Pass |
| T15 | `node --test explorer/tests/unit/retiredLocalModelGraph.test.js` | Pass |
| T16 | The `bash -n` sweep (`deploy-qa-in-place-workflow.test.mjs:76-84`) covers the new job | Pass |
| T17 | On the rollback fixture, `previewCapture` leaves the backup empty and throws the same codes as `capture` for an unsupported row or an active foreign Box | Pass; FB |

Probes:

| Probe | Expected |
| --- | --- |
| Commit of 39 hex characters, or uppercase | Rejected before SSH |
| A second `redeploy` | Fails at `:939-943` on the retained Box; the first backup is untouched |
| Plan against a missing backup | `QA_BACKUP_PATH_INVALID`, nothing mutated |
| Registry row with `runtime:'docker'` | `QA_AGENT_SELECTION_UNSUPPORTED` before any stop |
| Concurrent `update` | Queued by `concurrency.group`; a remote `flock -n` would return 75 |

## Review, verification and gates

| Gate | Scope |
| --- | --- |
| plan-reviewer | This spec |
| code-reviewer (Opus High) | The exact branch diff: data recovery and test pass/fail changes. D9 is reviewed separately against the Ploinky diff. |
| test-runner | T1–T17 |
| Live proof | P3–P5, with logs kept under `.ploinky/test-artifacts/qa-redeploy-2026-10-19/` |

Source approval unlocks only the rehearsal. `redeploy` waits for a passing rehearsal and the operator's go-ahead to push and dispatch. The `ploinky-proxy` gate does not apply.

## Runbook

**Log filter.** GitHub echoes each step's script into its log, with every line prefixed by `ESC[36;1m`. Most of the asserted strings appear in that script, so a raw grep would pass even if the step never printed them. Always filter first:

```bash
gh run view <id> -R AssistOS-AI/AssistOSExplorer --log > run.log
grep -v $'\x1b\[36;1m' run.log > out.log
```

**P0, read-only baseline.**

```bash
gh run view 35859121829 -R AssistOS-AI/AssistOSExplorer --json startedAt,updatedAt,conclusion
gh workflow run inspect-explorer-host-storage.yml -R AssistOS-AI/AssistOSExplorer --ref main
gh run list -R AssistOS-AI/AssistOSExplorer -w inspect-explorer-host-storage.yml -L 1 --json databaseId
git ls-remote https://github.com/AssistOS-AI/AssistOSExplorer.git refs/heads/main   # f8c930d66b84b839de1c6a28717aa6e1065e540c
gh api repos/AssistOS-AI/AchillesCLI/contents/roboTeamAgent   # expect 404 (local master c9392fa has no agent manifests)
```

Save the inspect log as `p0-inspect.log` and record:

| Item | Requirement |
| --- | --- |
| `availableBytes` | At least the larger of 25 GiB and the workspace size plus 4 GiB |
| Nested `ploinky_*` containers | 16 expected; each extra is a Marketplace choice to re-enable by hand |
| Retained Boxes | No labelled `…-rollback-…` or `…-failed-…` Box |
| Named volumes | None for QA |

Do not run `verify-explorer-qa-runtime.yml` in P0. It is read-only, but it fails on the 16-agent graph by design (`:17,58`).

**P1, implement.**

1. Create the branch with `git switch -c qa-preserving-redeploy f8c930d6`.
2. D9: sha256-hash `git -C ../ploinky show 7d8c04d0:<path>` for each of the three paths listed at `rollback-explorer-qa.mjs:40-42`.
3. If any digest differs, find the commit whose digests match by hashing the entries of `git -C ../ploinky log --format=%h -- <path>`.
4. Review `git -C ../ploinky diff <match>..7d8c04d0 -- <paths>` for account overwrites during graph registration, then add set B.

**P2, tests.** Run T1–T17. Push only after code review; the push is an outward action that needs the operator.

**P3, dispatch.** Rehearsal first:

```bash
gh workflow run deploy-explorer-qa.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy \
  -f operation=redeploy-rehearsal -f expected_explorer_commit=f8c930d66b84b839de1c6a28717aa6e1065e540c
```

If GitHub answers HTTP 422 (unknown inputs), stop; see conditional blocker 2. Once the rehearsal passes, re-run `git ls-remote` and confirm main is still `f8c930d6…`. Then:

```bash
gh workflow run deploy-explorer-qa.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy \
  -f operation=redeploy -f expected_explorer_commit=f8c930d66b84b839de1c6a28717aa6e1065e540c \
  -f 'confirm=redeploy explorerQaWorkspace'
```

**P4, log assertions.** Each line below must give `grep -cF` ≥ 1 on `out.log`:

```text
[deploy-qa] Preserving redeploy selected (redeploy); the in-place updater was not run.
[deploy-qa] Preserving redeploy admitted: one existing workspace and exact Box.
[deploy-qa] Durable-state admission passed before stopping the previous runtime.
[deploy-qa] Capacity admission passed before stopping the previous runtime.
[deploy-qa] Redeploy backup: redeploy-
[deploy-qa] Stopping nested QA services before the consistent durable-data backup...
[deploy-qa] Prior workspace retained; durable files and their encryption identities copied and compared. Runtime state will be regenerated.
[deploy-qa] Exact prior Explorer QA runtime retired and retained stopped for rollback; durable data restored from /home/admin/.qa-deployment-backups/redeploy-
[deploy-qa] Selected AchillesIDE/main at f8c930d66b84b839de1c6a28717aa6e1065e540c.
[deploy-qa] Rollback reference: backup=redeploy-
[deploy-qa] Durable access policy, revocations and audit history restored before graph activation.
Tracked agents: 12
Running agents: 12
[deploy-qa] no-wait readiness 6/6 ready, 0 starting, 0 failed
[deploy-qa] Prior agent choices restored and checked against the fresh runtime.
[deploy-qa] Verified AchillesIDE/main at f8c930d66b84b839de1c6a28717aa6e1065e540c.
[deploy-qa] Verified legacy-agents/
[deploy-qa] Verified webmeet/
[deploy-qa] Verification expectation: {
[deploy-qa] Protected host resource identities remained unchanged
[deploy-qa] Explorer QA Box is ready.
```

Further checks on `out.log`:

| Check | Expected |
| --- | --- |
| Summary line | `Prior selections: 16 total, …, 9 not replayed, 0 enabled.` |
| `grep -c 'Prior selection not replayed:' out.log` | 9 |
| Retained/superseded split | 6/1 is Inferred (it assumes the old userPersisto row had profile `default`). A different split is acceptable if the `policy superseded` lines explain it. |
| `grep 'Dependency wave' out.log \| grep -E 'multimedia\|webmeetAgent\|liveKitServerAgent\|umamiAgent'` | Prints nothing |

Negative control: run the same assertions on the filtered rehearsal log. Every string from `Redeploy backup:` onward must be absent there; if any is present, the filter is wrong.

**P5, post-checks.**

```bash
gh workflow run verify-explorer-qa-runtime.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy \
  -f expected="$(grep -o 'Verification expectation: {.*}' out.log | head -1 | cut -d' ' -f3-)"
curl -s -o /dev/null -w '%{http_code}\n' 'https://explorer-qa.axiologic.dev/auth/login?agent=explorer'   # 200
```

The verifier must show `result: passed`, 12 agents, no-wait 6/6 and `setupComplete:true`, which proves ownership survived. Then:

| Check | Expected |
| --- | --- |
| An existing QA user signs in (browser) | Their Explorer files are there |
| Admin opens Soul Gateway settings | Prior providers and tiers are present; no tier names a disabled provider |
| D6 post-step | Review the subject rows for the old `agent:proxies/soul-gateway`, `agent:AchillesCLI/roboTeamAgent` and `agent:AchillesIDE/{soplangAgent,tasksAgent,webAssist}` principals, and the DPU agent policies; re-apply any customization under the new key |
| Re-run `inspect-explorer-host-storage.yml` | One running exact Box, one stopped `…-rollback-redeploy-…` Box, backup present |
| `gh workflow run deploy-explorer-qa.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy` (no inputs, so `update`) | `"status":"unchanged"`, which proves D8. The same dispatch from `main` is expected to fail until D8 is merged. |

**P6, rollback and abort criteria.** Use `out.log` markers.

| Last marker present | State | Action |
| --- | --- | --- |
| No `Stopping nested QA services` | QA untouched and running; at most an empty backup authority remains | Fix and rehearse again; do not roll back |
| `Stopping nested…`, without `Exact prior … retained stopped` (includes quiesce succeeding but `container stop` failing) | Old Box keeps its exact name, maybe still running with nested services down; workspace possibly moved | `rollback-plan` with `rollback_current_id=absent`. Inferred trace: `plan()` accepts the predecessor under its exact name and `absent` as current (`rollback-explorer-qa.mjs:405-425`); `execute` then quiesces and stops it before recreating (`:456-474`). |
| `Exact prior … retained stopped`, without `Rollback reference:` | Old Box renamed and stopped; no fresh Box | `rollback-plan` with `absent` |
| `Rollback reference:` (readiness, sources, public URL or P5 failure) | Fresh Box present | `rollback-plan` with that line's `current` value |

```bash
gh workflow run deploy-explorer-qa.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy \
  -f operation=rollback-plan -f rollback_backup=redeploy-XXXXXXXX -f rollback_current_id=<64hex|absent>
# after "result":"planned":
gh workflow run deploy-explorer-qa.yml -R AssistOS-AI/AssistOSExplorer --ref qa-preserving-redeploy \
  -f operation=rollback-execute -f rollback_backup=redeploy-XXXXXXXX -f rollback_current_id=<same> \
  -f confirm=redeploy-XXXXXXXX
```

Expect `"result":"recovered"` with the old 16-agent graph. Data written after the redeploy survives only in `BACKUP/failed-workspace`. A later redeploy first needs a separately reviewed retirement of the retained Boxes (`:939-943`).

## Open questions / risks

| Item | Status |
| --- | --- |
| Capability digests differ at `7d8c04d0` | Inferred likely; not run here because the local hash command needed approval. P1 and the rehearsal settle it. |
| `--ref` dispatch accepts inputs that exist only on the branch | Inferred yes; the P3 rehearsal proves it either way. |
| Capacity, dirty managed checkouts, `edge-desired` drift, Marketplace extras | Unknown; P0 and the rehearsal surface them before any stop. |
| Post-split graph never deployed before (`docs/deploy-skills-explorer.md:289`) | Observed; failures land in the last P6 row. |
| Removing only the stopped rollback Box via `cleanup-explorer-host-storage.yml` | Unknown. Its plan carries whole engine inventories (`cleanup-explorer-host.mjs:49-77`); a container-only plan has not been verified. Doing it also gives up rollback. |
| D5 alternative: replay agents that were optional in the old graph | Rejected: it needs the old graph resolved, and it conflicts with the verifier's count of 12. |

## Conditional blockers

| # | Blocker |
| --- | --- |
| 1 | Applies whatever the outcome, after acceptance. D8 must reach `main`, which needs the user's approval to merge. Until then, every `update` dispatch must use `--ref qa-preserving-redeploy`. |
| 2 | If GitHub rejects the branch-only inputs, the workflow must merge to `main` before the redeploy. |
| 3 | If the D9 review shows that `7d8c04d0` overwrites saved accounts, a forward migration needs its own design. |

## Implementation order

| Step | Runnable checkpoint |
| --- | --- |
| 1 | D9 digest check (T14 if set B is needed) |
| 2 | `currentQaBox` wiring (T10, T11) |
| 3 | Classifier, selection block and `previewCapture` (T6–T8, T17) |
| 4 | Inputs, exit 43, admission, rehearsal, D7, D10, D11 (T2–T5, T9, T13, T16) |
| 5 | Rollback job (T12) |
| 6 | Docs and DS002 (T1, T15) |
| 7 | Code review, push, P3–P5 |

## Review fixes (2026-10-19, from QA_PRESERVING_REDEPLOY_PLAN_REVIEW_2026-10-19.md; these supersede conflicting text above)

| ID | Fix |
| --- | --- |
| RF1 | **Capacity stop before P3 `redeploy`.** From the latest inspect JSON compute `required = max(25 GiB, du(/home/admin/explorerQaWorkspace) + 4 GiB)` (the code's formula, `deploy-explorer-qa.yml:1110-1113`). Do not dispatch `redeploy` while `availableBytes < required`. Measured 2026-10-19: available 15,052,369,920 B, workspace 26,415,316,992 B, required 30,710,284,288 B, shortfall ≈15.66 GB. **User-blocking prerequisite: enlarge the QA disk to ≥ 80 GB total.** Do not lower the floor, and do not delete durable data to make room. |
| RF2 | **Rehearsal is not stopped by capacity.** In `redeploy-rehearsal` only, capacity admission prints the diagnostics and records `capacityAdmitted=false|true` without asserting. The rehearsal then runs `accountCapability` and `previewCapture`, prints every verdict plus `[deploy-qa] Rehearsal: capacity admitted=<bool> required=<B> available=<B>`, and exits non-zero if any gate failed, capacity included. For `update` and `redeploy`, capacity stays fatal at `:1163`. T13 changes accordingly: it asserts both the non-fatal rehearsal branch and the unchanged fatal path in the other modes. |
| RF3 | **No hard-coded prior-selection counts.** T6 stays a 16-row fixture. Add a 17-row case with `AchillesCLI/promotionScout`, which is classified `absent`. P4 derives N, the absent list and the not-replayed count from the rehearsal's per-selection lines (expected now: 17 total, 5 absent, 10 not replayed) and adds `promotionScout` to the Dependency-wave exclusion grep. In P6, "old 16-agent graph" becomes "the prior N-agent graph". The rehearsal log must carry the capacity diagnostics JSON line, which is part of the negative control. |
