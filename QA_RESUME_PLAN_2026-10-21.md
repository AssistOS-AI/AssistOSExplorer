I've written the SPEC below. It needs your answer on Q1 (what a later dispatch does if a resumed run fails after the new Box exists); Q1 does not block today's recovery. Nothing was dispatched.

The current state on the QA host decides both designs. The redeploy failed only at the late commit check, after the old Box had been retired. Today a no-input dispatch would stop safely without changing anything, because `select()` needs a running Box with the exact name and none exists. So the fix needs a route that runs before `select`.

**Unresolved question for the user (separate from the SPEC)**

| ID | Question | Options | Recommendation | Affected step |
| --- | --- | --- | --- | --- |
| Q1 | A resumed run could fail after it has already created the new Box, for example when readiness or policy restoration fails. What should a later dispatch do then? | (a) Refuse with `QA_REDEPLOY_UNFINISHED` and send you to the rollback workflow (`plan` resolves `current` to the new Box ID). (b) Extend resume so it removes that new Box and its regenerated runtime, then runs the tail again. | (a). It needs no new deletion code. Today's incident never reaches that state, because no Box with the exact name exists. (b) adds container and runtime-state deletion that would need its own review. | Contract 2 (route table, row "exact Box present, newest unfinished") |

---

# SPEC: QA deploy accepts a newer main head, and finishes an interrupted redeploy

## Header (candidate identity)

| Item | Value |
| --- | --- |
| Repository | `/Users/danielsava/work/file-parser/AssistOSExplorer` (AssistOS-AI/AssistOSExplorer) |
| Base | `origin/main` = `1d1f147b0e03b114821ce299043c03a0fa9691b2` (after `git fetch` on 2026-10-21). Local `main` = `5a11705b`. `547aee02` is an ancestor. |
| Deploy files unchanged since the implemented plan | `git diff --stat 5a11705b origin/main -- .github docs/deploy-explorer-qa.md docs/specs tests/smoke AGENTS.md` lists only `docs/specs/DS001-coding-style.md` and `docs/specs/DS006-document-workflows.md`. Every deploy workflow, script and test is identical to `5a11705b`. Line numbers below refer to `git show origin/main:<file>`. |
| Observed live state | Run 39604707578 failed at the late commit check, with the message `AchillesIDE resolved to 547aee02…, not the expected 5a11705b…`. It then printed `Rollback reference: backup=redeploy-jQRMF7aJ predecessor=d4ada3623b3d… current=absent`.<br>Inspect run 39608950538 (13:33Z) shows:<br>• exactly one QA container: `d4ada3623b3d…`, named `ploinky-box-explorerqaworkspace-7a31ab7775eb-rollback-redeploy-jQRMF7aJ`, `"running": false`<br>• `availableBytes` `31472467968`<br>• live workspace 14.48 GB, containing `.ploinky` (118784 B) and `.runtime/ploinky` (26660864 B, the `--no-checkout` clone)<br>• `redeploy-jQRMF7aJ/workspace/.ploinky` at 12421816320 B<br>Rollback plan run 39608252912 returned `"result":"planned","predecessorId":"d4ada362…","currentId":null`. |

## Intent (1 paragraph)

Two defects left QA down after a successful preserving stop and move.

- **(A) Commit pin.** The Reconcile path required AssistOSExplorer `main` to match the dispatch pin exactly (`deploy-explorer-qa.yml:1389` and `:1939`). A teammate's ordinary fast-forward push in the 20-minute redeploy window therefore aborted the run after the old Box was retired. The fix: for redeploy, fresh install and the new resume mode, Reconcile accepts `main`'s head when it is the pin or a fast-forward descendant of it, proven on the host. It also accepts such a move between source resolution and `ploinky start`, and logs every move. The in-place path keeps its exact pin.
- **(B) No way to finish.** Once the old Box was retired, no input-free dispatch could complete the redeploy. The only exit was rollback, which the user declined. The fix: a dispatch now recognises exactly the state "the newest backup B holds a verified preserved workspace, the predecessor Box is retained stopped under `<box>-rollback-B`, no Box has the exact name, and the tail never ran past Box preparation". It then runs the existing Reconcile tail from just after "Exact prior … retired". It does not stop anything, move anything, prune any backup or create a new backup, B stays the rollback point, and every post-start gate still runs.

The governing constraint is unchanged: never lose data, never fall through into a fresh install or a new redeploy, and refuse every state that is not proven.

## Out of scope

| Item | Reason |
| --- | --- |
| A tail that failed after the new exact-name Box exists | Q1; for now it is refused and sent to the rollback workflow |
| Pinning `ploinky start` clones to a commit | Ploinky's `--repo-branch` takes branches only; the post-start fast-forward rule covers the race |
| Changes to `rollback-explorer-qa.mjs`, B's frozen helpers, retention classes, the destroy, cleanup and verify workflows | Reused unchanged |
| The in-place path's exact pin (`update-explorer-qa.mjs select` / `execute --expected-commit`) | Kept on purpose (decision A3) |
| Any dispatch | Only after the user approves it |

## Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| A1 | In Reconcile (all modes), the commit `R` resolved for `main` is accepted when `R == P` (the dispatch pin) or `P` is an ancestor of `R`. Anything else fails closed. | Accepting any head would silently deploy a rewound or rewritten `main` that the dispatch never saw. A fast-forward matches what the dispatcher meant: `main` as of now or newer. |
| A2 | Ancestry is proven on the host with a commit-only partial fetch into a private temporary bare repository: `git fetch --filter=tree:0 --no-tags <url> <R>`, then `git cat-file -e P^{commit}` and `git merge-base --is-ancestor P R`. A fetch failure fails closed. | The host already trusts the GitHub git transport (`GRAPH_REPOSITORIES` at `:1902-1909`). There is no API token or rate limit. Fetching commits only is small. |
| A3 | The in-place path keeps the exact pin. | `select()` decided using `P`'s diff; deploying another commit in place would bypass that classification. |
| A4 | The early check (`:1382-1393`) and the late check (`:1939-1946`) both use A1, compared against `P`. The post-start check (`:2562-2582`) accepts the deployed commit `D` when `D == EXPECTED_COMMITS[repo]` or `EXPECTED_COMMITS[repo]` is an ancestor of `D` inside the Box, for every graph repository. It then sets `EXPECTED_COMMITS[repo]=D` before the Verification expectation (`:2626-2641`). | `ploinky start` (`:2440`) clones minutes after resolution. The clones are full (ploinky `f2b2c4d1` `cli/utils/repos.js:342-345`: `const args = ['clone']; if (actualBranch) args.push('--branch', actualBranch);`), so ancestry can be checked inside the Box. |
| B1 | The resume decision is made by a new read-only `qa-backups.mjs route` step in the locked in-place script, before `select`. The `resume` route exits 44. | `select()` needs a running Box with the exact name (`update-explorer-qa.mjs` `snapshot()`), so it cannot run in the resume state. |
| B2 | `route` returns `resume` only for the proven state in contract 3. Every other Box-absent state is refused. When a Box with the exact name exists, the route is `select`, unless the newest backup is an unfinished redeploy (refused, see Q1). | Nothing may fall through into a fresh install or a new redeploy. |
| B3 | Resume re-runs the full proof under the Reconcile lock, then skips the stop/backup segment (`:1589-1832`) and runs the unchanged tail from `:1834`. | Reuse the tail; do not duplicate it. |
| B4 | Resume removes stale `AdvancedLanguageAgent` and `.runtime/ploinky` clones when proven, so the tail clones them fresh. It keeps `.ploinky/box/{dependencies,images}` (supervisor caches). It refuses any evidence that `ploinky start` or edge initialisation ran. | A resume whose own tail failed before the Box existed (for example an image pull failure) must stay resumable. Only graph-start evidence indicates a state beyond Box preparation. |
| B5 | The tail's helper imports (`:2524`, `:2606`) use the current SHA-checked `rollback-explorer-qa.mjs` copy in `QA_RETENTION_DIR`. B's `helpers/` keeps its frozen helper as the rollback authority. | The gates are those of the reviewed run, and the rollback authority is not altered. |
| B6 | Resume capacity is fatal and requires free space ≥ 4 GiB + du(B/workspace/{`.ploinky/box`, `.runtime`, `.ploinky/repos`, `AdvancedLanguageAgent`}). It also logs the rollback headroom (free space minus the durable size). | The move and the copy are already paid for; what remains is the regenerated runtime. The 25 GiB floor is sized for "retained backup + fresh runtime", and the backup already exists. Observed: 31.47 GB free against an inferred requirement of about 14 GB. |

## Files to create

None.

## Files to modify

