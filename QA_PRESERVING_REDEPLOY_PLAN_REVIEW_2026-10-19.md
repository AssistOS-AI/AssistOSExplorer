# Review: QA preserving redeploy plan (2026-10-19)

Reviewed plan: `QA_PRESERVING_REDEPLOY_PLAN_2026-10-19.md`. Background: `QA_UPDATE_ANALYSIS_2026-10-19.md`. Base: AssistOSExplorer `main` at `f8c930d6`. New evidence: the inspect run 39232128681, saved as `i2.json` and `inspect-baseline.log` in the parent session's scratchpad `qa/` directory. This is an initial review against the plan's stated intent and the parent's P0 brief. It is read-only: nothing was run, dispatched, or changed.

## Verdict

**APPROVE WITH CHANGES.** The plan has three Major (Important) findings and no Blocking finding, because every gap fails closed before services stop. One user-blocking prerequisite sits outside the plan: the QA disk is too small. The redeploy cannot be admitted until the operator enlarges it, and neither cleanup nor a lower floor closes the gap (see Decisions).

## Requirement coverage

| Requirement | Covered by | Status |
| --- | --- | --- |
| "durable state of every remaining agent must survive" | D7, T9, `:1409-1493` copy-and-compare | covered |
| "rollback must stay available" | D2, D8, D11, P6 | covered |
| "operator has no SSH" | D11 log lines, rollback job | covered |
| "a failed redeploy is acceptable, lost data is not" | Capacity admission kept (`:1083-1165`) | covered, but P3 has no stop for the measured shortfall (F1) |
| The rehearsal surfaces failures before the real run (D12) | T13 | contradicted on this host (F2) |
| The P0 baseline drives the expectations | P0 table, T6, P4 | partial: hardcoded 16 versus the observed 17 (F3) |

## Findings (confidence ≥ 80)

### [Major] The runbook dispatches into a known fail-closed capacity gate, and the prompt's figures are wrong

**Where:** Runbook P0 and P3. `deploy-explorer-qa.yml:1110-1113,1163`.
**Confidence:** 95
**Evidence:** The plan says "`availableBytes` | At least the larger of 25 GiB and the workspace size plus 4 GiB". The code reads:
```js
const workspaceAllocation = allocated(target, true);
const priorBytes = BigInt(workspaceAllocation.bytes);
const minimum = 25n * 1024n ** 3n;
const required = priorBytes + 4n * 1024n ** 3n > minimum ? priorBytes + 4n * 1024n ** 3n : minimum;
```
The P0 data shows `"availableBytes": "15052369920"` (`i2.json:8`), and the root du of `/home/admin` gives `26415316992 /home/admin/explorerQaWorkspace` (`i2.json:2122`). The 13.14 GB figure covers only `.ploinky`. Required free space is therefore max(26,843,545,600; 26,415,316,992 + 4,294,967,296) = **30,710,284,288 B**. The shortfall is **15,657,914,368 B (≈15.66 GB)**, not about 12 GB.
**Validation step run:** Re-read `:1077-1166` and `i2.json:2121-2129,2241-2249`.
**Why it matters:** As written, the runbook goes from rehearsal to `redeploy` with no stop on a known shortfall.
**Suggested direction:** Add an explicit P0 gate: compute `required` with the code's formula from the inspect JSON, and stop P3 when `availableBytes < required`, citing the Decisions row below.

### [Major] The rehearsal sits after capacity admission, so on this host it never reaches `previewCapture` or D9

**Where:** D12, the Files row "after `:1249`", and T13.
**Confidence:** 95
**Evidence:** T13 reads: "The rehearsal `exit 0` comes after `Capacity admission passed` and before `mkdir -p …`". The assertion `assert(freeBytes >= required, 'Insufficient QA capacity …')` runs at `:1163`, before `:1249`.
**Validation step run:** Confirmed the order: capacity at `:1077-1166`, capture at `:1375`, and `rollbackSupported` at `:1384-1391`.
**Why it matters:** The rehearsal would abort on capacity. The user would learn about D9 digest drift (conditional blocker 3), `QA_AGENT_SELECTION_UNSUPPORTED` or `QA_SOURCES_INCOMPLETE` only after paying for a disk resize.
**Suggested direction:** In `redeploy-rehearsal`, capacity admission prints the diagnostics and records `capacityAdmitted=false` without aborting. The rehearsal then runs `accountCapability` and `previewCapture`, prints every verdict, and exits non-zero if any gate failed, including capacity. Update T13 so it asserts that capacity is non-fatal only in rehearsal mode and stays fatal for `redeploy`.

