**Phase 0: one material question needs an answer before the retention placement is final (affects build step 6)**

| | |
| --- | --- |
| Question | When should the older backup and its stopped Box be pruned during an automatic redeploy? |
| Why it is open | You chose "delete the older backup once the new Box is healthy". The capacity gate (`deploy-explorer-qa.yml:1313-1314`) needs free space of at least max(25 GiB, live workspace + 4 GiB), and it runs before any backup exists. Run #200's own log shows `availableBytes 48929337344` and workspace `23959306240`, of which durableData is `13989072896` and imageCache is `9514340352`. The rename into the backup costs nothing, but the copy-back and the regenerated runtime refill the live workspace. Inferred, not observed: free space is now roughly 25 GB, while the next redeploy needs about 28.3 GB, because the roughly 24 GB backup `redeploy-HFtJQ1es` still holds the space. With pruning after health, the next automatic redeploy would probably stop at capacity admission. That failure is safe: nothing is stopped. But it repeats until the disk is resized. |
| Option A (recommended) | Prune superseded backups under the host lock. This runs after every read-only admission and the new pre-stop preflight, and before capacity admission. Then capacity is checked for real (still fatal), and only then is the new backup created. The current state is still protected, because this run's own backup captures it before anything stops. The only loss is that the rollback point from two redeploys back disappears earlier. If the run fails between the prune and the capture, QA is still running with no backup at all. |
| Option B | Keep your literal choice and prune only after health. Every redeploy then needs about 24 GB more free space, so resize the disk first. |
| Option C | B now, with an explicit operator disk resize as a prerequisite before the first automatic redeploy. |
| Evidence to refresh before deciding | Dispatch the read-only `inspect-explorer-host-storage.yml`. Its last run (2026-10-19) predates run #200. I did not dispatch it. |

The SPEC below is written for your stated decision (B). The exact change for option A is under "Open questions / risks".

---

# SPEC: Explorer QA deploy with no inputs and automatic redeploy

## Intent (1 paragraph)

`deploy-explorer-qa.yml` currently needs the operator to pick one of five operations and type a commit, a confirmation phrase, a backup name and a Box ID. The user chose "Auto redeploy" on 2026-10-21. The deploy form now has no fields:
- **QA missing:** fresh install, unchanged.
- **Only AssistOSExplorer changed, and the existing in-place updater accepts the change:** update in place with no downtime.
- **Anything else drifted:** Ploinky, any other managed repository, AdvancedLanguageAgent, the Box image, or an Explorer change the updater classifies as needing reconfiguration. The existing data-preserving redeploy runs automatically (about 20 minutes of downtime, 25 GiB floor). Only the newest backup is kept: after a healthy redeploy, older backups and the stopped Boxes provably bound to them are deleted.

Rollback moves to its own workflow with one plan/execute choice.

The governing constraint is from the 2026-10-19 design, `docs/deploy-explorer-qa.md:286`: "A failed redeploy is acceptable; lost data is not". Every decision is taken read-only before any mutation. Only an explicit, recognised drift or classification result can choose redeploy; any other updater or probe failure fails the run. Nothing is deleted unless its identity is bound to a superseded backup by name and by recorded ID. Reuse the Reconcile and redeploy code; do not rewrite it.

## Out of scope

| Item | Reason |
| --- | --- |
| `destroy-explorer-qa.yml`, `cleanup-explorer-host-storage.yml`, `verify-explorer-qa-runtime.yml`, `inspect-explorer-host-storage.yml` | Unchanged; teardown and reset stay separate |
| Capacity formula (`:1313-1314`) and the 25 GiB floor | `docs/deploy-explorer-qa.md:300` forbids lowering it |
| Disk resizing, image pruning (`rmi`), nested-cache cleanup | Host operations; the cleanup workflow owns images |
| Ploinky, `rollback-explorer-qa.mjs` recovery semantics, quiesce helper | Reused unchanged; old backups run their own frozen helper |
| Pruning after in-place updates or fresh installs | Retention runs only after a redeploy that created a newer backup |
| Renaming the internal Reconcile tokens `update` (fresh admission) and `redeploy` | Avoids churn in tests that slice the workflow text |
| `ploinky-proxy` acceptance gate | This is AssistOSExplorer `main`, not a `ploinky-proxy` branch |
| Committing, pushing, dispatching any workflow | Each needs explicit user authorization |

## Files to create

| Path | Purpose |
| --- | --- |
| `.github/scripts/qa-backups.mjs` | Backup inventory, identity-guarded retention (`prune-plan` / `prune`) and rollback-target selection (`rollback-target`), with injected runtime adapters and real filesystem behaviour, like `rollback-explorer-qa.mjs:448` |
| `.github/workflows/rollback-explorer-qa.yml` | Rollback workflow with one `action` choice (`plan`, `execute`); it auto-selects the backup and current Box, then runs the backup's own helper under the shared lock |
| `tests/smoke/lib/qa-backups.test.mjs` | Unit and fixture tests for retention and rollback selection (matches the `qa-*` glob, so it runs inside the deploy workflow) |
| `tests/smoke/lib/deploy-qa-rollback-workflow.test.mjs` | Static and sliced-heredoc tests for the new rollback workflow (matches `deploy-*`) |

## Files to modify