| Path:lines (origin/main) | Change |
| --- | --- |
| `.github/workflows/deploy-explorer-qa.yml:352-361` | Upload and clean up `qa-backups.mjs` and `qa-backups-privileged.mjs` beside the update and rollback helpers |
| `…:402-422` | Locked script: run `route` before `select`, normalised with `\|\| { …; exit 1; }`; `resume` gives `exit 44`; `select` continues as today |
| `…:425-437` | Handler: `44` writes `updated=false` and `operation=resume` |
| `…:757-764` | `case "$QA_OPERATION"` accepts `update\|redeploy\|resume` |
| `…:820-842` | `cleanup_remote_files` also removes `QA_ANCESTRY_DIR` (regex-guarded `mktemp` path) and the resume lock-holder file in `QA_RETENTION_DIR` |
| `…:861-911` | `assert_qa_install_admission` gains a `resume` branch (contract 4) |
| `…:1273` | `[ "$QA_OPERATION" = resume ] \|\| assert_qa_preservation_admission` |
| `…:1359-1393` | Add `prove_explorer_fast_forward P R <phase>` after `resolve_default_branch`. The early check uses it and sets `QA_RESOLVED_EXPLORER_COMMIT`. Messages per mode (contract 1). |
| `…:1395-1412` | Create the helpers directory for `redeploy\|resume` |
| `…:1412-1414` (insert) | `# BEGIN QA resume admission` / `# END …`, resume only: `qa-backups.mjs route --lock-held` must return `route:"resume"`; store `QA_RESUME_BACKUP` and `QA_RESUME_RECORD` |
| `…:1498-1587` | Capacity block takes `"$QA_OPERATION" "${QA_RESUME_BACKUP_DIR:-}"` and applies B6 in resume |
| `…:1589-1832` | Wrap in `if [ "$QA_OPERATION" != resume ]; then … else <# BEGIN QA resume setup … # END>; fi` (contract 5) |
| `…:1939-1946` | Late check: `prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "${EXPECTED_COMMITS[AchillesIDE]}" late`; log `[deploy-qa] Deployed AssistOSExplorer commit: <R>` |
| `…:2524`, `…:2606` | `"$QA_HELPER_DIR/rollback-explorer-qa.mjs"` → `"$QA_TAIL_HELPER"` (defined in both branches of the `:1589` wrapper) |
| `…:2573-2578` | Post-start rule A4 |
| `…:2866-2912` (summary) | `resume` line; deployed commit taken from the reconcile log |
| `.github/scripts/qa-backups.mjs:110-205, 237-252` | Extract the inventory code shared with `selectRollbackTarget` into an exported `inventoryBackups` (behaviour identical). Add `routeDeployment(adapters, scope)` and CLI `route --lock-held`. |
| `.github/scripts/qa-backups-privileged.mjs` (main and dispatch) | Add read-only mode `resume-proof --root R --workspace W --owner U --backup NAME` (contract 3, R6) |
| `docs/deploy-explorer-qa.md:302-338` | Pin semantics, the route table, the resume procedure, the refusal matrix and the updated "Last marker" table |
| `docs/specs/DS002-ploinky-runtime.md:92` | The normative contract mentions fast-forward acceptance in Reconcile and the resume route |
| `tests/smoke/lib/deploy-qa-auto-selection.test.mjs:15-40` | The stub handles `qa-backups.mjs route` (default `select`); add the 44 and normalisation cases |
| `tests/smoke/lib/deploy-qa-redeploy-workflow.test.mjs` (pin test, "a redeploy pins the AssistOSExplorer commit…") | Replace the exact-equality assertions with checks for the fast-forward function |
| `tests/smoke/lib/qa-backups.test.mjs` | Add route and resume-proof fixture tests |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:612-625` | Unchanged assertion (no `rm -rf` between `declare -a QA_CONTAINER_RECORDS` and `mkdir -p "$WORK_DIR"`). The resume setup must satisfy it by removing through node. |

## Interfaces / contracts

### 1. `prove_explorer_fast_forward P R phase` (shell function, defined at `:1381`)

| Aspect | Contract |
| --- | --- |
| Inputs | Two 40-hex commits; `phase` ∈ `early\|late` |
| `R == P` | Returns 0; no fetch |
| Otherwise | 1. `QA_ANCESTRY_DIR="$(mktemp -d /tmp/explorer_qa_ancestry.XXXXXX)"`, then `git init --bare -q`.<br>2. `timeout 120 git -C … fetch --filter=tree:0 --no-tags https://github.com/AssistOS-AI/AssistOSExplorer.git "$R"`.<br>3. `git cat-file -e "$P^{commit}"`, then `git merge-base --is-ancestor "$P" "$R"`.<br>4. On success, log `[deploy-qa] AssistOSExplorer main moved from P to R (fast-forward, phase); deploying R.` and return 0.<br>Any failure returns 1. |
| Failure messages | `early`, redeploy: "…nothing was stopped or moved."<br>`early`, resume: "…QA stays down on retained backup B; dispatch again or roll back."<br>`late`, redeploy or resume: "…the retained backup B can be rolled back, or dispatch again to resume it."<br>`late`, fresh install: today's text at `:1943`. |
| Side effects | The temporary bare repository only, removed by the exit trap |

### 2. `qa-backups.mjs route --lock-held`

| Aspect | Contract |
| --- | --- |
| Output | Exit 0 with `{"result":"routed","route":"select"}` or `{"result":"routed","route":"resume","backup":B,"predecessorId":P,"engine":E}`.<br>Exit 1 with `{"result":"refused","code":<QA_*>,"backup"?,"reason"?}`. |
| Inventory | `inventoryBackups()`: the same name, owner and mode checks and the same `createdAt` rules as `selectRollbackTarget` (`qa-backups.mjs:150-205`). It uses a light container summary (name, ID, running, labels) from `podman`/`docker container ls -a` and `inspect`. |
| "Unfinished redeploy" | The newest dated backup has a real `workspace/` directory, no rollback marker, and no `restored-selections.json` (checked with `lstat`) |

**Route table:**

| State | Route |
| --- | --- |
| Exact-name Box present; newest dated backup is not unfinished (complete, fresh-install with no `workspace/`, rollback marker present, or no backups at all) | `select` |
| Exact-name Box present; newest dated backup unfinished | Refuse `QA_REDEPLOY_UNFINISHED` (rollback workflow; Q1) |
| Exact-name Box absent; newest unfinished; contract 3 holds | `resume` |
| Exact-name Box absent; any other backup state (none, newest complete, newest has no `workspace/`, rollback marker, `createdAt` tie) | Refuse `QA_EXACT_BOX_ABSENT_NOT_RESUMABLE`, with a reason |
| Any running retained-pattern Box | Refuse `QA_RETAINED_BOX_RUNNING` |