### [Major] The hardcoded "16 prior selections" contradicts the observed 17; the post-stop assertions would false-fail

**Where:** T6, Data flow steps 3 and 5, the P4 summary line, `grep -c … 9`, the Dependency-wave grep, and P6's "old 16-agent graph".
**Confidence:** 90
**Evidence:** Seventeen nested containers are running, including `ploinky_AchillesCLI_promotionScout_explorerQaWorkspace_7a31ab77` (`i2.json:1779`). `selectedAgents()` returns every `agents.json` row (`rollback-explorer-qa.mjs:139-148`).
**Validation step run:** Counted the nested container names in `i2.json`: 17. No checkout in the workspace contains `promotionScout`, so the fresh graph cannot hold it.
**Why it matters:** P4 runs after services are stopped and the workspace is moved. A mismatch of "16 total / 9 not replayed" against an actual 17/10 reads as a failed redeploy and pushes the operator toward an unnecessary rollback.
**Suggested direction:** Keep T6 as a fixture (16 rows is fine there) and add a 17-row case. Derive the live N, the absent list and the not-replayed count from the rehearsal's per-selection lines rather than fixed numbers. Currently that is 17 total, 5 absent, 10 not replayed, with promotionScout added to the Dependency-wave exclusion grep.

## Citation audit

Sampled 12 citations:

| Cited location | Exists | Quote matches | Note |
| --- | --- | --- | --- |
| `deploy-explorer-qa.yml:30` timeout 50 | yes | yes | |
| `:731-732` "never retires an installation" | yes | yes | |
| `:1083-1165` capacity | yes | yes | |
| `:1384-1391` `rollbackSupported` | yes | yes | |
| `:1409-1493` move, copy, rename | yes | yes | `renameSync` at `:1435`; `runtimeEntries` excludes `box` |
| `update-explorer-qa.mjs:176` | yes | yes | `QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED` |
| `update-explorer-qa.mjs:89-97` | yes | yes | |
| `verify-explorer-qa-runtime.mjs:27,58` | yes | yes | `boxes.length === 1`; `records.length, 12` |
| `rollback-explorer-qa.mjs:360-361` | yes | yes | `QA_UNSELECTED_ACTIVE_BOX` tolerance |
| `rollback-explorer-qa.mjs:653-654` | yes | yes | path-hash or name filter |
| `rollback-explorer-qa.mjs:763-765` | yes | yes | |
| `rollback-explorer-qa.mjs:792-798` | yes | yes | the helper locks itself |

## Acceptance-criteria audit

| Criterion | Runnable | Would fail if unmet | Note |
| --- | --- | --- | --- |
| T6 | yes | yes | Fixture only; needs a 17-row live counterpart (F3) |
| T13 | yes | yes | Encodes the wrong order for this host (F2) |
| P4 counts | yes | false-fails | F3 |
| P0 `availableBytes` | observable | yes | Not wired to a stop (F1) |
| The others (T1-T5, T7-T12, T14-T17) | yes | yes | Spot-checked for existence only |

## Decisions for the user

| Decision | Options | Plan's recommendation | Reviewer's view |
| --- | --- | --- | --- |
| Close the ≈15.66 GB capacity gap (user-blocking) | (a) **Enlarge the QA disk**; (b) lower the floor; (c) cleanup; (d) delete durable data of dropped agents | None (P0 "Unknown") | **(a), keeping the floor unchanged.** The disk is 51.86 GB with 36.81 GB used. Admission needs at least 30.71 GB free, so grow it by at least 16 GB. Afterwards the retained backup and rollback Box stay on disk (removing them is out of scope), so the fresh runtime adds about 20 GB of new writes. Size the disk at **≥ 80 GB total**. Re-run inspect after the resize and redispatch only when `availableBytes ≥ workspace du + 4 GiB`. |