| Path:lines | Change |
| --- | --- |
| `.github/workflows/deploy-explorer-qa.yml:3-31` | Replace the `inputs:` block with a bare `workflow_dispatch:` |
| `…/deploy-explorer-qa.yml:54-56` | Remove the job-level `if:` that selects deploy vs rollback |
| `…/deploy-explorer-qa.yml:70-116` | Rename step to "Resolve the AssistOSExplorer main commit". Resolve `refs/heads/main` once, write `EXPECTED_EXPLORER_COMMIT` to `$GITHUB_ENV`, log the helper ref and SHA |
| `…/deploy-explorer-qa.yml:391-483` | In-place step: drop `OPERATION`, pass the pinned commit, run `select` and then `execute`, normalise updater failures to exit 1, map 43 unconditionally |
| `…/deploy-explorer-qa.yml:485-489` | Add `id: reconcile`; delete the step-level `EXPECTED_EXPLORER_COMMIT: ${{ inputs… }}` so the `$GITHUB_ENV` value applies |
| `…/deploy-explorer-qa.yml:782-799` | `tee` the remote output to `$RUNNER_TEMP/explorer-qa-reconcile.log`; accept only `update\|redeploy` in the `QA_OPERATION` case |
| `…/deploy-explorer-qa.yml:804,875-878` | Remove `QA_REHEARSAL_DIR` and its cleanup |
| `…/deploy-explorer-qa.yml:896-931` | Redeploy admission ignores stopped retained Boxes and refuses running ones |
| `…/deploy-explorer-qa.yml:1113-1146` | Record loop: skip proven retained stopped Boxes instead of exiting at `:1123-1127` |
| `…/deploy-explorer-qa.yml:1271-1372` | Capacity block: delete the rehearsal-only report branch, so the check is always fatal |
| `…/deploy-explorer-qa.yml:1481-1494` | Early expected-commit check runs for every mode (fresh install too) |
| `…/deploy-explorer-qa.yml:1495-1569` | Replace the rehearsal with a fatal pre-stop "redeploy preflight" (capture preview plus quiesce preflight, redeploy mode only), before `mkdir` at `:1571` |
| `…/deploy-explorer-qa.yml:1920-1924` | Late expected-commit check runs for every mode |
| `…/deploy-explorer-qa.yml:2657-2658, 2746-2747` | Drop the `redeploy-rehearsal` conditions |
| `…/deploy-explorer-qa.yml:2843-2844` (insert) | New step "Prune superseded redeploy backups" (`id: prune`) |
| `…/deploy-explorer-qa.yml:2845-2877` | Summary: remove the rehearsal line; add selection reasons, pinned commit, helper `github.sha` and prune receipt |
| `…/deploy-explorer-qa.yml:2879-2888` | Cleanup also removes the reconcile log and update-result files |
| `…/deploy-explorer-qa.yml:2890-3017` | Delete the `rollback` job |
| `.github/scripts/update-explorer-qa.mjs:197-268` | Add `select()`; export `assertRuntimeReady` (today's `assertReady`, `:201-204`) |
| `…/update-explorer-qa.mjs:270-309` | `execute(receipt, { expectedCommit })`: the remote Explorer head must equal `expectedCommit` before fetch or fast-forward |
| `…/update-explorer-qa.mjs:409-433` | Add adapter `remoteBoxImage(scope)` |
| `…/update-explorer-qa.mjs:597-609` | CLI: `select --expected-commit C --lock-held`; `execute --receipt R --expected-commit C --lock-held` |
| `tests/smoke/lib/deploy-qa-auto-selection.test.mjs:9-152` | Rewrite for the select-based locked script and the exit-code contract |
| `tests/smoke/lib/deploy-qa-in-place-workflow.test.mjs:12-27, 99-127` | No-inputs assertion; flock argument shape; retained-Box admission cases |
| `tests/smoke/lib/deploy-qa-redeploy-workflow.test.mjs:71-170, 174-205, 206-312, 313-325, 365-380, 381-395` | Delete the operation-validator, rollback-job and rehearsal tests; add main-resolution, preflight-ordering, unconditional-pin, summary and shell-parse tests |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:327-330` | Read the rollback job's assertions from `rollback-explorer-qa.yml` |
| `tests/smoke/lib/qa-in-place-update.test.mjs:20-123` (fixture) plus new cases | Make the fixture's `remoteDefault` keyed by repo path; add `select` and `expectedCommit` tests |
| `docs/deploy-explorer-qa.md:23-35, 49-53, 92-108, 138-143, 284-313` | Describe automatic selection, retention, the rollback workflow, and the removal of the rehearsal and operations |
| `docs/specs/DS002-ploinky-runtime.md:92` | Normative deploy contract: no `operation` input, automatic selection, retention instead of "deletes nothing" |
| `docs/architecture.html:71` | Same behaviour, summarised |
| `AGENTS.md:96-99` | Add `rollback-explorer-qa.yml` to the supported workflows |

## Interfaces / contracts

### 1. `deploy-explorer-qa.yml` dispatch

| Aspect | Contract |
| --- | --- |
| Signature | `on: workflow_dispatch:` with no inputs. No `inputs.` reference remains in the file. |
| Dispatch ref | Any ref is allowed. Helpers and tests come from the dispatched ref; the deployed AssistOSExplorer is always `main`'s head at resolution time. Summary logs `github.ref_name@github.sha` and the pinned commit. An in-file `github.ref == main` guard is rejected because it is bypassable by editing the workflow on that branch. |
| Pinned commit | The Resolve step runs `git ls-remote --exit-code --heads …AssistOSExplorer.git refs/heads/main`. It requires exactly one line with 40 lowercase hex characters and appends `EXPECTED_EXPLORER_COMMIT=<sha>` to `$GITHUB_ENV`; otherwise it exits 1 before SSH. |
| The three checks threaded through | (1) In-place `select` and `execute` require the Explorer remote head to equal it (`QA_UPDATE_REMOTE_MOVED`). (2) Reconcile `:1481-1494` before anything stops, now for all modes. (3) Reconcile `:1920-1924` after source resolution, now for all modes. |
| Concurrency | Unchanged: `group: deploy-explorer-qa`, `cancel-in-progress: false` (`:33-35`) |

### 2. Locked in-place script exit-code contract (heredoc `UPDATE`, from `:422`)

| Exit | Meaning | Produced only by |
| --- | --- | --- |
| 0 | In-place updated or verified unchanged | `execute` succeeded |
| 42 | Fresh install | Unchanged absence proof (`:447-458`) |
| 43 | Redeploy | Explicit `exit 43` after a successful `select` whose parsed `mode` is exactly `redeploy` |
| 75 | Host lock busy | Outer `flock -n -E 75` |
| 1 | Any other failure | `select … \|\| exit 1` and `execute … \|\| exit 1`. A node exit of 42 or 43 can never leak through |

The runner handler (`:471-483`) maps 43 to `updated=false` plus `operation=redeploy` with no other condition. Every other non-zero status fails with the existing "will not recreate or destroy" message.

### 3. `update-explorer-qa.mjs select`

| Aspect | Contract |
| --- | --- |
| CLI | `node update-explorer-qa.mjs select --expected-commit <40-hex> --lock-held`. It requires the host flock to be held (same probe as `:604-605`). |
| Service | `createUpdateService(adapters, scope).select({ expectedCommit }) → Promise<Selection>` |
| Order of proofs | (a) `snapshot()` (`:172-195`): exact running Box with only retained stopped siblings, clean sources, image-owned AgentLib, valid selections. No `assertReady` and no `health`, so a running but unhealthy QA can still be redeployed. (b) `adapters.remoteDefault(Explorer).commit === expectedCommit`, else `QA_UPDATE_REMOTE_MOVED`. (c) Box image drift. (d) Source drift. (e) Only when there is no drift: Explorer `candidate()` (`:237-256`) under the workspace lock, with the objects-only fetch exactly as at `:301-309`, then `assertRetained`. |
| Image drift | `adapters.remoteBoxImage()` returns `{ reference, configDigest }`. Drift when `configDigest !== current.box.image` (image ID, which is the config digest). |
| Source drift | Covers `.runtime/ploinky`, `AdvancedLanguageAgent`, and every `.ploinky/repos/*` except `AchillesIDE`. Drift when `remoteDefault(dir)` differs in `commit` or `branch` from the pin. Explicitly excluded, and never a crash: `.ploinky/agentlib/generations/*` and `achillesAgentLib`. Test both. |
| Redeploy codes from classification | Only `QA_UPDATE_REQUIRES_RECONFIGURATION`, `QA_UPDATE_UNKNOWN_RUNTIME_PATH`, `QA_UPDATE_FILE_TYPE_CHANGED`. Any other error, including `QA_UPDATE_NOT_FAST_FORWARD`, `QA_UPDATE_DEFAULT_BRANCH_REQUIRED` and adapter failures, is rethrown, so the CLI exits 1. |
| Success output (stdout, one JSON line) | `{"result":"selected","mode":"in-place"\|"redeploy","mutations":false\|"git-objects-only","expectedCommit":C,"previousCommit":P,"boxImage":{"reference":R,"current":I,"remote":D},"reasons":[{"source":".runtime/ploinky","kind":"commit"\|"branch"\|"image"\|"explorer-reconfiguration","from":X,"to":Y,"code"?:…}]}` |
| Error output | Unchanged `main` catch (`:611-618`): `{"result":"failed","status":"rejected","code":…}`, exit 1 |
| Side effects | At most one objects-only `git fetch` in `.ploinky/repos/AchillesIDE` under the workspace lock. No receipt, no working-tree change, no `fastForward`, no `restart`, no `restore`. |

### 4. `remoteBoxImage` adapter and pure helper

| Aspect | Contract |
| --- | --- |
| Reference | Import `<workspace>/.runtime/ploinky/ploinky-box/constants.mjs` and call `resolveBoxImageReference({})`. At Ploinky's default head this is `docker.io/assistos/ploinky-box:latest` (observed at ploinky `origin/HEAD` f2b2c4d1, `ploinky-box/constants.mjs:1`). Accept only `docker.io/<ns>/<repo>:<tag>` or `@sha256:<64hex>`; anything else raises `QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED`. |
| Registry calls | Anonymous token `https://auth.docker.io/token?service=registry.docker.io&scope=repository:<ns>/<repo>:pull`, then `GET https://registry-1.docker.io/v2/<ns>/<repo>/manifests/<tag\|digest>`. Accept OCI index, Docker manifest list, OCI manifest and Docker v2 manifest. Use `redirect:'error'` and a 15 s timeout. Each by-digest body must hash to its digest. |
| Pure helper | `platformConfigDigest(rootDoc, fetchByDigest, { os:'linux', architecture:'amd64' })`. For an index, pick exactly one entry with that platform, ignoring `unknown/unknown` attestation entries; for a single manifest, use it. Return `manifest.config.digest` stripped to 64 hex. |
| Host and failure | Assert `process.arch === 'x64'` (the QA host is amd64; `rollback-explorer-qa.mjs:417`). Any HTTP, parse or ambiguity failure raises `QA_SELECT_IMAGE_UNRESOLVED`, so the run fails and nothing is guessed. |

### 5. `update-explorer-qa.mjs execute`

| Aspect | Contract |
| --- | --- |
| CLI | `execute --receipt <file> --expected-commit <40-hex> --lock-held` |
| New proof | Immediately after `candidate(authority)` (`:301`): `next.commit === expectedCommit`, else `QA_UPDATE_REMOTE_MOVED`. This is thrown before the receipt, before `changed=true`, and before any fetch, so `:347` rethrows it without recovery. |
| Unchanged | All other behaviour, the recovery path and the receipts |

### 6. Reconcile retained-Box tolerance

| Aspect | Contract |
| --- | --- |
| Definition | A container is retained when its name matches `^ploinky-box-explorerqaworkspace-7a31ab7775eb-(rollback\|failed)-redeploy-[A-Za-z0-9]{8}$` and `.State.Running` is `false`. This mirrors `currentQaBox`, `rollback-explorer-qa.mjs:441-443`. |
| Redeploy admission (`:913-929`) | `labelled` counts only non-retained labelled containers and must equal 1; `named` must equal 1. A running container with a retained-pattern name fails. |
| Fresh-install admission (`:898-911`) and absence proof (`:447-458`) | Unchanged: any labelled container, retained included, refuses a fresh install |
| Record loop (`:1116-1146`) | Retained containers are logged as `[deploy-qa] Retained Box: engine=… id=… name=…` and skipped. Any other name mismatch still exits at `:1123-1127`. |

### 7. Pre-stop redeploy preflight (replaces `:1495-1569`)

| Aspect | Contract |
| --- | --- |
| Markers | `# BEGIN QA redeploy preflight` / `# END QA redeploy preflight` |
| When | `QA_OPERATION = redeploy` only |
| What runs | The existing capture-preview node block and the quiesce preflight block, verbatim in behaviour. Any failure prints `[deploy-qa] ERROR: the redeploy preflight failed; no service was stopped and no workspace file was moved.` and exits 1. |
| Ordering | It must run before `mkdir -p "$HOME/.qa-deployment-backups"` (`:1571`) and after the Node install (`:1453`). No `exit 0`. |

### 8. Prune step in the deploy workflow (option B placement)

| Aspect | Contract |
| --- | --- |
| Condition | `if: success() && steps.inplace.outputs.operation == 'redeploy'`, after "Verify dedicated connector and protected Cloudflare topology" |
| Inputs | `steps.reconcile.outputs.backup` and `steps.reconcile.outputs.current_id` |
| How Reconcile sets those outputs | Only in redeploy mode. Parse `$RUNNER_TEMP/explorer-qa-reconcile.log` and require exactly one line matching `^\[deploy-qa\] Rollback reference: backup=(redeploy-[A-Za-z0-9]{8}) predecessor=([a-f0-9]{64}) current=([a-f0-9]{64})$`, and a `Redeploy backup:` line naming the same backup. Otherwise the step fails. |
| Remote invocation | Same private-dir upload pattern as `:409-420` (`qa-backups.mjs`, `update-explorer-qa.mjs`, `rollback-explorer-qa.mjs`) under `flock -n -E 75 --close /home/admin/.qa-deployment-operation.lock`, using QA Node v24.19.0 as at `:459-467`. Runs `node qa-backups.mjs prune --keep <backup> --current-id <id> --lock-held`. |
| Outcome | Exit 0 prints the receipt. Items retained as unprovable produce `::warning::`, not a failure. Proof failures on the keep backup or the current Box exit 1, but QA itself is unaffected. |

### 9. `qa-backups.mjs`

| Function | Contract |
| --- | --- |
| `inventoryBackups(scope)` | Read-only. Lists `scope.backups` entries and classifies each:<br>• `backup`: real directory named `^redeploy-[A-Za-z0-9]{8}$`, uid = `process.getuid()`, mode `& 0o077 === 0`, realpath equal to the path.<br>• `sibling`: `^(redeploy-[A-Za-z0-9]{8})-(helpers\|lock-ready\.json\|lock-released\.json\|lock-release\|lock\.log\|lock-source\.txt\|quiesce\.log)$`.<br>• `tombstone`: `^\.pruning-redeploy-[A-Za-z0-9]{8}$`.<br>• `unrecognized`: anything else, never deleted.<br>Parses `rollback-authority.json`, `prior-containers.txt`, `preservation.json` and `rollback-result.json` when present. |
| `prunable(backup)` | Entries ⊆ {`helpers`, `prior-containers.txt`, `rollback-authority.json`, `preservation.json`, `workspace`, `quiesce.log`, `quiesce-source.mjs`, `lock-ready.json`, `lock-released.json`, `lock-release`, `lock.log`, `lock-source.txt`, `rollback-result.json`, `failed-workspace`}. If `workspace/` exists, `preservation.json` must have `exactCopiesVerified===true` and `source===<backup>/workspace`; workspace without that receipt means a crash between `:1738` and `:1802` and is never prunable. If `rollback-result.json` or `failed-workspace/` exists, the journal must have `result==='recovered'` and `phase==='complete'`. The backup's dev must equal the backups root's dev, and its inode must differ from the live workspace's. An empty directory is prunable. |
| Box binding | A Box is deletable only when it is stopped, passes `sanitize` (QA labels), is named exactly `<scope.box>-rollback-<B>` with ID equal to the ID in `B/prior-containers.txt`, or `<scope.box>-failed-<B>` with ID equal to `B/rollback-result.json.failedId`, and `B` is being pruned. Never bind by authority ID alone; an aborted attempt records the live Box as its predecessor. Unbound retained Boxes are reported as `retainedUnproven`. |
| `createRetentionService(adapters, scope).plan({ keep, currentId })` | Proofs:<br>• `keep` is a prunable-shaped backup with `preservation.json` and with a stopped `<box>-rollback-<keep>` Box whose ID equals `keep/prior-containers.txt`.<br>• `currentQaBox(adapters.boxes()).box.id === currentId`, and the current Box is running.<br>• `assertRuntimeReady(await runtime(current))` and `await health(current)` succeed.<br>• No backup has an authority `createdAt` later than keep's; otherwise `QA_RETENTION_NEWER_BACKUP`.<br>Returns `{ result:'planned', mutations:false, keep, removeBackups:[…], removeSiblings:[…], removeTombstones:[…], removeBoxes:[{engine,id,name}], retained:[{name,reason}], unrecognized:[…] }`. |
| `execute(...)` | Re-run `plan`. Then:<br>1. For each Box: re-inspect the same ID, name, stopped state and contract, then `<engine> container rm <id>` (no `-f`, no `-v`).<br>2. For each backup: `fs.renameSync(B, <root>/.pruning-<name>)` (atomic, same directory), then `sudo -n rm -rf --one-file-system -- <exact tombstone>`. Before the `rm`, a `sudo -n /usr/bin/node` assert checks dirname, regex, not a symlink, realpath and dev, as at `:1708-1722`.<br>3. Remove siblings and tombstones the same way.<br>Replay is idempotent: leftover tombstones are removed first, and the second run's lists are empty.<br>Output: `{ result:'pruned', … }`. |
| `selectRollbackTarget(adapters, scope)` | Read-only. An eligible backup has helpers (`node-runtime-path`, `rollback-explorer-qa.mjs` as regular files), an authority, a predecessor ID in `prior-containers.txt`, and no `rollback-result.json`. It must also have either `preservation.json`, or a predecessor Box with that ID that exists and is stopped. Choose the eligible backup with the greatest authority `createdAt`; none gives `QA_ROLLBACK_TARGET_NONE`. `currentId` is `absent` when no exact-name Box exists or when its ID equals the predecessor; otherwise it is that ID, and more than one exact-name Box gives `QA_BOX_AMBIGUOUS`. Output: `{ result:'selected', backup, currentId, predecessorId, candidates:[{name,createdAt,eligible,reason}] }`. |
| CLI | `prune-plan\|prune --keep <name> --current-id <64hex> [--lock-held]`, `rollback-target --lock-held`. Mutating modes require the held flock (probe as `update-explorer-qa.mjs:604-605`). |

### 10. `rollback-explorer-qa.yml`

| Aspect | Contract |
| --- | --- |
| Inputs | `action`: choice `plan` \| `execute`, default `plan`. No other inputs. |
| Concurrency | `group: deploy-explorer-qa`, `cancel-in-progress: false`; `timeout-minutes: 120` |
| Steps | Checkout (`persist-credentials: false`); validate `action`; pin SSH (copy of `:2939-2957`); upload `qa-backups.mjs` and `rollback-explorer-qa.mjs` to a private `/tmp/explorer-qa-rollback.XXXXXXXX`; one locked SSH session (`flock -n -E 75 --close …lock bash -s -- <dir> <action>`); cleanup; summary. |
| Locked session | QA tools Node runs `qa-backups.mjs rollback-target --lock-held`. Validate `backup` against `^redeploy-[A-Za-z0-9]{8}$` and `currentId` against `^([a-f0-9]{64}\|absent)$`. Apply the backup-helper checks from `:3000-3010`. Run the backup's own helper `plan … --current-id <id> --lock-held`. If the action is `execute`, then run the same helper with `execute`. |

## Data flow

A representative dispatch where Ploinky has drifted (QA today runs 7ff252cb; ploinky `origin/HEAD` is f2b2c4d1):

1. "Resolve the AssistOSExplorer main commit" (`deploy-explorer-qa.yml:70-116`, rewritten) pins `EXPECTED_EXPLORER_COMMIT`. The tests at `:123-125` run, then configuration and Cloudflare validation (`:127-378`) as today.
2. The in-place step (`:391-483`) uploads helpers and takes the host flock. Absence is disproved (`:447-458`). `update-explorer-qa.mjs select` calls `snapshot()` (`:172-195`), proves the Explorer head equals the pin, finds `.runtime/ploinky` commit drift via `remoteDefault`, and returns `mode:"redeploy"` without fetching. The script exits 43 and the handler writes `updated=false` and `operation=redeploy`.
3. Reconcile (`:485-2655`): redeploy admission tolerates the stopped `…-rollback-redeploy-HFtJQ1es` (contract 6). The record loop skips it. Preservation admission and capacity admission run, then the Node install, the early pin check (`:1481`), and the new fatal preflight (contract 7). After that the existing backup, quiesce, move and copy (`:1571-1814`), the late pin check (`:1920`), Box start and readiness, and the `Rollback reference` line (`:2133`) are captured through `tee`. Outputs: `backup`, `current_id`.
4. "Verify public URL" (`:2657`) and the Cloudflare topology check (`:2746`) pass.
5. The prune step runs `qa-backups.mjs prune --keep <new> --current-id <fresh id>`. `plan` re-proves keep, the current Box, readiness and loopback health. It deletes `redeploy-HFtJQ1es` and its bound Box `c4530a81…`, plus the five helper-only backups from run #200's inventory (no workspace, no bound Boxes). It then prints the receipt.
6. The summary step records mode, reasons, pinned commit, helper SHA and the prune receipt.

## Reused patterns

| Pattern | Location (opened) |
| --- | --- |
| Private remote temp dir, helper upload, `flock -n -E 75 --close` locked heredoc | `deploy-explorer-qa.yml:409-424` |
| Absence or update locked script, sliced and run with stub engines in tests | `deploy-qa-auto-selection.test.mjs:9-44` |
| Service with injected adapters plus a real-filesystem fixture that records events | `qa-in-place-update.test.mjs:20-123` |
| `prove(condition, code)` / `requireProof` safe error codes | `update-explorer-qa.mjs:29-31`, `rollback-explorer-qa.mjs:71` |
| Retained-Box name rule | `rollback-explorer-qa.mjs:438-446` |
| Held-flock probe for mutating CLI modes | `update-explorer-qa.mjs:603-606` |
| Root node asserts on exact backup paths before privileged file operations | `deploy-explorer-qa.yml:1708-1722` |
| Backup-root inventory filters (name regex, owner, no symlink) | `deploy-explorer-qa.yml:1325-1348` |
| Pinned SSH identity for a second job or workflow | `deploy-explorer-qa.yml:2939-2957` |
| Exec of the backup's own frozen helper with its own Node | `deploy-explorer-qa.yml:2998-3011` |
| Objects-only fetch under the workspace lock, then `assertRetained` | `update-explorer-qa.mjs:301-309` |

## Acceptance criteria (MUST be measurable)

Run all commands from `/Users/danielsava/work/file-parser/AssistOSExplorer`.

| ID | Requirement | Check |
| --- | --- | --- |
| AC1 | Suite green | `node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs` exits 0 with `fail 0`. Baseline at efbbfcb7, observed on this Mac with Node v25.8.0: 367 tests, 364 pass, 3 skipped, 0 fail. |
| AC2 | No fields | `rg -n 'inputs' .github/workflows/deploy-explorer-qa.yml` prints nothing. The test "deploy dispatch has no inputs and no inputs. reference" passes. |
| AC3 | Old operations gone from contracts | `rg -n 'redeploy-rehearsal\|rollback-plan\|rollback-execute\|expected_explorer_commit\|rollback_current_id\|rollback_backup\|confirm:' .github docs/deploy-explorer-qa.md docs/specs docs/architecture.html AGENTS.md` prints nothing |
| AC4 | Explorer-only change updates in place | `qa-in-place-update` test "select chooses in-place for an asset-only Explorer change and records no mutation" passes. Its events contain no `fast-forward`, `restart` or `restore`, and no receipt file exists. |
| AC5 | Ploinky, other-repo and ALA drift redeploy without fetching | Tests "select redeploys on <source> commit drift" for `.runtime/ploinky`, `.ploinky/repos/webmeet` and `AdvancedLanguageAgent`, plus "…branch drift", pass, with `events` = `[]` |
| AC6 | Manifest/reconfiguration redeploy is proven pre-mutation | Test "select redeploys on QA_UPDATE_REQUIRES_RECONFIGURATION after an objects-only fetch": events ⊆ `['lock','fetch','unlock']`, Explorer pin unchanged, no receipt. The same holds for `QA_UPDATE_UNKNOWN_RUNTIME_PATH` and `QA_UPDATE_FILE_TYPE_CHANGED`. |
| AC7 | Other failures never fall through | Tests show `select` rejects with exit-1 semantics for `QA_UPDATE_NOT_FAST_FORWARD`, `QA_UPDATE_DEFAULT_BRANCH_REQUIRED`, `QA_SOURCE_NOT_CLEAN`, `QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED`, `QA_SELECT_IMAGE_UNRESOLVED` and `remoteDefault` throwing. The locked-script test with a stub node exiting 43 from `select` and from `execute` returns 1, never 43 or 42. |
| AC8 | Image drift detection | Pure tests of `platformConfigDigest`: an index with amd64, arm64 and `unknown/unknown` returns the amd64 config; a single manifest returns its config; two amd64 entries throw; a digest-mismatched body throws. `select` with a different `configDigest` returns `kind:"image"` and redeploys. |
| AC9 | Pinned commit threaded | Test: `execute` with remote head ≠ `expectedCommit` throws `QA_UPDATE_REMOTE_MOVED`, with events `['lock','unlock']` and no fetch. Workflow tests: the Resolve step writes `EXPECTED_EXPLORER_COMMIT=<sha>` to `GITHUB_ENV` from a stubbed `git ls-remote` and exits 1 on 0, 2 or malformed lines. Neither pin check (`:1481`, `:1921`) is gated on `QA_OPERATION`. The Reconcile step has no `EXPECTED_EXPLORER_COMMIT:` step-env line. |
| AC10 | Second redeploy admitted beside a retained Box | `deploy-qa-in-place-workflow` test: running exact Box plus stopped `…-rollback-redeploy-AbCd1234` gives redeploy admission status 0. A running `…-rollback-redeploy-AbCd1234` fails. The record loop with a stopped retained Box logs `Retained Box:` and continues. **Fails at base** (`exactly one existing QA Box`). |
| AC11 | Retention deletes only bound artifacts | `qa-backups.test.mjs` with a real tmp backups root, after `execute`:<br>• keep and its `-rollback-<keep>` Box remain.<br>• An older complete backup and its bound Box are gone.<br>• A helper-only backup is gone.<br>• A Box named `-rollback-<old>` whose ID ≠ `prior-containers.txt` remains (`retainedUnproven`).<br>• A backup with `workspace/` and no `preservation.json` remains.<br>• A backup with `rollback-result.json` phase `copying-durable-state` remains.<br>• An unrecognized file remains.<br>• The live workspace dir and its inode are untouched. |
| AC12 | Retention needs a healthy current Box | Tests: `plan` throws when `currentId` ≠ the running exact Box, when `assertRuntimeReady` fails, when `health` throws, and when another backup's `createdAt` > keep's (`QA_RETENTION_NEWER_BACKUP`). In each case nothing is deleted. |
| AC13 | Prune is placed after health and only after a redeploy | Workflow test: the prune step's index is after "Verify dedicated connector…", and its `if:` is `success() && steps.inplace.outputs.operation == 'redeploy'` |
| AC14 | Rehearsal checks run implicitly before any stop | Workflow test: `# BEGIN QA redeploy preflight` lies between `Verified QA-scoped Node v24.19.0` and `mkdir -p "$HOME/.qa-deployment-backups"`. No `exit 0` inside it. A sliced preflight with a non-pass quiesce receipt exits 1 and prints `no service was stopped`. The capacity block has no `rehearsal` identifier (`rg -n rehearsal .github/workflows/deploy-explorer-qa.yml` prints nothing). |
| AC15 | Rollback workflow | `deploy-qa-rollback-workflow.test.mjs`:<br>• Only input `action` with options `plan`, `execute` and default `plan`.<br>• `group: deploy-explorer-qa` and the flock prefix are present.<br>• `ssh-keyscan` appears exactly once and is compared against `$SSH_ED25519_FINGERPRINT`.<br>• The heredoc parses with `bash -n`.<br>• With a stub selector it runs the backup's helper `plan` then `execute` for `execute`, and only `plan` for `plan`.<br>• It exits non-zero on a malformed selector backup or ID. |
| AC16 | Rollback auto-selection | `qa-backups.test.mjs`:<br>• Newest eligible by `createdAt` is chosen.<br>• An aborted attempt (no `preservation.json`, predecessor still running) is ineligible.<br>• `currentId` is `absent` when the exact Box ID equals the predecessor or no exact Box exists, otherwise the exact ID.<br>• Zero eligible gives `QA_ROLLBACK_TARGET_NONE`.<br>• Two exact-name Boxes give `QA_BOX_AMBIGUOUS`. |
| AC17 | Old job removed and contract test retargeted | `rg -n '^  rollback:' .github/workflows/deploy-explorer-qa.yml` prints nothing. `deploy-workflow-contract.test.mjs` reads the rollback assertions from `rollback-explorer-qa.yml` and passes. |
| AC18 | Docs consistent | `rg -n 'Nothing is deleted\|deletes nothing\|make a second .redeploy. fail\|retained predecessor Boxes require explicit review' docs AGENTS.md` prints nothing. `rg -n 'rollback-explorer-qa.yml' AGENTS.md docs/deploy-explorer-qa.md` prints at least 2 lines. |
| AC19 | Fail-before evidence | `git -C /Users/danielsava/work/file-parser/AssistOSExplorer worktree add <scratchpad>/base efbbfcb7bc7486dfc27a479dc590e553b1882ad2`. Copy only the new or changed test files there and run `node --test` on them. AC10, AC5, AC9 and AC2 tests fail at base; the same files pass on the candidate. Record both outputs. |
| AC20 | Workflow lint | `actionlint .github/workflows/deploy-explorer-qa.yml .github/workflows/rollback-explorer-qa.yml` exits 0, if available. Observed: actionlint is not installed on this Mac, so report it as not run unless installed. |
| AC21 (live, pending user dispatch) | Auto selection and retention on QA | First dispatch after merge:<br>• Log has one `[deploy-qa] Deployment selection:` JSON with `"mode":"redeploy"` and a `.runtime/ploinky` reason.<br>• Prune receipt `removedBackups` includes `redeploy-HFtJQ1es`, and `removedBoxes` includes `c4530a81692c…`.<br>• A later `inspect-explorer-host-storage.yml` shows exactly one `redeploy-*` directory and one `…-rollback-…` Box.<br>Second dispatch with nothing changed upstream: `"mode":"in-place"`, updater `status:"unchanged"`, and no `image` reason, which proves the digest comparison does not loop. |

## Adversarial probes the implementer MUST run

| Category | Probe | Expected |
| --- | --- | --- |
| Boundary | Backup names `redeploy-AbCd123`, `redeploy-AbCd12345`, `redeploy-AbCd123€`, `Redeploy-AbCd1234`; Box name `<box>-rollback-redeploy-AbCd1234-x`; `--current-id` of 63 hex, uppercase, or `absent` passed to `prune` | Not classified as backups or retained Boxes, or rejected with `QA_*` usage codes; nothing deleted |
| Boundary | Empty backups root, absent backups root, keep as the only entry | `prune` prints empty remove lists and exits 0; absent root fails the keep proof |
| Idempotency | Run `prune` twice; interrupt after the tombstone rename (simulate by leaving `.pruning-redeploy-X`) | Second run is a no-op; the tombstone is removed on replay; keep untouched |
| Orphan | `<box>-rollback-redeploy-ZZZZZZZZ` stopped with no backup dir; `prior-containers.txt` naming a nonexistent ID | Box listed `retainedUnproven`; no `container rm` call |
| Concurrency | Hold `/home/admin/.qa-deployment-operation.lock` (fixture lock path) while running `select`, `execute`, `prune` and `rollback-target` in mutating mode | `QA_*_HOST_LOCK_REQUIRED` or flock exit 75; no events. Static check that both workflows share `group: deploy-explorer-qa` |
| Error injection | Registry 401, 500, HTML body, index without amd64, by-digest body hash mismatch; `git ls-remote` failure for one non-Explorer repo; malformed `rollback-authority.json`; `preservation.json` with `exactCopiesVerified:false` | `select` exits 1 (never 43). Malformed or unverified backups are retained and reported; nothing else is affected |
| Data protection | Backup dir that is a symlink to the live workspace; backup whose inode equals the live workspace's; a backup on another device (bind-mount fixture if feasible, otherwise inject `dev`) | Refused before any rename or `rm` |

## Review, verification and gates

| Topic | Requirement |
| --- | --- |
| Route | Formal SPEC, then independent plan review (`plan-reviewer`, Opus High). The change adds automatic irreversible deletion of backups and Boxes, and it changes recovery and selection behaviour. Q1 must be answered first. |
| Code-review slices (`code-reviewer`, Opus High) | **S1:** `update-explorer-qa.mjs` select, expected commit and image adapter, plus `qa-in-place-update` tests.<br>**S2:** `qa-backups.mjs`, its tests and the prune step. This is the highest risk slice: data deletion.<br>**S3:** deploy workflow edits, new rollback workflow and workflow tests.<br>Docs and the DS002 edit go with S3 for contract consistency. A formatting-only follow-up needs author checks only. |
| Independent verification | `implementation-verifier` on S2 runs the adversarial probes above against fixtures. Runtime claims that cannot be verified pre-merge are AC21 (live selection, live prune, digest non-loop). They stay pending until the user dispatches. |
| Test runner | `test-runner` executes AC1, AC19 and AC20 on the frozen candidate. The workflow itself also re-runs AC1 on Ubuntu with Node 24 (`:118-125`). |
| Candidate identity | Repo `/Users/danielsava/work/file-parser/AssistOSExplorer`, branch `main`, base `efbbfcb7bc7486dfc27a479dc590e553b1882ad2`. Frozen diff: `git -C … diff efbbfcb7… -- . ':(exclude)*_claude.md' \| shasum -a 256`, recorded at review time. Untracked or staged `*_claude.md` notes are excluded. |
| Applicable gates | Repository rule `AssistOSExplorer/AGENTS.md:42`: update the HTML docs and DS files in the same change. Workspace commit policy: no AI attribution, human author only, and commits need user authorization. After a recreate, `AGENTS.md:115-117` and `docs/deploy-explorer-qa.md` require checking the exact outer bindings, in-Box listener ownership, local Router behaviour and the real-browser release gates. These apply to the first live redeploy and stay pending. The `ploinky-proxy` gate does not apply. |
| Approval vs release | Source approval (AC1 to AC20 plus reviews) unlocks merging to `main` once the user authorizes commit and push. The live checks (AC21 and the post-recreate browser gates) stay pending until the user dispatches the workflow. |

## Open questions / risks

| ID | Item |
| --- | --- |
| Q1 (material, blocks step 6) | Prune timing versus capacity; see Phase 0 above. Option A changes these things:<br>• The prune moves from the post-health step into the Reconcile remote script. It is passed in as `QA_BACKUPS_SOURCE` plus a SHA, like `QA_ROLLBACK_SOURCE` at `:745-746` and `:947`.<br>• It is called as `prune --keep none --current-id <live id>` after the preservation admission (`:1269`) and the new preflight.<br>• The capacity admission block moves after the prune.<br>• The keep proof is replaced by "the live exact Box is the predecessor about to be captured".<br>• AC13 becomes "preflight < prune < capacity < mkdir backups".<br>The identity rules in contract 9 are unchanged. |
| R1 | Most deploys will be redeploys. Ploinky, webmeet and other repos move often (QA runs Ploinky 7ff252cb; ploinky `origin/HEAD` is f2b2c4d1 as of 2026-10-21). Each redeploy means about 20 to 23 minutes of downtime (run #200 took 23 minutes). The first dispatch after merge will be a redeploy, will exercise contract 6, will probably hit Q1, and will be the first live prune. |
| R2 | Image comparison assumes the Box's outer image ID equals the registry config digest. This is inferred from podman semantics, not verified on the host. If wrong, every dispatch redeploys; the second dispatch in AC21 detects this. A registry outage fails every deploy, including Explorer-only ones. |
| R3 | Deletion is irreversible. After pruning, only the newest backup can roll back, so the state from two redeploys back is gone. User-approved. |
| R4 | `select` requires a running exact Box (`snapshot()`). A fully stopped QA Box fails the run, with no automatic redeploy; recovery is the rollback workflow or explicit operator action. |
| R5 | After a rollback, the next deploy dispatch will automatically redeploy forward if anything differs from the remote heads. The docs must say to fix the cause before re-dispatching. |
| R6 | Dispatch from a non-main ref runs that ref's helpers and tests against QA while deploying `main`. This is kept deliberately so workflow changes can be tested. |
| R7 | Rollback auto-selects the newest eligible backup by `createdAt`, with no override input. If two eligible backups exist after a failed redeploy, the latest one is used. `plan` output lists all candidates; dispatch `plan` before `execute`. |
| R8 | Unverified: how `destroy-explorer-qa.yml` treats retained `-rollback-` Boxes. Not changed here. |
| R9 | The prune is non-fatal for unprovable items, so a protected or odd backup can keep occupying space. It is surfaced as `::warning::` and in the summary. |

## Implementation order (build sequence)

1. **`update-explorer-qa.mjs`:** add `expectedCommit` to `execute` and the CLI; export `assertRuntimeReady`. Checkpoint: `node --test tests/smoke/lib/qa-in-place-update.test.mjs` passes, including the new AC9 test.
2. **`update-explorer-qa.mjs`:** add `select()`, `remoteBoxImage` and `platformConfigDigest`; make the fixture's `remoteDefault` per-path. Checkpoint: AC4 to AC8 tests pass in `qa-in-place-update.test.mjs`.
3. **Deploy workflow, part 1:** remove inputs and the job `if:`; rewrite the Resolve step and the in-place locked script and handler; delete the rollback job; update the auto-selection, in-place-workflow and contract tests. Checkpoint: AC2, AC7 (locked script), AC9 (workflow side), AC17; `node --test tests/smoke/lib/deploy-*.test.mjs` is green.
4. **Deploy workflow, part 2:** retained-Box admission and record loop; fatal preflight replacing the rehearsal; always-fatal capacity; unconditional pin checks; `tee` and Reconcile outputs. Checkpoint: AC10, AC14, plus the shell-parse test.
5. **`qa-backups.mjs`** (inventory, retention plan and execute, rollback target) and `qa-backups.test.mjs`. Checkpoint: AC11, AC12, AC16 and the adversarial probes.
6. **Prune step placement. Gated on Q1:** option B as specified, or option A's changes. Checkpoint: AC13 (or its option A form).
7. **`rollback-explorer-qa.yml`** and `deploy-qa-rollback-workflow.test.mjs`. Checkpoint: AC15.
8. **Docs:** `docs/deploy-explorer-qa.md`, DS002:92, `architecture.html:71`, `AGENTS.md:96-99`. Checkpoint: AC3, AC18.
9. **Full suite, fail-before worktree run, lint, frozen diff hash, then reviews.** Checkpoint: AC1, AC19, AC20, plus the recorded hash.

---

**Status:** nothing was implemented, committed or dispatched. I read the files and ran the existing tests: `node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs` at efbbfcb7 gave 367 tests, 364 pass, 3 skipped, 0 fail. I also read run #200's log with `gh run view 39448408098 --log`.

Still unverified:
- Current free disk space on QA (Q1).
- That the image ID equals the config digest (R2).
- The destroy workflow's handling of retained Boxes (R8).
- Which 3 baseline tests are skipped.

Key files:
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/workflows/deploy-explorer-qa.yml`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/scripts/update-explorer-qa.mjs`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/scripts/rollback-explorer-qa.mjs`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/docs/deploy-explorer-qa.md`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/docs/specs/DS002-ploinky-runtime.md`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/tests/smoke/lib/`

---

## User decisions (2026-10-21)

| ID | Decision |
| --- | --- |
| D1 | "Auto redeploy": no dispatch fields; Explorer-only change → in place; any other drift → automatic preserving redeploy; absent → fresh install; rollback in its own workflow. |
| D2 (answers Q1) | Option A, "Before the new backup": after the read-only admissions and the pre-stop preflight pass, and only when the current QA Box is proven healthy (`assertRuntimeReady` + `health`), prune older backups and their bound stopped Boxes under the host lock; then run the (still fatal) capacity admission, then create the new backup. When the current QA is not healthy, pruning is skipped (older backups are kept) and the run continues to the capacity gate, which may then fail safely. Contract 8 / AC13 change to option A's form ("preflight < prune < capacity < mkdir backups"). |

---

# Revision r2 (supersedes the named sections of the r1 SPEC)

Everything below was re-checked against base `efbbfcb7bc7486dfc27a479dc590e553b1882ad2` in read-only mode. It implements user decision D2 (option A: prune before the capacity gate, only while the current QA Box is proven healthy) and fixes B1, B2, M1, M2 and the minor findings. Sections not named here remain as in r1.

## r2 change map

| Finding | Superseded or added sections |
| --- | --- |
| B1 (backup whitelist derived from real writes; root-owned receipts; one privileged process) | Contract 9 (replaced); Files to create and Files to modify (delta); AC11 (replaced); new AC22 and AC23 |
| B2 (never auto-prune a backup with rollback markers) | Contract 9 classification table; AC11; new AC24; Risks R10 |
| M1 (full option A contract) | Contract 8 (replaced); Data flow steps 3 and 5 (replaced); AC12, AC13 and AC21 (replaced); new AC25 and AC26; Implementation order steps 4 to 6 (replaced); the r1 post-health prune step is dropped |
| M2 (rollback selection) | Contract 9 `selectRollbackTarget` (replaced); AC16 (replaced) |
| Minors | AC2 (replaced); late-pin wording in Files to modify; anonymous-volume decision in contract 9; Risk R11 (stuck states); note that no `sudo -n rm` is used |
| Q1 | Resolved by D2. Remove Q1 from Open questions. |

## Observed facts this revision depends on

| Fact | Source (opened) |
| --- | --- |
| Backup writes in the workflow (inner) | `$QA_BACKUP_DIR/prior-containers.txt` (capture, `:1672-1673`); `helpers` (moved at `:1679`); `preservation.json` (`:1802`, written inside `sudo -n /usr/bin/node` at `:1708`, mode `0o600`, root-owned); `workspace` (rename at `:1738`); `quiesce.log` (`:1808`); `quiesce-source.mjs` (`:1809`); `lock-ready.json`, `lock-released.json`, `lock-release`, `lock.log`, `lock-source.txt` (moved inside by the loop at `:2081-2083`); `policy-restoration.json` (`:2165`, inside `sudo -n /usr/bin/node` at `:2142`, `0o600`, root-owned); `restored-selections.json` (`:2536`, admin node, `0o600`) |
| Backup writes in the workflow (siblings `<backup>-<suffix>`) | `-lock-ready.json` (`:1641`); `-lock-released.json` (`:1647`); `-lock-release` (`:820`); `-lock.log` (`:1660`); `-lock-source.txt` (`:1612`); `-quiesce.log` (`:1698`); `-helpers` (`QA_HELPER_DIR="${QA_BACKUP_DIR}-helpers"`, `:1576`, until the move at `:1679`) |
| Backup writes by the rollback helper | `rollback-authority.json` and `prior-containers.txt` (`rollback-explorer-qa.mjs:503-505`); `rollback-result.json`, plus temporaries `rollback-result.json.<16 hex>` renamed over it (`:569-575`); `failed-workspace` (`:606`); `paths()` names `workspace`, `failed-workspace`, `rollback-result.json` (`:455-456`) |
| A fresh install also creates a backup | `mkdir -p "$HOME/.qa-deployment-backups"` and `QA_BACKUP_DIR="$(mktemp -d …)"` at `:1571-1573` run in every mode; the capture writes an empty `prior-containers.txt` when there is no predecessor (`rollback-explorer-qa.mjs:504-505`) |
| Run #200 used the same workflow and helper | `git log 4a572075..efbbfcb7 -- .github/workflows/deploy-explorer-qa.yml .github/scripts/rollback-explorer-qa.mjs` is empty, and 4a572075's workflow contains `policy-restoration.json` and `restored-selections.json`. So `redeploy-HFtJQ1es` should carry all three completion markers. This is inferred: the files were not observed on the host. |
| `/usr/bin/node` on QA is v20 | Run #200 capacity line: `"nodeVersion":"v20.20.0","nodeExecutable":"/usr/bin/node"` |
| Current order in the Reconcile remote script | Preservation admission `:1182-1269` → capacity `:1270-1372` → Node install `:1374-1456` → `resolve_default_branch` `:1458-1479` → early pin `:1481-1494` → rehearsal `:1495-1569` → backup `mkdir` `:1571` |
| The protected-resource snapshot includes unlabelled volumes | `snapshot_protected_resources` skips only volumes labelled with the QA hash or prefixed `${qaName}-` (`:1080-1092`). It is taken at `:1101` and compared after the deploy at `:2645-2649`. |
| Existing contract test | `deploy-workflow-contract.test.mjs:612-625` slices from `declare -a QA_CONTAINER_RECORDS` to the next `mkdir -p "$WORK_DIR"` and asserts `doesNotMatch(cleanup, /rm\s+-rf\|rm\s+-fr/)` |
| Cleanup workflow cannot remove backups | `cleanup-explorer-host.mjs:12` lists `PATH_NAMES = ['explorerQaWorkspace', '.qa-e2e', …]`; it has no `.qa-deployment-backups` entry |
| Comment containing "inputs" | `deploy-explorer-qa.yml:2125`: `# Without SSH, this line is the only source of the recovery inputs.` |

## Files to create (r2, replaces r1 table)

| Path | Purpose |
| --- | --- |
| `.github/scripts/qa-backups.mjs` | Admin-side module. It holds the health gate, the `prune` orchestration (it calls the privileged module through `sudo`, then removes the bound Boxes with the admin's rootless engine), `rollback-target` selection, and exports `BACKUP_INNER_ENTRIES` and `BACKUP_SIBLING_SUFFIXES`. It imports `./rollback-explorer-qa.mjs` and `./update-explorer-qa.mjs`. |
| `.github/scripts/qa-backups-privileged.mjs` | Root-side module. It imports only Node built-ins and stays compatible with Node 20 (`/usr/bin/node` is v20.20.0). In one process it classifies every backup, including the root-owned receipts, and deletes the prunable ones. |
| `.github/workflows/rollback-explorer-qa.yml` | As in r1 contract 10, with the M2 selection |
| `tests/smoke/lib/qa-backups.test.mjs` | Fixture tests for classification, privileged deletion, Box binding, health skip and rollback selection |
| `tests/smoke/lib/deploy-qa-rollback-workflow.test.mjs` | As in r1 |
| `tests/smoke/lib/deploy-qa-backup-whitelist.test.mjs` | Contract test: extracts every backup write from the workflow and the rollback helper and compares the set with the exported whitelist |

## Files to modify (r2 delta rows; other r1 rows unchanged)

| Path:lines | Change |
| --- | --- |
| `deploy-explorer-qa.yml:743-770` | Also transfer `QA_BACKUPS_SOURCE`/`_SHA`, `QA_BACKUPS_PRIVILEGED_SOURCE`/`_SHA` and `QA_UPDATE_SOURCE`/`_SHA` through `write_shell_var`, using the same pattern as `QA_ROLLBACK_SOURCE` and `QA_ROLLBACK_SHA` at `:745-746` and `:767-768` |
| `deploy-explorer-qa.yml:856-880` | `cleanup_remote_files` removes the exact files in `QA_RETENTION_DIR` and then runs `rmdir`. Drop `QA_CAPACITY_LOG` (line 800, lines 872-874, line 1270, and the `tee` at 1271), because only the deleted rehearsal read it. |
| `deploy-explorer-qa.yml:943-950` | Verify the three new SHA values after sourcing, as the existing checks do at `:943-950` |
| `deploy-explorer-qa.yml:1270-1372` | Move the capacity admission block, unchanged apart from removing the rehearsal branch, to just before `:1571` and after the new retention block |
| `deploy-explorer-qa.yml:1374-1456` | Node install stays in place textually; after the capacity block moves out, it runs directly after the preservation admission |
| `deploy-explorer-qa.yml:1495-1569` | Fatal preflight (r1 contract 7), followed by the new `# BEGIN QA superseded backup retention` / `# END …` block (contract 8) |
| `deploy-explorer-qa.yml:1920-1924` | The late pin check is unconditional. Message by mode: in `redeploy` keep "…; the retained backup $QA_BACKUP_DIR can be rolled back."; in `update` (fresh install) say "…; nothing was started and no prior installation existed." |
| `deploy-explorer-qa.yml` r1 "prune step" (r1 insert at `:2843`) | **Dropped.** There is no post-health prune step and no `id: reconcile` outputs. The `tee` to `explorer-qa-reconcile.log` is also dropped, because nothing parses it any more. |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:612-625` | Keep the `rm -rf` assertion, which the new block satisfies because deletion happens in the privileged module and not in shell. Add an assertion that the slice calls `qa-backups.mjs" prune --current-id` exactly once, inside `if [ "$QA_OPERATION" = redeploy ]`. |
| `docs/deploy-explorer-qa.md` (r1 rows) | Also document the retention classes (contract 9), that retained backups are removed only by a manual, user-authorized SSH operation (the cleanup workflow does not cover backups), and the stuck states in R11 |

## Interfaces / contracts: contract 8 (replaced): retention inside Reconcile, option A

| Aspect | Contract |
| --- | --- |
| Exact order in the Reconcile remote script | (1) `assert_qa_install_admission` (`:896-932`); (2) env source and SHA checks (`:935-950`, plus three new checks); (3) target validations (`:952-1051`); (4) protected snapshot "before" (`:1099-1102`); (5) container and volume records with retained-Box tolerance (`:1113-1181`); (6) preservation admission (`:1182-1269`); (7) Node install (`:1374-1456`); (8) `resolve_default_branch` (`:1458-1479`); (9) early pin, all modes (`:1481-1494`); (10) **preflight**, redeploy only (r1 contract 7); (11) **retention**, redeploy only (this contract); (12) **capacity admission**, always fatal, moved from `:1270-1372`; (13) `mkdir -p "$HOME/.qa-deployment-backups"` and `mktemp` (`:1571-1573`) and everything after it, unchanged |
| Helper transfer | Only in redeploy mode, after step 9: `QA_RETENTION_DIR="$(mktemp -d /tmp/explorer_qa_retention.XXXXXX)"`. Write `qa-backups.mjs`, `qa-backups-privileged.mjs`, `update-explorer-qa.mjs` and `rollback-explorer-qa.mjs` with `printf '%s'` from the transferred sources. Re-check each file's `sha256sum` against its transferred SHA, then `chmod 600`. The update helper must sit beside the rollback helper because `update-explorer-qa.mjs:8` imports `./rollback-explorer-qa.mjs`. |
| Invocation (shell) | `IFS='\|' read -r _ QA_RETENTION_CURRENT_ID _ <<< "${QA_CONTAINER_RECORDS[0]}"` then `QA_RETENTION_RECEIPT="$(node "$QA_RETENTION_DIR/qa-backups.mjs" prune --current-id "$QA_RETENTION_CURRENT_ID" --lock-held)"` then `echo "[deploy-qa] Retention receipt: $QA_RETENTION_RECEIPT"`. `node` is the QA Node v24.19.0 installed at step 7. No `\|\| true` and no `if !`: a non-zero exit stops the script under `set -e` before capacity, with `QA_STOP_STARTED=0`, so no rollback reference is printed. The block requires `${#QA_CONTAINER_RECORDS[@]} -eq 1`; otherwise it exits 1. |
| `prune` proofs (admin, in order) | (a) The host flock is held (probe as at `update-explorer-qa.mjs:604-605`). (b) `adapters.boxes()` holds exactly one container named `scope.box`, and its ID equals `--current-id`; otherwise exit 1 with `QA_RETENTION_CURRENT_CHANGED`. (c) The health gate: if that Box is not running, or `assertRuntimeReady(await runtime(current))` throws, or `await health(current)` throws (adapters from `updateProductionAdapters`), print `{"result":"skipped","reason":<safe QA_/PLOINKY_BOX_ code>,"removedBackups":[],"removedBoxes":[]}` and **exit 0** with nothing deleted. (d) `currentQaBox(boxes)` holds; otherwise exit 1. (e) The privileged prune runs as `spawnSync('sudo', ['-n', '/usr/bin/node', <dir>/qa-backups-privileged.mjs, 'prune', '--root', '/home/admin/.qa-deployment-backups', '--workspace', '/home/admin/explorerQaWorkspace', '--owner', String(process.getuid())])`. A non-zero status or non-JSON output exits 1. (f) Box removal follows contract 9. |
| Exit contract | 0 with `result` `pruned` (lists may be empty) or `skipped` (only for the health-gate failures in (c)). 1 for every other failure, including the identity proofs, the privileged process, Box removal and usage errors. |
| Fresh install | `QA_OPERATION=update` never enters the retention block or writes `QA_RETENTION_DIR`. |
| Capacity interplay | Capacity (step 12) measures free space after any deletion. It stays fatal. When retention was skipped, it may fail safely before anything stops. |

## Interfaces / contracts: contract 9 (replaced): backup classification, deletion and rollback target

| Aspect | Contract |
| --- | --- |
| Whitelist exports (`qa-backups.mjs`) | `BACKUP_INNER_ENTRIES = { completion: ['helpers', 'prior-containers.txt', 'rollback-authority.json', 'preservation.json', 'workspace', 'quiesce.log', 'quiesce-source.mjs', 'lock-ready.json', 'lock-released.json', 'lock-release', 'lock.log', 'lock-source.txt', 'policy-restoration.json', 'restored-selections.json'], rollbackMarkers: ['rollback-result.json', /^rollback-result\.json\.[a-f0-9]{16}$/, 'failed-workspace'] }` and `BACKUP_SIBLING_SUFFIXES = ['helpers', 'lock-ready.json', 'lock-released.json', 'lock-release', 'lock.log', 'lock-source.txt', 'quiesce.log']`. The privileged module defines the same lists, and a test asserts they are equal. |
| Classification (root, `qa-backups-privileged.mjs prune`) | It reads `--root` entries. A **backup** is a real directory matching `^redeploy-[A-Za-z0-9]{8}$`, owned by `--owner` (admin uid), with mode `& 0o077 === 0` and `realpathSync` equal to its path. Each backup gets exactly one class from the table below. A sibling `<name>-<suffix>` follows its backup's class. Any other entry in the root is `unrecognized` and is never touched. |
| Class `rollback-attempted` → **retained** (B2) | Contains `rollback-result.json`, any `rollback-result.json.<hex>` or `failed-workspace`. It is never auto-pruned. Data written after a redeploy survives only there (`docs/deploy-explorer-qa.md:313`; `rollback-explorer-qa.mjs:606`). |
| Class `unrecognized-entry` → **retained** | Has any inner entry outside `BACKUP_INNER_ENTRIES`, or an entry of the wrong type (files must be regular files and not symlinks; `helpers` and `workspace` must be directories) |
| Class `stop-attempted-unpreserved` → **retained** | Has no `workspace`, but `quiesce.log` (inner) or a `<name>-quiesce.log` sibling exists. The stop started and preservation never finished, which matches the doc state "Stopping nested QA services without Exact prior … retired". |
| Class `incomplete-redeploy` → **retained** | Has `workspace/`, but at least one of these is missing: `preservation.json` with `exactCopiesVerified === true` and `source === <backup>/workspace` and `target === '/home/admin/explorerQaWorkspace'`; `policy-restoration.json` with `exactCopiesVerified === true`; `restored-selections.json` parseable as JSON with a 64-hex `boxId` |
| Class `complete-redeploy` → **prunable** | Has `workspace/` and all three completion receipts above, and no rollback marker |
| Class `no-workspace` → **prunable** | Has no `workspace/`, no rollback marker and no quiesce evidence. This covers aborted attempts captured before any stop, fresh-install backups (empty `prior-containers.txt`, `preservation.json` with `source: null`) and empty `mktemp` directories |
| Privileged deletion (same root process) | For each prunable backup, first read and keep `prior-containers.txt` (raw text). Then (1) `renameSync(<root>/<name>, <root>/.pruning-<name>)`. (2) Check the tombstone: `lstat`, not a symlink, owner equals `--owner`, `dev` equals the root's `dev`, and its inode differs from `lstatSync(--workspace).ino`. (3) Walk the tree with `lstat` only, never following links, and assert every directory's `dev` equals the root's `dev`. Any mismatch aborts before any removal (one filesystem). (4) Run `fs.rmSync(tombstone, { recursive: true })`. (5) Remove that backup's siblings the same way. On start, any leftover `^\.pruning-redeploy-[A-Za-z0-9]{8}$` tombstone owned by `--owner` is checked and removed first and reported as `replayedTombstones`; its Boxes cannot be bound any more. No `sudo -n rm` is used anywhere. |
| Privileged output | `{ result:'pruned', removed:[{name, priorRecord}], retained:[{name, class}], unrecognized:[…], replayedTombstones:[…] }`. It never prints file contents beyond `priorRecord` (`engine\|id\|box`). |
| Box removal (admin, after the privileged output) | For each `removed[i]` with a `priorRecord` of the form `engine\|<64hex>\|ploinky-box-explorerqaworkspace-7a31ab7775eb`, delete exactly one container: name `<scope.box>-rollback-<name>`, the same engine and ID, `State.Running === false`, and passing `sanitize`, re-inspected immediately before the call. Command: `<engine> container rm <id>`, **without** `-v`. **Decision:** removing anonymous volumes would change `snapshot_protected_resources` (`:1080-1092`) and fail the post-deploy comparison at `:2645-2649`. Any `Mounts[].Type === 'volume'` names are reported as `orphanedAnonymousVolumes` for a separately authorized cleanup. `-failed-<name>` Boxes can only exist alongside rollback markers, so they are never removed. Any other stopped retained-pattern Box is reported as `retainedUnproven`. A Box-removal failure exits 1, and its backup is already gone. That Box then stays `retainedUnproven` and is harmless, because admission tolerates stopped retained Boxes. |
| Why one root process | Root-owned `preservation.json` and `policy-restoration.json` are read, and the deletion is made, in the same `sudo -n /usr/bin/node` process. Nothing re-reads them as admin. Boxes are removed only after their backup is gone, using the record captured before deletion. |
| Manual removal of retained backups | Not automated. The cleanup workflow has no backup roots (`cleanup-explorer-host.mjs:12`). The documented route is an explicitly user-authorized SSH operation under the host lock, reviewed per backup. |
| `selectRollbackTarget` (M2, admin) | Inventory all backups (the same name, owner and mode checks). Dateable backups have a regular, admin-readable `rollback-authority.json` with a valid `createdAt`; the rest are listed as `undated` and excluded from ordering. Pick the **single newest by `createdAt` among all dateable backups**. If it is ineligible, exit 1 with `{result:'refused', backup, reason, candidates}` and do **not** fall back to an older backup. Eligibility requires: helpers present (`node-runtime-path` and `rollback-explorer-qa.mjs` regular files); a predecessor ID in `prior-containers.txt` (else `no-predecessor`); no rollback marker (else `rollback-already-attempted`); and stop evidence, meaning `quiesce.log` inside, a `<name>-quiesce.log` sibling, or `preservation.json` present (checked with `lstat` only; admin can `lstat` a root-owned file in its own directory). Otherwise the reason is `no-stop-evidence`. The predecessor's running state is **not** used. `currentId`: no exact-name Box gives `absent`; an exact-name ID equal to the predecessor gives `absent` (the documented state where the old Box keeps its name and may still be running); otherwise it is that ID; two or more exact-name Boxes give `QA_BOX_AMBIGUOUS`. |

## Data flow (r2: steps 3 and 5 replaced)

3. Reconcile runs:
   - The retained-Box admission and the record loop both skip the stopped `…-rollback-redeploy-HFtJQ1es`.
   - Then the preservation admission, Node install, early pin and fatal preflight.
   - Then retention. `qa-backups.mjs prune --current-id <records[0] id>` proves the exact running Box and its readiness and health, and runs the privileged prune. That removes `redeploy-HFtJQ1es` (class `complete-redeploy`) and every `no-workspace` backup, and keeps any retained class with its reason. The admin side then runs `podman container rm c4530a81…`.
   - Then the capacity admission, which is fatal and measures the freed space.
   - Then the existing backup, quiesce, move and copy, the late pin check, start and readiness, as in r1.
5. *(removed: there is no post-health prune step)*

## Acceptance criteria (r2 replacements and additions)

| ID | Requirement | Check |
| --- | --- | --- |
| AC2 (replaced) | No fields | `rg -n 'inputs:\|inputs\.' .github/workflows/deploy-explorer-qa.yml` prints nothing. The comment at `:2125` is unaffected. |
| AC11 (replaced) | Retention deletes only prunable classes and their bound Boxes | `qa-backups.test.mjs` uses a real temp root and calls the privileged module in-process with an injected owner uid. After `prune`, these are **gone**: one `complete-redeploy` backup with all three receipts, a `no-workspace` aborted backup, a fresh-install backup (empty `prior-containers.txt`, `preservation.json` `source:null`), and their siblings. Its `-rollback-` Box is removed via the fake engine, without `-v`. These **remain**, each with its class: `incomplete-redeploy` (missing `policy-restoration.json`), `incomplete-redeploy` (missing `restored-selections.json`), `incomplete-redeploy` (`exactCopiesVerified:false`), `stop-attempted-unpreserved` (only the `-quiesce.log` sibling), `unrecognized-entry` (an extra `notes.txt`), and an `unrecognized` root file. A `-rollback-` Box whose ID differs from `priorRecord` is `retainedUnproven`. The live workspace inode and contents are unchanged. |
| AC12 (replaced) | Health gate and exit contract | Tests: a stopped exact Box, an `assertRuntimeReady` failure and a `health` throw each give `result:"skipped"`, exit 0, an empty `removed` list, and **no privileged spawn** (the spawn stub is never called). A current-ID mismatch, `currentQaBox` failure, privileged non-zero exit, privileged non-JSON output and Box-removal failure each give exit 1. |
| AC13 (replaced) | Order and placement | Workflow test on text indices: `Durable-state admission passed` < `Verified QA-scoped Node v24.19.0` < `if [ "$QA_EXPLORER_HEAD" != "$EXPECTED_EXPLORER_COMMIT" ]` < `# BEGIN QA redeploy preflight` < `# BEGIN QA superseded backup retention` < `// BEGIN QA capacity admission` < `mkdir -p "$HOME/.qa-deployment-backups"`. The retention block is inside `if [ "$QA_OPERATION" = redeploy ]`, contains no `\|\| true`, and contains no `if ! node`. No workflow step references `prune` outside that block. |
| AC16 (replaced) | Rollback selection | Tests: the newest eligible backup is chosen. When the newest has `rollback-result.json`, the result is refused with `rollback-already-attempted` even though an older eligible backup exists. Newest with no predecessor gives `no-predecessor`. Newest with neither quiesce evidence nor `preservation.json` gives `no-stop-evidence`, even when its predecessor Box is stopped. Newest with only the `<name>-quiesce.log` sibling and the exact-name Box **running** with the predecessor ID gives eligible with `currentId:"absent"`. A different exact-name ID gives that ID. Two exact-name Boxes give `QA_BOX_AMBIGUOUS`. Undated backups are excluded from ordering. |
| AC21 (replaced, live, pending user dispatch) | Option A on QA | First dispatch after merge: `Deployment selection:` shows `"mode":"redeploy"` with a `.runtime/ploinky` reason. Then a `Retention receipt:` line appears **before** `Capacity admission passed`, with `result:"pruned"`, `redeploy-HFtJQ1es` removed, Box `c4530a81692c…` removed, and every other backup either removed or retained with its class. A later `inspect-explorer-host-storage.yml` shows the new backup plus only retained-class backups, and exactly one `…-rollback-…` Box. A second dispatch with nothing changed upstream reports `"mode":"in-place"`, updater status `unchanged`, and no `image` reason. |
| AC22 (new, B1) | Whitelist derived from writes | `deploy-qa-backup-whitelist.test.mjs` extracts these names. From `deploy-explorer-qa.yml`: every `"$QA_BACKUP_DIR/<name>`, trimming a trailing `.`; the `for suffix in …; do` list at `:2081`; every `path.join(backup, '<seg>…')`, taking the first path segment. From `rollback-explorer-qa.mjs`: `path.join(backup, '<name>')` and the four names in `paths()` (`:455-456`), plus the journal temporary pattern. Siblings: every `"$QA_BACKUP_DIR-<suffix>`, `` `${backup}-<suffix>` `` and `${QA_BACKUP_DIR}-helpers`. The extracted inner set must equal `completion ∪ rollbackMarkers`, and the sibling set must equal `BACKUP_SIBLING_SUFFIXES`. **Fails at base** (the module is absent) and fails on the candidate if a future write is not whitelisted. |
| AC23 (new, B1) | Root-owned receipts never read as admin | Fixture: `preservation.json` and `policy-restoration.json` are written and then `chmodSync(…, 0o000)`. Run as non-root (CI `runner`, or the local user), the admin-side `prune` with a stub privileged runner completes. Every admin-side code path for prune and `rollback-target` succeeds without `EACCES`. The in-process privileged classification, run with a test hook that restores read permission (simulating root), classifies the backup as `complete-redeploy`. The test asserts it was skipped when `process.getuid() === 0`, so it can never pass vacuously as root. |
| AC24 (new, B2) | Never prune rollback-attempted backups | Backups with (i) `rollback-result.json` `{result:'recovered', phase:'complete'}`, (ii) only `rollback-result.json.0123456789abcdef`, and (iii) only `failed-workspace/` each stay in place with class `rollback-attempted`. Their `-rollback-` and `-failed-` Boxes stay, and no `container rm` is called for them. |
| AC25 (new, M1) | Shell-level skip, fail and fresh-install behaviour | The sliced retention block is run with a stub `node` and records `QA_OPERATION=redeploy` and one record. A stub printing `{"result":"skipped",…}` with exit 0 lets the script continue to a capacity marker stub. A stub exiting 1 stops the script with status 1 before the capacity marker and prints no `Rollback reference`. With `QA_OPERATION=update`, the stub is never invoked and `QA_RETENTION_DIR` is never created. |
| AC26 (new) | Helper transfer integrity | Test: the env file writer includes the three new `write_shell_var … _SOURCE` and `… _SHA` pairs. The remote side checks each SHA before use. A tampered source (changed byte) exits 1 before the retention block. |

## Adversarial probes (r2 additions)

| Category | Probe | Expected |
| --- | --- | --- |
| Boundary | A tombstone `.pruning-redeploy-AbCd1234` that is a symlink, owned by another uid, or on another `dev` (inject `dev`) | Privileged prune exits non-zero before any `rmSync` |
| Data protection | A backup directory hard-linked or bind-mounted to the live workspace, simulated by an injected inode equal to the workspace inode | Refused; nothing removed |
| Idempotency | Kill the privileged process after the `rename` and before `rmSync`, then re-run | The tombstone is removed and reported in `replayedTombstones`; its Box stays `retainedUnproven` |
| Error injection | `sudo` prints a password prompt or exits 1 (`sudo -n` failure); the privileged module prints partial JSON | `prune` exits 1; capacity is never reached; QA is untouched |
| Node 20 | `node --check` on `qa-backups-privileged.mjs` using Node 20, and a test that greps it for `import` statements naming only `node:` modules | Passes; no Node 22+ API (for example no `fs.globSync`) |

## Open questions / risks (r2 updates)

| ID | Item |
| --- | --- |
| Q1 | Resolved by D2 (option A, gated on health). |
| R3 (revised) | Deletion is irreversible. Before the new backup exists, the rollback point from the previous redeploy is deleted. If the run then fails before capture, QA keeps running with no backup of the previous generation. User-approved (D2). |
| R10 (new) | Retained classes (`rollback-attempted`, `incomplete-redeploy`, `stop-attempted-unpreserved`, `unrecognized-entry`) keep consuming disk and can make capacity fail. Removing them is a manual, user-authorized SSH operation. No tracked workflow covers it; extending `cleanup-explorer-host-storage.yml` would be a separate reviewed change. |
| R11 (new, stuck states) | `select` exits 1, with no fall-through and no forced-redeploy input, for `QA_UPDATE_NOT_FAST_FORWARD` (rewritten `main` history), `QA_UPDATE_STATIC_SOURCE_UNPROVEN` (a browser route rooted outside the managed checkout, for example a `devel` agent) and `QA_UPDATE_TARGET_NOT_UNAMBIGUOUS` (an aliased, `devel` or duplicate `AchillesIDE` agent). Recovery: (a) remove the cause: disable the aliased or `devel` agent through Marketplace or Ploinky, or restore fast-forward history on `main`, then re-dispatch; (b) any drift in Ploinky, another repository, ALA or the image selects redeploy **before** Explorer classification, so the next such upstream change also escapes; (c) otherwise the rollback workflow, or a separately reviewed one-off change. Document this in `docs/deploy-explorer-qa.md`. |
| R12 (new) | Anonymous volumes of removed Boxes, if any, are left behind and reported rather than deleted, to keep the protected-resource comparison at `:2645-2649` valid. |
| R13 (new) | The Node archive download (step 7) now runs before the capacity check, in both modes. It writes only under `/home/admin/.qa-deployment-tools` (at most about 100 MB, `--max-filesize 104857600` at `:1435`). |

## Implementation order (r2: steps 4 to 6 replaced)

4. **Deploy workflow, part 2:**
   - Retained-Box admission and the record loop.
   - Move capacity after the new retention block. The step-7-to-12 order of contract 8 must hold.
   - Fatal preflight.
   - Unconditional pins with the mode-specific late message.
   - Helper transfer with SHA checks.
   - The retention shell block.
   - Drop `QA_CAPACITY_LOG`.

   Checkpoint: AC10, AC13, AC14, AC25 and AC26, `deploy-workflow-contract.test.mjs:612-625` (updated) and the shell-parse test.
5. **`qa-backups-privileged.mjs`, `qa-backups.mjs` (prune with health gate, Box binding, `rollback-target`), and both new test files.** Checkpoint: AC11, AC12, AC16, AC22, AC23, AC24 and the r2 probes.
6. *(The r1 prune-step placement is removed. Contract 8 covers it inside step 4.)*

Unverified items carried forward:
- The three completion receipts in `redeploy-HFtJQ1es`, inferred from the unchanged workflow.
- Whether any QA Box has anonymous volumes.
- Current free disk space.
- That the outer image ID equals the registry config digest (r1 R2).

---

## Plan review outcome and implementer notes (2026-10-21)

r1 review: REVISE (B1, B2, M1, M2). r2 delta review: APPROVE with Minor notes. Plan frozen; these notes go to the implementers and do not reopen the plan.

| # | Note | Disposition |
| --- | --- | --- |
| N1 | `selectRollbackTarget`: a newer backup with no stop evidence is an attempt that never touched QA; it must not block rollback to the older real target | Skip `no-stop-evidence` backups when ordering (list them in `candidates` with that reason); refuse only when the newest backup that did change state is ineligible |
| N2 | "Old Box already stopped" path sets `QA_STOP_STARTED=1` (~:1707) without a quiesce log | Also count "a Box with the predecessor ID exists, is stopped and keeps the exact name" as stop evidence (rollback selection only; retention is unaffected because the health gate skips it) |
| N3 | AC22 extraction must also catch unquoted `$QA_BACKUP_DIR/workspace.` (~:1814) and dynamic `"$QA_BACKUP_DIR-$suffix"` (~:2082, expand from the `for suffix in` list) | Implement in the whitelist test |
| N4 | Sudoers may only allow `/usr/bin/node` reading a stdin script | Run the privileged module exactly like the existing pattern: `sudo -n /usr/bin/node --input-type=module - prune --root … --workspace … --owner …` with the module source on stdin (`spawnSync(..., { input })`). The module must work when loaded from stdin (no `import.meta.url` file assumptions; detect CLI via an explicit entry function or argv) |
| N5 | lstat walk + rmSync of ~24 GB inside the 90-minute job | Accept; tombstone replay covers interruption |