### 3. Resume proofs (inside `routeDeployment`, re-run in Reconcile)

| ID | Proof |
| --- | --- |
| R1 | The host flock is held (`lockHeld()`, as at `qa-backups.mjs:228-231`) |
| R2 | `/home/admin/explorerQaWorkspace` is a real directory, not a symlink, owned by admin |
| R3 | No container is named exactly `ploinky-box-explorerqaworkspace-7a31ab7775eb` in either engine (an engine probe failure exits 1). No QA-labelled container is running. |
| R4 | B is the single newest dated backup and is unfinished; `helpers/node-runtime-path` and `helpers/rollback-explorer-qa.mjs` are regular files; `prior-containers.txt` is exactly `E\|P\|ploinky-box-explorerqaworkspace-7a31ab7775eb\n`; `quiesce-source.mjs` is present (written at `:1827`, after preservation); no `policy-restoration.json`; no rollback marker |
| R5 | Exactly one container is named `<box>-rollback-B`: stopped, engine `E`, ID `P`. Other stopped retained-pattern Boxes are allowed. |
| R6 | Privileged `resume-proof` (one `sudo -n /usr/bin/node --input-type=module -` process, read-only):<br>• `B/preservation.json` is a regular file with `exactCopiesVerified === true`, `source === B/workspace` and `target === /home/admin/explorerQaWorkspace`; returns `copied`<br>• `B/workspace` is a directory whose inode differs from the live workspace's<br>• every encryption identity file present in `B/workspace` (`.ploinky/data/{master-key,.secrets,passwords.enc,ploinky_subject_identity_ed25519_v1.enc}` and the legacy `.ploinky/` names) is byte-equal in the live workspace |
| R7 | B's own helper (Node from `helpers/node-runtime-path`, regex as in `rollback-explorer-qa.yml`) runs `plan B --current-id absent` and returns `"result":"planned"` with `predecessorId === P` |
| R8 | Live-workspace allowlist:<br>• Top-level entries ⊆ the top-level names in `copied` ∪ {`.ploinky`, `.runtime`, `AdvancedLanguageAgent`}.<br>• `.runtime` ⊆ {`ploinky`}. If present, `.runtime/ploinky` and `AdvancedLanguageAgent` must each be a real directory with a `.git` whose `origin` is the matching AssistOS-AI URL, and must not appear in `copied`.<br>• `.ploinky` ⊆ the `.ploinky/*` names in `copied` ∪ {`edge-desired.json`, `box`}, with `.ploinky/box` ⊆ {`dependencies`, `images`}.<br>• `.ploinky/data` must not contain `edge-routing`, `edge-publication` or `router-security`.<br>• Anything else (for example `agents.json`, `repos`, `routing.json`, `running`, `enabled_repos.json`) is refused with `QA_RESUME_GRAPH_STARTED`.<br>The implementer must confirm the `prepareBoxForCommand` workspace writes at the Ploinky head (`ploinky-box/workspace-data.mjs:233` "Creates `.ploinky/box` and its two data directories") and add each regenerable path to a literal `RESUME_REGENERABLE` list, with a test. |

### 4. `assert_qa_install_admission` resume branch

The workspace is a real directory. There is no exact-name container (`named == 0`). Every labelled container matches `retained_pattern` (`:879`) and is stopped. Otherwise return 1 with `[deploy-qa] ERROR: resume requires an absent exact Box and only stopped retained Boxes.`

### 5. Resume setup block (else-branch at `:1589`)

The steps run in this order:

1. Set `QA_BACKUP_DIR="$HOME/.qa-deployment-backups/$QA_RESUME_BACKUP"` (regex `^redeploy-[A-Za-z0-9]{8}$`, real directory), `QA_HELPER_DIR="$QA_BACKUP_DIR/helpers"`, `QA_TAIL_HELPER="$QA_RETENTION_DIR/rollback-explorer-qa.mjs"` and `QA_CONTAINER_RECORDS=("$QA_RESUME_RECORD")`. The record must equal `B/prior-containers.txt`.
2. Archive the stale lock receipts **before** starting the holder. The failed run's trap wrote `<B>-lock-release` (`:784`), and the holder stops as soon as that file is valid (`:1648-1653`). Move every existing `<B>-{lock-ready.json,lock-released.json,lock-release,lock.log,lock-source.txt}` and every inner `B/{same names}` into `B/helpers/interrupted-<UTC yyyymmddThhmmssZ>/`, created with `mkdir -m 700`, using `mv -n`.
3. Remove the proven stale `$WORK_DIR/AdvancedLanguageAgent` and `$WORK_DIR/.runtime/ploinky` (R8 proofs, `copied` from R6) with an admin `node -e` `fs.rmSync` after exact-path, `realpath` and `origin` assertions. No `rm -rf` text appears in shell.
4. Write the holder to `$QA_RETENTION_DIR/hold-workspace-lock.mjs`, using the same source as `:1632-1676`, and start it with `runtimeRoot="$QA_BACKUP_DIR/workspace"`. This runtime's `.runtime/ploinky/ploinky-box/locks.mjs` is the predecessor's, pinned by R7. The lock path is home-scoped (`~/.ploinky-box/locks/<instance>.lock`) at both 7ff252cb and f2b2c4d1 (`locks.mjs:142-143,199`). Pass the helper `"$QA_TAIL_HELPER"` and wait as at `:1680-1685`, then `assert_qa_workspace_lock_held`.
5. Set `QA_STOP_STARTED=1` and log `[deploy-qa] Resuming the preserving redeploy from B; predecessor P stays retained stopped; no service is stopped and no workspace file is moved.`