Why the alternatives fail, measured:

| Rejected option | Measured reason |
| --- | --- |
| (b) Lower the floor | The real minimum new writes are about 20 GB, which exceeds the 15.05 GB free. The move costs nothing: a same-filesystem rename (device 2050 for both paths, `i2.json:2146,2236`, `fs.renameSync` at `:1435`). The copy, however, duplicates the non-regenerated tree with `cp -a --reflink=auto` (`:1461`): 26.42 − 13.14 (`.ploinky`) − 0.055 (`.runtime`) ≈ **13.22 GB** (Inferred; the inspect walk skips `.data`, so most of it is probably `.data/local-llm`). `.ploinky/box` is regenerated, not copied (`runtimeEntries`, `:1466`), and the new Box bind-mounts the fresh `.ploinky/box/images` (`i2.json:36`). The 12-agent graph then re-pulls ploinky-node 1.09 + roboteam 0.78 + local-llm 4.91 ≈ **6.78 GB** (`i2.json:2005,2021,2049`). Any lower floor would only turn a clean pre-stop refusal into ENOSPC after the stop. The exception is a reflink-capable filesystem, which the inspect does not record (Unknown). |
| (c) Cleanup | The 4 old backups total **651,264 B** (`i2.json:2149`) and contain only helpers, with no workspace, so they have no rollback or capacity value; leave them. Nested reclaimable space is at most 1.32 GB (`i2.json:2084`, the unreferenced `node` image is 0.23 GB). `cleanup-explorer-host.mjs` cannot target either: `PATH_NAMES` (`:12`) excludes `.qa-deployment-backups`, and `CONTEXTS` (`:11`) covers only outer engines, with no nested path (grep for `nested` finds nothing). Its only large target is the whole `explorerQaWorkspace`, which would destroy data. |
| (d) Delete data of dropped agents | Destroys durable data. That contradicts "lost data is not [acceptable]" and has no authorization. |

## Risks / open questions (confidence < 80)

| Risk | Reason for uncertainty |
| --- | --- |
| promotionScout: its data is preserved, since the copy covers all of `.data` (`:1464`, Observed) and `.data/promotionScout` exists (`i2.json:1796`). It would be classified `absent`. Whether its row passes `selectedAgents()` (`rollback-explorer-qa.mjs:140-144`) is unverified; `previewCapture` will show it, once F2 is fixed. | The registry row was not inspected |
| D7 regenerates `enabled_repos`. If AchillesCLI is not in the fresh repo map, Marketplace may not offer promotionScout for re-enabling, and the plan's "re-enable in Marketplace" note may not hold for it. | The fresh repo map was not traced |
| The capacity du is `required=true` with a 30 s timeout (`:1098-1100`). The admin-level inspect du of the workspace returned `null` (`i2.json:2239`) for an unknown reason, while the root du (90 s bound) succeeded. A slow root du would fail admission even after the resize. | Timing not measured; the rehearsal's diagnostics will show it |
| Filesystem type and reflink support | Not in the inspect output |
| The roboTeamAgent image of the fresh graph equals `roboteam-agent:runtime` | Not checked; it affects the 6.78 GB estimate by ±0.8 GB |

## Not assessed

D9 digest values (no hashing was run). `cleanup-explorer-host.mjs:100-250`, apart from a grep. The D6 principal claims. Every doc line citation in the Files table. `prepareBoxForCommand`, beyond inferring from the mount layout that images are re-pulled. No tests, workflows or `gh` commands were run.

## Notes for the implementer (Minor)

| Note |
| --- |
| P6's "old 16-agent graph" should read "the prior N-agent graph". |
| Add the capacity diagnostics JSON line to the P4 negative control, so the rehearsal log carries the breakdown. |

**Final verdict:** APPROVE WITH FIXES. The targeted edits are (1) a P0/P3 capacity stop with the formula and current numbers; (2) a non-fatal capacity report in rehearsal mode, which then continues to `accountCapability` and `previewCapture` and exits non-zero on any failed gate, with T13 updated; (3) N derived from the rehearsal instead of a fixed 16, plus a 17-row case and promotionScout in the exclusion grep. Disk enlargement to ≥ 80 GB is a user-blocking prerequisite before `redeploy`.