The non-resume branch sets `QA_TAIL_HELPER="$QA_HELPER_DIR/rollback-explorer-qa.mjs"` after `:1698`.

### 6. Variables the tail needs, and where they come from in a resume

| Need | Normal source | Resume source |
| --- | --- | --- |
| `WORK_DIR`, `BOX_INSTANCE`, `BOX_PATH_HASH` | `:1024-1043` | Same (recomputed) |
| `PROTECTED_BEFORE_FILE` | `:1093-1096` | Same, fresh snapshot; QA-labelled resources are excluded (`:1070,1084`) |
| `QA_VOLUME_RECORDS` (must be 0) | `:1152-1185` | Same |
| `QA_CONTAINER_RECORDS` | Exact Box loop | B/`prior-containers.txt` (R4); the loop yields 0 and logs the retained Box (`:1115-1123`) |
| `QA_NODE_HOME`, PATH | `:1275-1357` | Same |
| Helpers dir | `:1395-1412` | Same (now also created for resume) |
| Capacity | `:1498-1587` | B6 |
| `QA_BACKUP_DIR`, `QA_HELPER_DIR` | `mktemp` `:1591-1598` | Contract 5, step 1 |
| Workspace lock | `:1599-1686` | Contract 5, step 4 |
| Prior selections and authority | `capture` `:1690` | Existing `B/rollback-authority.json`, read by `:2532-2561` |
| Policy source | `B/workspace/.ploinky/data/router-security` | Same; `policy-restoration.json` is written `wx`, which is safe because R4 proved it absent |
| `QA_STOP_STARTED`, exit trap | `:1711,1725`, `:797-823` | `1` from contract 5, step 5; the trap prints `backup=B predecessor=P current=absent\|<fresh>` |
| Rollback reference | `:2146-2157` | Same (one record), with `current=<new id>` |
| Tunnel | `:521` refuses creation when `OPERATION` is non-empty | Same (`resume` is non-empty) |
| Prior-selection `currentQaBox` | `rollback-explorer-qa.mjs:438-445` admits stopped `-rollback-` Boxes | Same |

### 7. In-place locked script and handler

| Exit | Source |
| --- | --- |
| 42 | Unchanged absence proof (`:377-388`) |
| 43 | `select` returned `redeploy` |
| 44 | `route` returned `resume` (after `printf '[deploy-qa] Deployment route: %s\n'`) |
| 0 / 1 / 75 | As today; `route`'s own exit codes are normalised to 1 |

## Data flow (the live recovery)

1. The Resolve step pins `P` = `main`'s head (for example `1d1f147b`) (`:42-63`).
2. In the in-place step, the workspace exists (`:389`) and `route` proves R1–R8 for `redeploy-jQRMF7aJ`. It prints `Deployment route: {"route":"resume",…}` and exits 44; the handler writes `operation=resume`.
3. Reconcile runs install admission (resume branch), the protected snapshot, the record loop (retained `d4ada362` logged, zero records), the Node install, and the early fast-forward check `P→R`. Then the helpers directory, the resume admission (R1–R8 again under this lock), and the B6 capacity check.
4. The resume setup archives the stale receipts, removes the proven `.runtime/ploinky` `--no-checkout` clone, takes the lock through `B/workspace`'s runtime, and sets `QA_STOP_STARTED=1`.
5. The unchanged tail runs from `:1834`: `.env` check, Ploinky clone and checkout, graph resolution, the late fast-forward check, ALA clone, edge intent, Box prepare, `Rollback reference … current=<new>`, policy restoration (writes `B/policy-restoration.json`), `ploinky start`, readiness, prior-selection classification (writes `B/restored-selections.json`), source checks with A4, AgentLib verification, Verification expectation, loopback Router check, protected compare.
6. Runner steps: public URL and Cloudflare topology checks. B is now a `complete-redeploy`, so the next redeploy prunes it only after that run's own health gate (D2). `rollback-target` keeps selecting B, now with `currentId=<new>`.

## Reused patterns

| Pattern | Location |
| --- | --- |
| Locked script output normalisation (`\|\| { printf …; exit 1; }`) | `deploy-explorer-qa.yml:404-410` |
| Admin inventory and `createdAt` ordering | `qa-backups.mjs:150-205` |
| Root read in one stdin-fed process | `qa-backups.mjs:232-238` (`spawnSync('sudo', ['-n', '/usr/bin/node', '--input-type=module', '-', ...args]`), `qa-backups-privileged.mjs:1-6` |
| Retained-Box tolerance | `deploy-explorer-qa.yml:879-899`, `:1115-1123` |
| Archive lock holder and readiness wait | `:1632-1686` |
| Running the backup's own helper with its own Node | `rollback-explorer-qa.yml` locked session (the `node-runtime-path` regex) |
| Sliced-heredoc tests with stub engines | `deploy-qa-auto-selection.test.mjs:9-40` |

## Acceptance criteria (MUST be measurable)

| ID | Requirement | Check |
| --- | --- | --- |
| AC1 | Suite green | `node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs` exits 0 with `fail 0` |
| AC2 | Fast-forward accepted, rewind refused | A sliced `prove_explorer_fast_forward` runs against a real temporary git origin (a `file://` URL substituted in the test). `P==R` exits 0 with no fetch. A child commit exits 0 and logs `moved from P to R (fast-forward`. A sibling branch head, a rewound parent and a fetch failure each exit 1, with the mode-specific text. **Fails at base** (function absent). |
| AC3 | Exact comparisons are gone from Reconcile; the in-place pin stays exact | `rg -n '"\$\{EXPECTED_COMMITS\[AchillesIDE\]\}" != "\$EXPECTED_EXPLORER_COMMIT"\|"\$QA_EXPLORER_HEAD" != "\$EXPECTED_EXPLORER_COMMIT"' .github/workflows/deploy-explorer-qa.yml` prints nothing. The existing `qa-in-place-update` `QA_UPDATE_REMOTE_MOVED` tests still pass. |
| AC4 | Post-start race | Sliced verification loop with a stub engine. `D==expected` passes. A stub whose `merge-base --is-ancestor` exits 0 passes, logs the move, and the Verification expectation carries `D`. A stub exiting 1 fails. |
| AC5 | Route mapping | Locked-script tests:<br>• `route` returns resume → exit 44, and `select` is never called.<br>• `route` refuses → exit 1, and `select` is never called.<br>• `route` returns select → the existing behaviour.<br>• A stub node exiting 42, 43 or 44 from `route` → 1.<br>Handler: 44 writes `updated=false\noperation=resume\n`. |
| AC6 | Route table | `qa-backups.test.mjs` fixtures cover every row of contract 2. These steady states return `select`: newest backup complete, fresh-install backup, rollback marker, no backups. |
| AC7 | Resume proofs | One failing fixture per proof R2–R8, each refused with its code:<br>• `-rollback-B` missing or running<br>• `prior-containers.txt` mismatch<br>• `policy-restoration.json` present<br>• `preservation.json` `exactCopiesVerified:false` (root-only simulation: mode 000 plus a privileged hook, skipped as root)<br>• identity file differs<br>• `agents.json` present (`QA_RESUME_GRAPH_STARTED`)<br>• `.ploinky/box/other`<br>• ALA with a foreign origin<br>• B helper `plan` stub fails<br>A positive fixture modelled on the observed state returns `resume`. |
| AC8 | No stop, move, backup or prune in resume | Static test:<br>• inside `# BEGIN QA resume setup … # END` there is no `container stop`, `container rename`, `mktemp -d "$HOME/.qa-deployment-backups`, `qa-backups.mjs" prune` or `rm -rf`<br>• the preflight and retention blocks stay gated on `= redeploy`<br>• the `:1589-1832` segment sits inside `if [ "$QA_OPERATION" != resume ]` |
| AC9 | Stale receipts are archived before the holder starts | Sliced resume setup with a stale `<B>-lock-release` present. Base behaviour (holder first) gets an immediate release and fails `assert_qa_workspace_lock_held`. Candidate: the receipts move to `B/helpers/interrupted-*/`, then the lock is held. `deploy-qa-backup-whitelist.test.mjs` still passes. |
| AC10 | Resume capacity | Sliced capacity block in resume mode with stubbed `du` and `statfs`: free ≥ 4 GiB + components passes; less fails. Redeploy and update modes keep the 25 GiB / +4 GiB rule (existing tests). |
| AC11 | The tail uses the reviewed helper | `rg -c 'QA_TAIL_HELPER' .github/workflows/deploy-explorer-qa.yml` ≥ 4. No `"$QA_HELPER_DIR/rollback-explorer-qa.mjs"` remains after `:1834`. |
| AC12 | Retention and rollback interplay | Fixtures:<br>• B without `restored-selections.json` is classified `incomplete-redeploy` and retained.<br>• After both markers are written, B is `complete-redeploy`.<br>• `selectRollbackTarget` returns B with `currentId` = the new exact ID in both states. |
| AC13 | Fail-before evidence | Run `git worktree add <scratchpad>/base 1d1f147b`, copy in the new and changed tests, run them: AC2, AC5, AC7 and AC9 fail. They pass on the candidate. |
| AC14 | Lint | `actionlint .github/workflows/deploy-explorer-qa.yml`, if installed; otherwise reported as not run |
| AC15 (live, pending user approval) | Recovery | See the dispatch sequence below |

## Adversarial probes the implementer MUST run

| Category | Probe | Expected |
| --- | --- | --- |
| Boundary | `createdAt` tie between two unfinished backups; `prior-containers.txt` with a trailing space or an uppercase ID | Refused |
| Idempotency | Resume whose tail fails in `prepareBoxForCommand` with no Box left behind; fixture leaves `.ploinky/box/{images,dependencies}`, a checked-out `.runtime/ploinky`, ALA, `edge-desired.json` and moved inner lock receipts | Routes `resume` again; a second archive directory is created, nothing is lost |
| Orphan | `-rollback-B` Box removed by hand | `QA_EXACT_BOX_ABSENT_NOT_RESUMABLE` (R5) |
| Concurrency | Host lock held by another process | `route` and resume admission exit with `QA_BACKUPS_HOST_LOCK_REQUIRED` or 75; no change |
| Error injection | `git fetch --filter` rejected; registry pull failure in prepare; `sudo -n` fails during `resume-proof`; B helper `plan` returns non-JSON | Exit 1 before any mutation, or (after contract 5, step 5) the trap prints `Rollback reference … current=absent` |
| State routing | Rollback mid-way (`rollback-result.json` phase `copying-durable-state`, no exact Box) | Refused with reason `rollback-state` |

## Review, verification and gates

| Topic | Requirement |
| --- | --- |
| Route | Formal SPEC, then `plan-reviewer`. This is a recovery and resource-ownership change on a QA instance that is down. |
| Code-review slices | **S1:** `qa-backups.mjs` (`inventoryBackups`, `routeDeployment`) and `qa-backups-privileged.mjs` (`resume-proof`) with tests.<br>**S2:** workflow (fast-forward function, post-start rule, route/44, resume admission and setup, capacity, `QA_TAIL_HELPER`) with workflow tests.<br>**S3:** docs (deploy doc and DS002:92), author checks plus S2 consistency. |
| Independent verification | `implementation-verifier` runs the resume fixtures and probes on the frozen candidate |
| Candidate identity | Base `1d1f147b`. Frozen diff hash: `git -C … diff 1d1f147b -- . ':(exclude)*_claude.md' \| shasum -a 256`. |
| Gates that apply | Repository rule (`AGENTS.md:42`): docs and DS in the same change. Workspace commit policy (no AI attribution; commit and push only with authorisation). After a recreate: `AGENTS.md:115-117` and the docs' real-browser release gates (pending after the live run). `ploinky-proxy` gate: not applicable. |
| Approval vs release | Source approval allows merging, with the user's authorisation. The live recovery and browser gates stay pending until the user approves each dispatch. |

### Live recovery dispatch sequence (each step needs the user's explicit approval)

1. **Merge.** The reviewed candidate lands on `main`.
2. **Optional read-only inspect.** Dispatch `inspect-explorer-host-storage.yml`. Expect only `d4ada362…`, stopped, named `-rollback-redeploy-jQRMF7aJ`, and `availableBytes` ≥ the B6 requirement.
3. **Deploy.** Dispatch `deploy-explorer-qa.yml` with no inputs. Success markers, in the log filtered with `grep -v $'\x1b\[36;1m'`:
   - `Deployment route: …"route":"resume","backup":"redeploy-jQRMF7aJ"…`
   - no `Deployment selection:`, `Retention receipt:`, `Redeploy backup:` or `Stopping nested QA services`
   - `Resuming the preserving redeploy from redeploy-jQRMF7aJ`
   - `moved from …` when `main` moved
   - `Rollback reference: backup=redeploy-jQRMF7aJ predecessor=d4ada3623b3d… current=<64 hex>`
   - `Durable access policy … restored`
   - `Prior agent choices restored`
   - `Verification expectation: {…}`
   - `Explorer QA Box is ready.`
   - "Verify public URL" and the topology step succeed
4. **Verify runtime.** Dispatch `verify-explorer-qa-runtime.yml` with `expected` set to the Verification expectation JSON (`verify-explorer-qa-runtime.yml:5-9`); expect success.
5. **Read-only rollback plan.** Dispatch `rollback-explorer-qa.yml` with `action=plan`. Expect `backup` `redeploy-jQRMF7aJ`, `currentId` = the new ID, `"result":"planned"`.
6. **Browser gates.** Run the real-browser release gates from `docs/deploy-explorer-qa.md` (pending).

## Open questions / risks

| ID | Item |
| --- | --- |
| Q1 | See the question above the SPEC (a tail that fails after the new Box exists) |
| R1 | The R8 allowlist depends on what `prepareBoxForCommand` writes before the container exists. It is partly verified (`workspace-data.mjs:233`); the implementer must confirm it at the Ploinky head used and pin it with a test. |
| R2 | The resume lock imports the predecessor's `locks.mjs` from `B/workspace`. This is acceptable because R7 pins its source, and the lock path is the same at both Ploinky revisions (observed). |
| R3 | The fast-forward check needs GitHub support for partial fetch (inferred from git and GitHub behaviour, not tested against the host). If it is unavailable the check fails closed, and the run can be resumed again. |
| R4 | `route` adds a container listing to every deploy. It stays light: it does not run `sanitize` or image probes, except for R7 in resume. |
| R5 | B6 lowers the floor only for resume. After the move and copy are done, remaining needs are estimated from B's regenerated components; the rollback headroom is logged, not enforced. |
| R6 | After a successful resume, the next redeploy's retention prunes B (D2). Until then B is the only rollback point and is retained (`incomplete-redeploy` → `complete-redeploy`, never pruned by a resume). |

## Implementation order (build sequence)

1. `qa-backups.mjs`: extract `inventoryBackups` with no behaviour change. Checkpoint: the existing `qa-backups.test.mjs` passes.
2. `routeDeployment`, the `route` CLI, and privileged `resume-proof`, with fixtures. Checkpoint: AC6, AC7, AC12.
3. Workflow: in-place upload, route and 44 handler. Checkpoint: AC5.
4. Workflow: the fast-forward function plus the early, late and post-start rules. Checkpoint: AC2, AC3, AC4.
5. Workflow: resume admission, capacity, the `:1589` wrapper with the resume setup, and `QA_TAIL_HELPER`. Checkpoint: AC8, AC9, AC10, AC11, the contract test at `:612-625`, and the shell-parse test.
6. Docs and DS002. Then the full suite, the fail-before worktree, lint and the frozen diff hash. Checkpoint: AC1, AC13, AC14.
7. Reviews, then a request for the user's approval of the live sequence.

**Verification status:**
- I re-ran no suites for this design.
- Observed: the deploy-file diff stat, the log markers from run 39604707578, the state from inspect run 39608950538, and the Ploinky lock path and full clones at f2b2c4d1/7ff252cb.
- Not verified: R1, R3, and the exact list of lock-receipt files on the host (inferred from `:784`, `:1659`, `:1665`, `:1678`).

Saved logs are in `/private/tmp/claude-501/-Users-danielsava-work-file-parser/1bd16c61-3acd-4023-bb70-a898e65267cc/scratchpad`:
- `run-39604707578.log`
- `inspect-39608950538.log`
- `wf.yml` (a copy of the workflow at origin/main)

---

## Decisions recorded by the lead (2026-10-21)

| ID | Decision |
| --- | --- |
| Q1 | Option (a): a later dispatch that finds the exact Box present while the newest backup is an unfinished redeploy refuses with `QA_REDEPLOY_UNFINISHED` and points to the rollback workflow. No new container or runtime-state deletion code. Taken as the SPEC's conservative recommendation; it does not affect today's recovery. |
| User | "Fix the late commit check so a redeploy accepts main's newer head, and add a reviewed way for the deploy to finish a redeploy whose old Box was already retired, so QA comes back on the new code without a rollback. Ask me before dispatching." QA stays down until then (rollback declined). |

---

## Plan review outcome and implementer notes (2026-10-21)

Initial review: APPROVE with one Important fix (applied below as a targeted amendment; no further review round). These notes supersede the named contract text.

| # | Amends | Note |
| --- | --- | --- |
| I1 (Important) | Contract 3, R8 | `.ploinky/data` is created by the preservation copy (`mkdir`, deploy-explorer-qa.yml ~:1790-1808) and is never itself an entry of `copied`; `copied` holds multi-segment entries such as `.ploinky/data/master-key` and `.ploinky/edge-desired.json`. Derive the allowed first-level `.ploinky/*` names from ALL `copied` entries under `.ploinky/` (first path segment below `.ploinky`), plus `box` (⊆ {`dependencies`,`images`}); allow `.ploinky/data` whenever `B/workspace/.ploinky/data` exists, with its children ⊆ the `.ploinky/data/*` entries of `copied` and still none of `edge-routing`, `edge-publication`, `router-security`. Apply the same "derive from copied prefixes" rule at top level. Build the AC7 positive fixture by running the REAL sliced preservation block on a fixture workspace, not a hand-written `copied` list, so the allowlist is tested against what the workflow actually writes. |
| N1 | Decision A2 | Use a form of partial fetch that works on a fresh repository: `git clone --bare --filter=tree:0 --no-checkout --single-branch --branch <default> <url> <dir>` (or an explicit promisor-remote configuration) and set `GIT_NO_LAZY_FETCH=1` where supported; then `cat-file -e P^{commit}` and `merge-base --is-ancestor P R`. Any non-zero status (including 128) fails closed. AC2 must run against a real `file://` origin. |
| N2 | AC list | Update `deploy-qa-redeploy-workflow.test.mjs` (~:282, :286) when the retention-helpers block becomes `redeploy\|resume`. |
| N3 | Contract 5 | The resume setup must not contain the literal `mkdir -p "$WORK_DIR"` (it would end the `deploy-workflow-contract.test.mjs:612-625` slice early and let its `rm -rf` guard pass falsely). |
| N4 | A4 / AC4 | Treat any non-zero `merge-base` status as failure; AC4 stubs exit 1 and exit 128. |
| N5 | Contract 5 order | Take the workspace lock (step 4) BEFORE removing the stale clones (step 3), so removal happens under both the host lock and the workspace lock. Archive stale receipts first (step 2 stays first). |
| N6 | R8 top level | Allow a top-level `.env` outside `copied` only when B/workspace had none and its content is exactly the bootstrap form the tail writes (~:1858). |
| N7 | R6 | Also prove every `copied` entry still exists in the live workspace with the same type (file/dir), so a resumed run never starts on a workspace that lost preserved data. |
| N8 | Docs | Document that after a resume the rollback headroom (logged) may be smaller than a rollback needs; a disk-full rollback fails with data still in B / failed-workspace. |
