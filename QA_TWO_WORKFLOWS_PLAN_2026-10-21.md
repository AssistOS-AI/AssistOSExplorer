I've written the SPEC below. It is not ready to approve until you answer Q1 (whether destroy deletes the old backups); Q2 (whether a keep-data destroy keeps the access policy) is a one-line toggle and can wait for review. Nothing was implemented, run or dispatched.

The code changes two things you assumed:
- **The keep-set is larger than `.data`.** Your documents sit at the top of the QA workspace (`testN2/`, `WebMeet/`, `test1.backlog`). The current preservation code keeps every top-level entry except `.ploinky`, `.runtime` and `AdvancedLanguageAgent`, so I kept that rule. Keeping only `.data` would delete your documents.
- **There are no "selections" to restore.** Today's deploy only logs prior agent choices; it never re-enables them (`deploy-explorer-qa.yml:2879-2880`: "none is enabled again"). The only state a rebuild carries across is the router access policy, and it has to be parked outside the workspace because Ploinky refuses to start with a partial set of those files.

**Questions for you**

| ID | Question | Options | Recommendation | Affects |
| --- | --- | --- | --- | --- |
| Q1 | Should destroy delete the old backups in `/home/admin/.qa-deployment-backups` (26.9 GB on 2026-10-21) and their helper files? These are older copies of QA data. Once the rollback workflow is gone, nothing else can remove them. | (a) delete in both checkbox modes; (b) delete only with the checkbox ticked (the literal reading of "anything needed for a fresh deployment"); (c) never, you clean up by hand | **(a).** With (b), the only way to reclaim 26.9 GB would be to also delete the live data. Their contents are older copies; the live data was copied and compared before they were written. Deploy never touches them under any option. | Contract 6, AC14, live step L3 |
| Q2 | A destroy with the checkbox unticked keeps `.data`, your documents and the encryption identity, as you asked. Should it also keep the router access policy (`.ploinky/data/router-security`: policy, session revocations, audit log)? A rebuild keeps it, as today's redeploy does. | (a) keep it, parked in `/home/admin/.qa-deployment-state/router-security` and restored by the next deploy; (b) delete it (your literal answer) | **(a).** Your answer keeps the identity keys; deleting the revocation list while keeping those keys might make revoked sessions valid again (not verified). The difference is one flag. The spec is written for (b) until you answer. | Contract 4, AC12 |

Decided without asking (routine): the checkbox is named `delete_data`. Destroy deletes the dedicated `explorer-qa` tunnel and its DNS record in both modes, and the next fresh deploy creates new ones. Stopped `-rollback-`/`-failed-` Boxes are removed by rebuild, by fresh install and by destroy, because they hold no unique data. A rebuild also removes the cached outer Box image so that the next start pulls the current one.

---

# SPEC: Explorer QA with exactly two workflows (deploy, destroy)

## Header (candidate identity)

| Item | Value |
| --- | --- |
| Repository | `/Users/danielsava/work/file-parser/AssistOSExplorer` (AssistOS-AI/AssistOSExplorer), branch `main` |
| Design base | Working tree on 2026-10-21: `main` at `2a9720b0` plus the uncommitted 11-file resume candidate (`git diff --stat`: `qa-backups*.mjs`, `deploy-explorer-qa.yml`, docs, DS002, 6 tests). Line numbers below refer to this tree. |
| Implementation base | The `origin/main` SHA after the resume candidate is merged and QA is back up (user decision 4). Record it at the start of implementation. The local `origin/main` ref already shows `b9f87ba0`, so refresh with `git fetch` and re-derive any line that moved. |
| Live host (inspect run 39608950538, 13:33Z) | Only the admin rootless Podman store is populated. It holds one container, `d4ada362…` `…-rollback-redeploy-jQRMF7aJ` (stopped), and one image, `46b06b0a…` `docker.io/assistos/ploinky-box:latest`. Root Podman is empty and Docker is absent. `availableBytes` 31472467968. Backups 26936340480 B. The workspace's top level holds user documents: `testN2/`, `WebMeet/`, `test1.backlog`. |

## Intent (1 paragraph)

Explorer QA keeps two workflows. Rollback, cleanup, inspect, runtime-verify and retired-source-absence are deleted.

`deploy-explorer-qa.yml` still takes no inputs and chooses its own action:
- fresh install when nothing exists
- fresh install onto preserved data when a workspace exists but no current Box
- in-place update of AssistOSExplorer (unchanged)
- **rebuild** for any other drift

A rebuild is "destroy with data kept" followed by a fresh install, in one run. It stops and removes the Box and every QA container, removes the cached outer image, deletes the regenerable workspace state, and installs fresh onto the data left in place. It makes no backup, retains no Box and renames nothing.

`destroy-explorer-qa.yml` has one checkbox, `delete_data`:
- **Unticked:** removes everything a fresh deploy regenerates and keeps the data.
- **Ticked:** removes the whole workspace.

The governing constraint comes from the user: "never lost data, never two Boxes". Every failure must leave either the untouched running QA or a state that the next deploy finishes by itself. A durable install marker gives that guarantee. Only QA-owned resources may ever be touched.

## Out of scope

| Item | Reason |
| --- | --- |
| `update-explorer-qa.mjs` in-place behaviour, its `select` classification and its receipts | Reused unchanged. Its `mode:"redeploy"` answer is mapped to the new `rebuild` route by the locked script. |
| Ploinky source, Box image builds, the shared `proxies` tunnel `091c4096-…`, the Soul Gateway workspace, the root Podman store, `/home/admin/.ploinky-box`, `/home/admin/.qa-deployment-tools` | Not QA-owned, or shared and reused. Never touched. |
| `reconcile-qa-soul-settings.mjs` and its test | Not referenced by either workflow. Left as is. |
| `docs/plans/*` historical plans | Frozen history. Not edited. |
| `tests/smoke/lib/retired-source-absence.test.mjs` | Kept. It still runs under `node --test 'tests/smoke/lib/*.test.mjs'`, but no longer as a push/PR gate (risk R6). |
| Any dispatch, commit or push | Each needs the user's explicit approval |

## Files to create

| Path | Purpose |
| --- | --- |
| `.github/scripts/qa-teardown.mjs` | Admin-side module for both workflows: a light inventory of QA containers, volumes, images, marker and stash; `route`; `mark`; `execute` (quiesce, stop, remove containers and images, then call the privileged helper); `complete`; `protected-snapshot`. Imports only Node built-ins. Adapters are injectable for tests. |
| `.github/scripts/qa-teardown-privileged.mjs` | Root-side program fed on stdin to `sudo -n /usr/bin/node --input-type=module -`: `plan-workspace`, `reduce-workspace`, `stash-policy`, `clear-state`, `remove-legacy-backups` (only if Q1 is (a) or (b)). Imports only Node built-ins and stays compatible with Node 20. |
| `tests/smoke/lib/qa-teardown.test.mjs` | Fixture tests for the keep-set, refusals, stash, delete-data, containers and images, the route table and the crash-point table |
| `tests/smoke/lib/deploy-qa-rebuild-workflow.test.mjs` | Static and sliced tests of the Reconcile rebuild and fresh wiring. Replaces `deploy-qa-redeploy-workflow.test.mjs`. |
| `tests/smoke/lib/deploy-qa-destroy-workflow.test.mjs` | Static and sliced tests of the new destroy workflow |

## Files to modify

| Path:lines | Change |
| --- | --- |
| `.github/workflows/deploy-explorer-qa.yml:338-461` | In-place step: upload `update-explorer-qa.mjs`, `rollback-explorer-qa.mjs` and `qa-teardown.mjs` (no `qa-backups*`). Replace the absence proof (`:379-389`) and the `qa-backups.mjs route` block (`:404-423`) with `qa-teardown.mjs route --lock-held`, normalised with `\|\| { printf …; exit 1; }`. `fresh` gives exit 42, `rebuild` gives 43, `select` keeps today's select and execute, and select `redeploy` gives 43. Handler: 43 writes `operation=rebuild`; delete the 44 branch (`:452-455`). |
| `…:543-548` | Keep the refusal to create a tunnel when `OPERATION` is non-empty; change the message to "a rebuild reuses …". A fresh install (empty `OPERATION`) may create one. |
| `…:718-759` | Env file: drop `QA_BACKUPS_*` and `QA_UPDATE_*`; add `QA_TEARDOWN_SOURCE/SHA` and `QA_TEARDOWN_PRIVILEGED_SOURCE/SHA`. Keep `QA_QUIESCE_*` and `QA_ROLLBACK_*` (tail adapters). |
| `…:777-888` | Operation case `update\|rebuild`. Delete the workspace-lock functions (`:796-821`) and `print_rollback_reference_on_failure` (`:822-844`). `cleanup_remote_files` removes the helpers dir and, on failure after `mark`, prints `[deploy-qa] Install marker kept; the next deploy finishes this installation from the preserved data.` |
| `…:898-992` | Replace `assert_qa_install_admission` with a re-proof under the Reconcile lock: `qa-teardown.mjs route` must give `fresh` when `OPERATION=update`, or `select`/`rebuild` when `OPERATION=rebuild`; anything else exits 1 before any mutation |
| `…:1002-1023` | Integrity checks for the new source set |
| `…:1126-1264` | The protected snapshot moves to `qa-teardown.mjs protected-snapshot` with identical output. Delete the container and volume record loop (`:1186-1264`); inventory and ownership checks move into `qa-teardown.mjs`. |
| `…:1265-1354` | Keep `assert_qa_preservation_admission` unchanged. Run it only when the workspace exists and the marker was absent when the route was decided. |
| `…:1498-1514` | Fast-forward failure messages: `late:rebuild` says the data stays in place and the marker remains |
| `…:1530-1548` | Helpers dir `/tmp/explorer_qa_helpers.XXXXXX` holding `qa-teardown*.mjs`, `rollback-explorer-qa.mjs` and `quiesce-explorer-qa.mjs`, SHA-checked; for both operations |
| `…:1550-1585`, `…:1592-1620`, `…:1651-1669` | Delete the resume admission, the capture preview and the backup retention |
| `…:1621-1642` | Keep the quiesce preflight. It runs for `rebuild` only, when the Box is running and the marker was absent. |
| `…:1671-1786` | Capacity admission rewritten (contract 7) |
| `…:1788-2182` | Replace the backup, lock, stop, move, rename and resume blocks with `# BEGIN QA install marker` (`qa-teardown.mjs mark`) and `# BEGIN QA teardown` (`qa-teardown.mjs execute --scope rebuild\|fresh --mode keep-data …`). There is no `rm -rf` and no `mkdir -p "$WORK_DIR"` inside them. |
| `…:2445-2462` | Delete the lock release and the receipt moves |
| `…:2493-2503` | Delete the `Rollback reference` line |
| `…:2510-2537` | Policy restoration: the source is `/home/admin/.qa-deployment-state/router-security` when present. With no stash it logs `fresh access policy` and copies nothing. The receipt goes to the log, not to a backup. |
| `…:2872-2908` | Replace the prior-selection block with `# BEGIN QA fresh graph readiness`: `currentQaBox` plus `adapters.ready(current, { agents: [] })`, no backup. Log `[deploy-qa] Fresh graph readiness confirmed.` |
| `…:2966`, `:2982` | `QA_TAIL_HELPER` becomes `$QA_HELPERS_DIR/rollback-explorer-qa.mjs`; drop the comment about the verifier workflow |
| `…:3033-3035` | Before "Explorer QA Box is ready", run `qa-teardown.mjs complete --lock-held` (removes the stash, then the marker) |
| `…:3226-3288` | Summary: route, operation `rebuild`/fresh, the teardown receipt; drop the retention and resume lines |
| `.github/workflows/destroy-explorer-qa.yml:1-955` | Rewritten (contract 6) |
| `.github/scripts/rollback-explorer-qa.mjs:44-88, 89-108, 123-194, 449-660, 737, 796-889 (rollback-only adapters), 910-947` | Delete `createRollbackService`, `main`, `restorePriorSelections`, `enableArguments`, `classifyPriorSelections`, `describeSelectionDispositions`, `accountCapability` and `ACCOUNT_CAPABILITY*`, and the adapters `accountCapability`, `checkPrerequisites`, `imageId`, `quiesce`, `stop`, `rename`, `copy`, `prepare`, `initialize`, `start`. Keep `QA_SCOPE`, `QUIESCE_EXEC_TIMEOUT_MS`, `EXPECTED_DEFAULT_GRAPH`, `sanitizeBox`, `currentQaBox`, the image-AgentLib exports, and `productionAdapters` with `assertHost`, `machineId`, `sourcePin`, `boxes`, `verifyAgentLib`, `acquireWorkspaceLock`, `ready`. Each deletion must show zero remaining references (LSP `findReferences`). |
| `tests/smoke/lib/deploy-qa-auto-selection.test.mjs:1-283` | Rewrite for the `qa-teardown.mjs route` stub and the exit map 42/43/0/1 |
| `tests/smoke/lib/deploy-qa-in-place-workflow.test.mjs:1-310` | Admission cases now read from the route re-proof |
| `tests/smoke/lib/deploy-qa-node-runtime.test.mjs:1-107` | Capacity slice for the new block |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:191-200, 223-317, 318-345, 620-656` | Drop `verify-explorer-qa-runtime.mjs` and `rollback-explorer-qa.yml` (`:330`). Rewrite the destroy contract (`:223-317`). Retarget the cleanup slice (`:620-638`) to the teardown block. Delete the resume test (`:640-656`). |
| `tests/smoke/lib/qa-rollback.test.mjs:1-1028` | Delete the tests of removed functions (for example `:306`, `:491-735`, `:776-875`); keep the tests of retained exports (`:185-305`, `:367-415`, `:471`, `:748-775`, `:876-1006`) |
| `explorer/tests/unit/optionalAgentDefaults.test.js:113` | Drop `.github/scripts/verify-explorer-qa-runtime.mjs` from the list. The `:6` import of `EXPECTED_DEFAULT_GRAPH` stays valid. |
| `explorer/tests/unit/retiredLocalModelGraph.test.js:97-99` | Drop the two verifier-count assertions |
| `docs/deploy-explorer-qa.md:23-56, 126, 173, 316-386` | Route table, rebuild, destroy modes, keep-set, marker, legacy backups (Q1), capacity (replaces "do not lower the floor", `:341`). Remove the rollback, retention and resume sections. |
| `docs/specs/DS002-ploinky-runtime.md:92` | Normative contract: two workflows, the routes, rebuild semantics, destroy checkbox, the marker |
| `docs/architecture.html:71` | The same, summarised |
| `AGENTS.md:96-101` | Supported workflows: exactly `deploy-explorer-qa.yml` (no inputs) and `destroy-explorer-qa.yml` (`delete_data` checkbox) |

**Files to delete:**
- `.github/workflows/{rollback-explorer-qa,cleanup-explorer-host-storage,inspect-explorer-host-storage,verify-explorer-qa-runtime,verify-retired-source-absence}.yml`
- `.github/scripts/{qa-backups,qa-backups-privileged,cleanup-explorer-host,inspect-explorer-host-storage,verify-explorer-qa-runtime}.mjs`
- `tests/smoke/lib/{deploy-qa-archive-lock,deploy-qa-backup-whitelist,deploy-qa-rollback-workflow,deploy-qa-redeploy-workflow,deploy-qa-preservation,qa-backups,explorer-host-cleanup}.test.mjs`

`quiesce-explorer-qa.mjs`, `check-no-wait-readiness.mjs` and `update-explorer-qa.mjs` stay, because deploy and destroy still use them.

## Interfaces / contracts

### 1. Keep-set K (keep-data mode), relative to `W=/home/admin/explorerQaWorkspace`

| Class | Paths | Derived from |
| --- | --- | --- |
| Kept: top level | Every entry of W except `.ploinky`, `.runtime` and `AdvancedLanguageAgent`. This includes `.data`, `.env` and the user documents. | `deploy-explorer-qa.yml:1993-1994` `const regenerated = new Set(['.ploinky', '.runtime', 'AdvancedLanguageAgent']); for (const name of fs.readdirSync(source)) if (!regenerated.has(name)) copy(name);` |
| Kept: identity | Those present of `.ploinky/data/{master-key,.secrets,passwords.enc,ploinky_subject_identity_ed25519_v1.enc}`, the legacy `.ploinky/passwords.enc`, and `.env` | `rollback-explorer-qa.mjs:35-38` `AUTH_FILES` (one literal copy in each teardown file, compared by a test) |
| Kept: containers | The directories `.ploinky` and `.ploinky/data`, keeping their owner and mode | `:2007-2012` |
| Deleted | `.runtime`, `AdvancedLanguageAgent`, every `.ploinky/<name>` except `data` and `passwords.enc` (user decision 1; a superset of `:1998-2000`), and `.ploinky/data/{edge-routing,edge-publication,router-security}` | `:2014` |
| Refused: nothing deleted, exit 1 | Any of the cases listed below the table | |

Refusal cases for the last row:
- Retired `.ploinky/{master-key,.secrets,ploinky_subject_identity_ed25519_v1.enc}` (`:1294-1296`), code `QA_TEARDOWN_RETIRED_IDENTITY`.
- Any `.ploinky/data/<name>` outside identity ∪ {edge-routing, edge-publication, router-security}, code `QA_TEARDOWN_UNKNOWN_DATA_ENTRY`, with the names.
- `.data` present without `.ploinky/data/master-key` (`:1299`).
- W, `.ploinky`, `.ploinky/data`, `.data` or `.runtime` is a symlink or not a directory (`:1279-1281`).
- An identity file that is not a regular file with `nlink === 1` (`:1291`).
- A deletion target whose `st_dev` differs from W's.

**Proof before deletion.** `plan-workspace` runs as root and is read-only. It prints `{"result":"planned","keep":[{relative,type,dev,ino}],"identity":[{relative,sha256,uid,gid,mode,nlink}],"delete":[{relative,type}],"stash":"create|keep|none","digest":"sha256:…"}`.

`reduce-workspace --plan-digest D`:
1. Recomputes the plan and requires the same digest.
2. Deletes with `fs.rmSync(recursive)`.
3. Re-reads `keep` and `identity` and requires them identical to the plan.
4. Prints `{"result":"reduced",…}`.

It is idempotent: a second run gives an empty `delete` list.

### 2. State directory `S=/home/admin/.qa-deployment-state` (admin, mode 700)

| Entry | Contract |
| --- | --- |
| `install-pending.json` | `{version:1, operation:"update"\|"rebuild", createdAt, dispatch:"<ref>@<sha>"}`, created with `wx` by `mark`. If it already exists, `mark` keeps it and reports `"existing":true`. |
| `router-security/` | Stash of ⊆ {`policy-state.json`, `sessions-revocations.json`, `policy-audit.log`, `policy-audit-archive`} (the list at `:2526`). Written by root as `router-security.tmp-<pid>`, then `cp -a`, then `diff -qr`, then `rename`. A leftover `.tmp-*` is discarded. An existing stash is never overwritten. |
| `complete` | Requires a running exact Box and the marker. Removes the stash, then the marker (marker last). |

### 3. `node qa-teardown.mjs route --lock-held` (read-only)

Output is exit 0 with `{"result":"routed","route":"fresh"|"rebuild"|"select","reason":…,"marker":bool}`, or exit 1 with `{"result":"refused","code":"QA_ROUTE_*"}`.

A container is a QA container when its label `io.assistos.ploinky-box.path-hash=7a31ab7775eb`, its name is `ploinky-box-explorerqaworkspace-7a31ab7775eb`, or its name starts with that name plus `-`. It is a legacy retained Box when it matches `:925` `^…-(rollback|failed)-redeploy-[A-Za-z0-9]{8}$`. The inventory is the light, non-sanitizing listing, as at `qa-backups.mjs:475-500`.

| Row | Workspace W | QA containers | Marker / stash | Route |
| --- | --- | --- | --- | --- |
| R1 | absent | none | marker any, no stash | `fresh` |
| R2 | absent | any | any | refuse `QA_ROUTE_CONTAINERS_WITHOUT_WORKSPACE` |
| R3 | real directory | none, or only stopped legacy Boxes | stash only with a marker | `fresh` (onto preserved data; Reconcile reduces it first) |
| R4 | real directory | exact Box running (plus stopped legacy) | no marker, no stash | `select` |
| R5 | real directory | exact Box running (plus stopped legacy) | marker | `rebuild` (select is not called) |
| R6 | real directory | exact Box stopped (plus stopped legacy) | any (stash only with a marker) | `rebuild` |
| R7 | any | a running legacy Box, an unknown QA-labelled name, a name or label conflict, the exact name in both engines, or any QA volume | any | refuse |
| R8 | file, symlink or other | any | any | refuse |
| R9 | an engine list or inspect fails | | | refuse |
| R10 | any | any | stash without a marker | refuse `QA_ROUTE_STALE_POLICY_STASH` |

### 4. `node qa-teardown.mjs execute --scope rebuild|fresh|destroy --mode keep-data|delete-data --quiesce fatal|warn|skip --legacy-backups keep|remove --lock-held`

1. Inventory and plan everything read-only. Refuse per the table below, and refuse with `QA_TEARDOWN_HOST_LOCK_REQUIRED` unless the flock is held (as at `qa-backups.mjs:457-460`).
2. If the exact Box is running and `--quiesce` ≠ `skip`: exec the quiesce source exactly as at `:1920-1923` (timeout `QUIESCE_EXEC_TIMEOUT_MS`), then require `result:"passed"`. `fatal` exits 1; `warn` logs `::warning::` and continues.
3. `container stop --time 30` every running QA container, then `container rm <id>` (no `-f`) for each. Re-inspect each before and after.
4. QA volumes: remove only in `destroy`+`delete-data`.
5. Images in the same engine: the removed containers' `.Image` ∪ images tagged or digested `^docker\.io/assistos/ploinky-box[:@]`. `image rm <id>` (no `-f`) only when no remaining container references the ID; otherwise log `retained-in-use`.
6. Workspace: in keep-data mode run `stash-policy` (rebuild and fresh; destroy only under Q2 (a)), then `plan-workspace` and `reduce-workspace`. In delete-data mode remove W, with the guards of destroy `:879-925` plus root.
7. State: in `destroy` remove the marker. Under Q2 (b) the stash goes too; under Q2 (a) it stays. Delete-data removes S entirely.
8. Legacy backups (`destroy`, per Q1): remove only names matching `^redeploy-[A-Za-z0-9]{8}(-(helpers|lock-ready\.json|lock-released\.json|lock-release|lock\.log|lock-source\.txt|quiesce\.log))?$` or `^\.pruning-redeploy-[A-Za-z0-9]{8}$` (sibling suffixes from `qa-backups-privileged.mjs`). Each must be owned by admin, on the same device and not a symlink. Report anything else and keep it.
9. Print one receipt line `{"result":"torn-down","removedContainers":[…],"removedImages":[…],"workspace":{…},"stash":…,"legacyBackups":…}`.

| Scope | Exact Box | Stopped legacy | Running legacy or unknown QA-labelled | QA volumes |
| --- | --- | --- | --- | --- |
| rebuild | required | removed | refuse | refuse |
| fresh | must be absent | removed | refuse | refuse |
| destroy keep-data | removed (`--quiesce warn`) | removed | stopped, then removed | refuse |
| destroy delete-data | removed (`--quiesce skip`) | removed | stopped, then removed | removed |

### 5. Deploy Reconcile order (rebuild and fresh)

1. Identity checks (`:1025-1124`).
2. Protected snapshot (before).
3. Route re-proof.
4. Preservation admission (when no marker was present and W exists).
5. QA Node.
6. Early fast-forward check.
7. Helpers.
8. Quiesce preflight (rebuild with a running Box and no marker at route time).
9. Capacity.
10. **`mark`** (the first mutation).
11. `execute` with `--quiesce fatal` if this run created the marker, `warn` if the marker predates the run. `--legacy-backups keep`.
12. The unchanged tail from `mkdir -p "$WORK_DIR"` (`:2184`) through prepare, edge init, policy restoration from the stash, start, readiness, fresh-graph readiness, source and AgentLib verification, Router and Soul checks, and the protected snapshot comparison.
13. **`complete`**.
14. "Explorer QA Box is ready."

### 6. `destroy-explorer-qa.yml`

| Aspect | Contract |
| --- | --- |
| Inputs | Exactly one: `delete_data`, `type: boolean`, `default: false`, description "Also delete the QA data (.data, workspace documents, encryption identity). Unchecked keeps them for the next deploy." The old `confirm_destroy` is removed. |
| Concurrency | `group: deploy-explorer-qa`, `cancel-in-progress: false` (as today, `:12-14`) |
| Steps | 1. Checkout (`persist-credentials: false`).<br>2. Setup Node 24.<br>3. `node --test tests/smoke/lib/qa-teardown.test.mjs tests/smoke/lib/deploy-qa-destroy-workflow.test.mjs`.<br>4. Validate configuration and pin the SSH key (`:38-104` without the confirm check).<br>5. Prepare SSH.<br>6. **Host teardown:** private `/tmp/explorer-qa-destroy.XXXXXXXX` upload of `qa-teardown*.mjs` and `quiesce-explorer-qa.mjs`, then `flock -n -E 75 --close /home/admin/.qa-deployment-operation.lock bash -s`. It sends no Cloudflare credential to the host.<br>7. **Delete the dedicated Cloudflare publication** on the runner, `if: success()`. It reuses the JS of `:708-814` and adds `tunnelId !== CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID`. It deletes DNS before the tunnel, so a partial failure never leaves DNS without its tunnel. It is idempotent (prints "already absent").<br>8. Summary.<br>9. Cleanup. |
| Host script | 1. Identity checks (`:213-305` subset) and the QA Node choice (`:261-277`).<br>2. Protected snapshot (before).<br>3. `execute --scope destroy --mode keep-data\|delete-data --quiesce warn\|skip --legacy-backups <Q1>`.<br>4. Protected snapshot (after); compare it with the first.<br>5. Soul health (`:372-377`, `:818-821`).<br>It never calls the Ploinky runtime, `prepareBoxForCommand` or `ploinky start/destroy`, and it succeeds when nothing is left. |

### 7. Capacity (replaces `:1671-1786`, runs as root before `mark`)

Required: `free + reclaimable ≥ 16 GiB`. `reclaimable` is the measured size, with the `allocated()` of `:1690-1711`, of the deletion targets plus the QA image bytes. 16 GiB is the observed 12421816320 B regenerated `.ploinky` of the predecessor plus the 4 GiB margin of `:1714`, rounded up. Failure is fatal and nothing has been mutated.

## Data flow (rebuild after a Ploinky drift)

1. The Resolve step pins P (`:42-63`). The in-place step runs `qa-teardown.mjs route`, which gives `select` (R4). `update-explorer-qa.mjs select` returns `mode:"redeploy"` with a `.runtime/ploinky` reason. The script exits 43 and the handler writes `operation=rebuild`.
2. The runner reuses the dedicated tunnel (`:544`). The Reconcile remote takes the host flock, re-proves the route (`select`, accepted for rebuild), runs the preservation admission (`:1265-1351`), QA Node, the early check, the quiesce preflight (`:1621-1642`) and capacity.
3. `mark` creates `S/install-pending.json`. `execute --scope rebuild` quiesces and stops the exact Box, removes it and any stopped legacy Box, removes the unreferenced `ploinky-box` image, stashes router-security, then plans and reduces W. The receipt is logged.
4. The tail (`:2184-3032`) clones the runtime and ALA, writes edge intent, prepares a new exact-name Box, initialises edge sources, restores the stash (`:2516-2536`), starts, waits for readiness, and verifies sources, AgentLib and Router. The protected snapshot is unchanged.
5. `complete` clears the stash and the marker. The runner steps then verify the public URL and the Cloudflare topology (`:3039`, `:3127`).

**Crash-point table** (each row is backed by a fixture, AC15):

| Failure point | State left | Next deploy |
| --- | --- | --- |
| Before `mark` | Untouched running QA | R4 `select` |
| After `mark`, during quiesce or stop | Marker, Box running or stopped | R5 or R6 `rebuild` (quiesce `warn`) |
| During `container rm` | Marker, some containers | R6 if the exact Box remains, otherwise R3 `fresh` |
| During the stash | Marker, live policy intact, maybe a `.tmp` | Re-stash from live |
| During the reduction | Marker, no containers, partial W ⊇ K | R3 `fresh`, which reduces again (idempotent) |
| In the tail before prepare | Marker, K, partial clones | R3 `fresh` |
| In the tail after prepare | Marker, new exact Box | R5 or R6 `rebuild` |
| In the runner steps after `complete` | Running Box, no marker | R4 `select` |

## Reused patterns

| Pattern | Location |
| --- | --- |
| Root program on stdin, Node built-ins only, CLI dispatch | `qa-backups-privileged.mjs:1-12`, `:391-413`; the caller pattern at `qa-backups.mjs:461-468` |
| Light container inventory without sanitizing | `qa-backups.mjs:475-500` |
| Held-flock probe | `qa-backups.mjs:457-460`, `update-explorer-qa.mjs:771-774` |
| Keep and regenerate rules, identity comparison | `deploy-explorer-qa.yml:1993-2025`, `:1288-1299` |
| Policy copy and verify | `:2516-2536` |
| Quiesce exec | `:1920-1923`; preflight `:1621-1642` |
| Exact Cloudflare deletion | `destroy-explorer-qa.yml:708-814` |
| Guarded workspace removal | `destroy-explorer-qa.yml:879-925` |
| Protected snapshot | `deploy-explorer-qa.yml:1126-1175`, `:3028-3033` |
| Sliced locked-script tests with stub engines | `deploy-qa-auto-selection.test.mjs:9-80` |

## Acceptance criteria (MUST be measurable)

Run from `/Users/danielsava/work/file-parser/AssistOSExplorer`.

| ID | Requirement | Check |
| --- | --- | --- |
| AC1 | Suite green and actually exercised | `node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs` exits 0 with `fail 0`, and its TAP lists at least 1 test from `qa-teardown.test.mjs`, `deploy-qa-rebuild-workflow.test.mjs` and `deploy-qa-destroy-workflow.test.mjs` |
| AC2 | Explorer unit references fixed | `node --test explorer/tests/unit/optionalAgentDefaults.test.js explorer/tests/unit/retiredLocalModelGraph.test.js` exits 0. Any skip is reported, not counted as a pass. |
| AC3 | Repository smoke lib | `node --test 'tests/smoke/lib/*.test.mjs'` exits 0 (siblings present) |
| AC4 | Exactly two workflows | `ls .github/workflows` prints exactly `deploy-explorer-qa.yml` and `destroy-explorer-qa.yml` |
| AC5 | Removed scripts | `ls .github/scripts` prints exactly `check-no-wait-readiness.mjs`, `qa-teardown-privileged.mjs`, `qa-teardown.mjs`, `quiesce-explorer-qa.mjs`, `reconcile-qa-soul-settings.mjs`, `rollback-explorer-qa.mjs`, `update-explorer-qa.mjs` |
| AC6 | No stale references | `rg -n 'rollback-explorer-qa\.yml\|cleanup-explorer-host\|inspect-explorer-host-storage\|verify-explorer-qa-runtime\|verify-retired-source-absence\|qa-backups\|QA_BACKUP_DIR\|QA_RESUME\|hold-workspace-lock\|Rollback reference\|operation=resume' .github docs/deploy-explorer-qa.md docs/specs docs/architecture.html AGENTS.md tests explorer/tests` prints nothing |
| AC7 | Deploy makes no backups and no renames | `rg -n 'container rename\|\.qa-deployment-backups\|redeploy-XXXXXXXX' .github/workflows/deploy-explorer-qa.yml` prints nothing |
| AC8 | Route table | `deploy-qa-auto-selection` cases R1-R10 with a stub `qa-teardown.mjs`. A stopped exact Box (R6) gives exit 43 and `select` is never called: **fails at base** (base exits 1). Marker plus running Box (R5) gives 43 with no select. Stub exits 42 or 43 from `route` give 1. Handler: 43 writes `updated=false\noperation=rebuild\n`. |
| AC9 | Reconcile re-proof | Sliced: `OPERATION=rebuild` with route `fresh`, or `OPERATION=update` with route `select`, exits 1 before `mark`. Static: the index of `# BEGIN QA install marker` is greater than the index of the route re-proof. |
| AC10 | Keep-set | `qa-teardown.test.mjs` fixture of the observed layout (`testN2/…`, `WebMeet/…`, `test1.backlog`, `.env`, `.data/userPersistoAgent/…`, `.ploinky/{repos,box,agents.json,edge-desired.json,profile}`, `.ploinky/data/{master-key,.secrets,passwords.enc,ploinky_subject_identity_ed25519_v1.enc,edge-routing,edge-publication,router-security}`, `.runtime/ploinky`, `AdvancedLanguageAgent`). After keep-data `reduce`, the recursive listing equals K exactly, identity sha256/uid/mode are unchanged, and top-level inodes are unchanged. A second run gives `delete:[]`. |
| AC11 | Refusals change nothing | One fixture per refusal in contract 1. Each exits with its code, and a recursive `{path,type,sha256}` listing is byte-identical before and after. |
| AC12 | Stash | Rebuild scope creates a stash `diff -qr`-equal to the live files. An existing stash is untouched when the live files differ. A leftover `.tmp-*` is discarded. Q2 (b): destroy keep-data leaves no `S/router-security`. Q2 (a): it leaves one. |
| AC13 | Delete-data | W and S are absent afterwards. A sentinel sibling directory and `/home/admin`-like siblings in the fixture are unchanged. |
| AC14 | Containers and images only QA-owned | Stub engines record calls. Order is quiesce, stop, `rm` (no `-f`). A stopped legacy Box is removed. A running legacy Box in rebuild is refused. A foreign label on a QA-named container is refused. An unreferenced `ploinky-box` image gives `image rm <id>` (no `-f`). An image referenced by a non-QA container is never removed. A QA volume in keep-data is refused. Q1 (a) or (b): only regex-matching backup names are removed and an unrecognized entry remains. |
| AC15 | Crash points | For each row of the crash-point table, a fixture produced by injecting a failure into `execute` or `reduce` after N operations gives the listed route. Running that route to completion yields exactly K. |
| AC16 | Never two Boxes, marker lifecycle | Static checks:<br>• `qa-teardown.mjs" execute --scope` occurs before `prepareBoxForCommand` in Reconcile.<br>• `complete --lock-held` occurs once, after `Protected host resource identities remained unchanged` and before `Explorer QA Box is ready`.<br>• `mark` occurs once, before `execute`. |
| AC17 | Policy restoration from the stash | Sliced `:2516` block: with a fixture stash it copies the 4 files and `diff -qr` passes. With no stash it copies nothing and logs `fresh access policy`. |
| AC18 | Destroy workflow | `deploy-qa-destroy-workflow.test.mjs`:<br>• The only input is `delete_data` (`boolean`, `default: false`).<br>• The flock prefix is present.<br>• `CLOUDFLARE_API_TOKEN` is not in the host env file.<br>• The Cloudflare step is a runner step that rejects the protected ID.<br>• `bash -n` of the remote heredoc passes.<br>• `rg` finds no `prepareBoxForCommand`, `start explorer` or `" destroy` in the file. |
| AC19 | Destroy works without a runtime | Sliced host script with stub engines on a preserved-data-only fixture (no `.runtime`) exits 0: **fails at base** (`:313-317` "dedicated QA Ploinky runtime is missing") |
| AC20 | Protected resources | `protected-snapshot` output is byte-identical to the old inline output for the same stub inventory, and excludes QA-labelled resources (`:1143`) |
| AC21 | Capacity | Sliced with stub `du`/`statfs`: free + reclaimable ≥ 16 GiB passes; less fails before `mark` |
| AC22 | Fail-before evidence | `git worktree add <scratchpad>/base <implementation base>`, copy only the new and changed tests there, run them. AC8 (R6), AC15 and AC19 fail at base and pass on the candidate. Record both outputs. |
| AC23 | Docs | `rg -n 'rollback\|resume\|retention\|25 GiB' docs/deploy-explorer-qa.md docs/specs/DS002-ploinky-runtime.md docs/architecture.html AGENTS.md` prints no QA-deploy statement. `rg -c 'delete_data' docs/deploy-explorer-qa.md AGENTS.md docs/specs/DS002-ploinky-runtime.md` ≥ 1 each. |
| AC24 | Lint | `actionlint .github/workflows/*.yml` if installed; otherwise report it as not run |
| AC25 | Root and subuid ownership | The privileged `qa-teardown.test.mjs` cases run on the apparatus host with `sudo` against root-owned and subuid-owned fixture files, and pass. Never use local Podman or root on this Mac. |
| AC26 (live, pending approval) | Live sequence | See "Review, verification and gates" |

## Adversarial probes the implementer MUST run

| Category | Probe | Expected |
| --- | --- | --- |
| Boundary | Top-level names that are unicode, 255 bytes long, or start with `-`; an empty W; W with only `.ploinky/data/master-key`; an empty `.ploinky` | Kept as K or reduced; nothing outside the deletion set is touched |
| Idempotency | `execute` twice; destroy twice; deploy R3 twice after an injected tail failure | The second run is a no-op or finishes; K is unchanged |
| Orphan | Marker with W absent and a stash present; a stash without a marker; a legacy Box whose backup directory is gone | Refuse, refuse (R10), removed as a container |
| Concurrency | Host flock held while running `route`, `mark`, `execute`, `complete` and the destroy host step | Exit 75 or `QA_TEARDOWN_HOST_LOCK_REQUIRED`; no calls recorded |
| Error injection | Quiesce fails (first attempt fatal, marker-predating attempt warns); `image rm` refused; `sudo -n` fails; an engine `ls` fails; a mount on another device below W | Exit 1 before deletion, or the crash-table state |

## Review, verification and gates

| Topic | Requirement |
| --- | --- |
| Route | Formal SPEC and then `plan-reviewer`. This change introduces irreversible deletion, crash recovery and resource ownership on a shared host. |
| Code-review slices (`code-reviewer`) | **S1 (highest risk):** `qa-teardown*.mjs` and `qa-teardown.test.mjs`.<br>**S2:** deploy workflow (route, rebuild, marker, tail) and the auto-selection, in-place, rebuild, node-runtime and contract tests.<br>**S3:** destroy workflow and its test.<br>**S4:** deletions, `rollback-explorer-qa.mjs` dead code, `qa-rollback.test.mjs`, the two explorer unit tests.<br>**S5:** docs, DS002, `architecture.html`, `AGENTS.md`; author checks plus consistency with S2 and S3. |
| Independent verification | `implementation-verifier` runs AC10-AC15, AC25 and the probes on the frozen candidate; the Linux and root parts run on apparatus. `test-runner` runs AC1-AC3, AC22 and AC24. The workflows re-run the suites on Ubuntu with Node 24 before SSH. |
| Candidate identity | Base: the post-resume `origin/main` SHA. Frozen diff: `git -C /Users/danielsava/work/file-parser/AssistOSExplorer diff <base> -- . ':(exclude)*_claude.md' ':(exclude)*_codex.md' \| shasum -a 256`, recorded at review time. |
| Gates that apply | `AGENTS.md:42`: HTML docs and DS files in the same change. Workspace commit policy: human author only, no AI attribution, commit and push only when authorized. After the recreate: `AGENTS.md:117-119` and the real-browser release gates in `docs/deploy-explorer-qa.md`. The `ploinky-proxy` gate does not apply (this is `main`). |
| Live sequence (each step needs the user's approval) | **L0:** the resume fix is merged and QA is up (decision 4).<br>**L1:** merge.<br>**L2:** deploy with no inputs. Expect `Deployment route: …"route":"select"`. In-place applies only when nothing besides AssistOSExplorer drifted; `.github`, `docs`, `tests` and root `*.md` are skipped by `classifyChanges` (`update-explorer-qa.mjs:93-95`). Otherwise expect `rebuild`, whose receipt removes `d4ada362…`.<br>**L3 (acceptance):** destroy with `delete_data` unticked. The receipt keep list contains `.data`, `testN2`, `WebMeet`, `test1.backlog` and the identity sha256s; the Cloudflare deletion is verified; legacy backups per Q1. Then deploy: route `fresh`, `created=true` tunnel, identity sha256s equal to L3's, ready, public URL and topology steps pass, sign-in with an existing account succeeds.<br>**L4:** the browser release gates (pending). |
| Approval vs release | Source approval (AC1-AC25 and the reviews) allows the merge once the user authorizes it. L2-L4 stay pending until each is dispatched. |

## Open questions / risks

| ID | Item |
| --- | --- |
| Q1, Q2 | See the top of this document |
| R1 | Every rebuild deletes and re-pulls the outer image (1.4 GB) and the nested image cache (~9.5 GB). The old redeploy also regenerated the nested cache. This is accepted so that an image change always converges. |
| R2 | The workspace archive lock is dropped. Serialisation relies on the concurrency group plus the host flock, which destroy now also takes. A manual `ploinky` command run on the host during a rebuild is out of contract. |
| R3 | An unknown `.ploinky/data` entry on the live host blocks rebuild and destroy-keep-data until a reviewed change classifies it. The known set comes from Ploinky `f2b2c4d1` source greps; it is inferred complete, not verified on the host. |
| R4 | GitHub replaces a pending run in the same concurrency group, so a queued deploy can be cancelled by a later destroy dispatch. A running job is never cancelled. |
| R5 | Destroy has no separate confirm box any more; the dispatch itself is the confirmation. `delete_data` defaults to keeping data. |
| R6 | Deleting `verify-retired-source-absence.yml` removes a push/PR CI gate. Its test still runs in the repository smoke suite. |
| R7 | The inspect workflow is gone, so host-state evidence now comes only from the route, plan and teardown receipts that both workflows print |
| R8 | Not verified: whether `prepareBoxForCommand` pulls when the tag is cached (removing the image makes this moot), and the session-revocation effect behind Q2 |
| Alt | Keeping the filename `rollback-explorer-qa.mjs` avoids churn. Renaming it to a library name is a reasonable follow-up. |

## Implementation order (build sequence)

1. `qa-teardown-privileged.mjs` (plan, reduce, stash, clear-state, legacy backups) and its fixture tests. Checkpoint: AC10-AC13, plus AC25 on apparatus.
2. `qa-teardown.mjs` (inventory, route, mark, execute, complete, protected-snapshot). Checkpoint: AC14, AC15, AC20, plus the probes.
3. Deploy workflow: in-place route and handler. Checkpoint: AC8.
4. Deploy workflow: Reconcile re-proof, capacity, mark and execute, tail edits, complete, summary; delete the old blocks. Checkpoint: AC7, AC9, AC16, AC17, AC21, plus `bash -n` of the REMOTE heredoc.
5. Destroy workflow rewrite. Checkpoint: AC18, AC19.
6. Deletions, the `rollback-explorer-qa.mjs` dead code with LSP proof, the test retargets. Checkpoint: AC2, AC4-AC6, AC1.
7. Docs, DS002, `architecture.html`, `AGENTS.md`. Checkpoint: AC23.
8. Full suites, fail-before worktree, lint, frozen hash, then the reviews. Checkpoint: AC1, AC3, AC22, AC24.

---

**What I checked and what is unverified**

| | |
| --- | --- |
| Read in this session | `AGENTS.md`, both QA plans, the deploy workflow (`:1-3045` and `:3226-3301`), the whole destroy workflow, and the relevant parts of `rollback-explorer-qa.mjs`, `update-explorer-qa.mjs`, `qa-backups*.mjs` and the tests. Also Ploinky `initializeFreshEdgeRoutingSources` (`cli/sandbox/edgeGeneration.js:309-361`) and the policy store path, `inspect.json.txt` and the failed run log. |
| Unverified | The complete set of names under `.ploinky/data` on the host (R3), the revocation and signing-key relationship (Q2), and the line drift between this tree and the post-resume base |

Paths:
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/workflows/deploy-explorer-qa.yml`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/workflows/destroy-explorer-qa.yml`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/scripts/rollback-explorer-qa.mjs`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/.github/scripts/qa-backups-privileged.mjs`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/docs/deploy-explorer-qa.md`
- `/private/tmp/claude-501/-Users-danielsava-work-file-parser/1bd16c61-3acd-4023-bb70-a898e65267cc/scratchpad/inspect.json.txt`

---

## User decisions (Daniel, 2026-10-21)

| ID | Decision |
| --- | --- |
| Keep-set | "Keep all user files": with `delete_data` unticked, keep every top-level workspace entry except `.ploinky`, `.runtime` and `AdvancedLanguageAgent` (so `.data`, the documents `testN2/`, `WebMeet/`, `test1.backlog`, and `.env`), plus the `.ploinky/data` identity files (contract 1). |
| Q1 | (a) Destroy deletes the legacy backups under `/home/admin/.qa-deployment-backups` in BOTH modes (regex-matched names only, per contract 4 step 8). Deploy never touches them. |
| Q2 | (a) Destroy with `delete_data` unticked keeps the router access policy: stash it in `/home/admin/.qa-deployment-state/router-security`; the next deploy restores it. |
| Order | This plan is implemented only after the resume fix is merged and QA is back up. |

---

## Lead decisions on the r1 review (2026-10-21)

| ID | Decision |
| --- | --- |
| D1 | Keep today's second-level `.ploinky` rule (matches "keep all user files"). |
| D2 | Keep-data destroy: quiesce failure is fatal (nothing deleted, QA left up). Delete-data: skip quiesce. |
| D3 | Keep the retired-source scan inside the deploy test step. |
| D4 | Keep-data destroy writes a `destroy-keep` marker. |

---

# Revision r2

This revision replaces or adds the sections listed below. Every other r1 section stands as written and as amended by "User decisions (Daniel, 2026-10-21)". I checked each finding against the code before revising it, as shown under each section. I stayed read-only; the only command I ran against GitHub was the read-only `gh api` check in "D3 evidence".

| r2 section | Supersedes or extends in r1 |
| --- | --- |
| Contract 1 r2 (keep-set) | Interfaces, contract 1 |
| Contract 2 r2 (state directory) | Interfaces, contract 2 |
| Contract 3 r2 (route) | Interfaces, contract 3 |
| Contract 4 r2 (execute) | Interfaces, contract 4 |
| Contract 5 r2 (Reconcile order) | Interfaces, contract 5 |
| Contract 6 r2 (destroy) | Interfaces, contract 6: the "Steps" and "Host script" rows |
| Contract 7 r2 (capacity) | Interfaces, contract 7 |
| Contract 8 (protected snapshot), new | Extends "Files to modify" row `…:1126-1264` |
| Crash-point table r2 | The crash-point table under "Data flow" |
| Files to modify and delete, delta | Rows named below; the rest of r1 stands |
| Acceptance criteria, delta | AC6, AC10, AC11, AC12, AC14, AC15, AC22, AC25 replaced; AC27 to AC35 added |
| Adversarial probes, additions | Added rows |
| Review, verification and gates, delta | The "Independent verification" row; the D3 evidence is added |
| Open questions / risks, delta | R3 and R6 replaced; R9 to R12 added |
| Implementation order r2 | Implementation order |

---

## Contract 1 r2: keep-set K (keep-data mode), relative to `W=/home/admin/explorerQaWorkspace`

The r1 keep-set was narrower than today's preservation rule (finding F2, confirmed). The current preservation test keeps all of these through a redeploy: `.ploinky/profile`, `.ploinky/code/local.mjs`, `.ploinky/skills/authored/SKILL.md`, `.ploinky/servers.json`, `.ploinky/ploinky_history`, `.ploinky/operator-notes.md` and `.ploinky/data/custom-store/authored.txt` (`deploy-qa-preservation.test.mjs:52-58`). Decision D1 restores today's rule at the second level.

| Class | Paths | Source |
| --- | --- | --- |
| Kept, top level | Every entry of W except `.ploinky`, `.runtime` and `AdvancedLanguageAgent` | `deploy-explorer-qa.yml:1993-1994` |
| Kept, inside `.ploinky` | Every `.ploinky/<name>` whose name is not in `runtimeEntries`. This includes the legacy identity names at `.ploinky/`, `profile`, `servers.json`, `ploinky_history`, `edge-desired.json` (which the deploy rewrites) and any unknown name. | `:1998-2003`, `const runtimeEntries = new Set(['agents.json', 'routing.json', 'running', 'run', 'logs', 'box', 'deps', 'repos', 'agentlib', 'container-runtime', 'graph-skill-scope.json', 'data', 'enabled_repos.json', 'repo_sources.json', 'unregistered_agent_repos.json']);` |
| Kept, inside `.ploinky/code` and `.ploinky/skills` | Every first-level entry that is a real file or directory (not a symlink) | D1. Ploinky creates `.ploinky/code/<agent>` and `.ploinky/skills/<agent>` as symlinks, and leaves a real file in place with only a warning (ploinky `cli/utils/workspaceStructure.js:49-66`). |
| Kept, inside `.ploinky/data` | Every `.ploinky/data/<name>` except `edge-routing`, `edge-publication` and `router-security`. This includes the identity files and custom stores. | `:2013-2014` |
| Deleted | `.runtime`, `AdvancedLanguageAgent`, every `.ploinky/<name>` in `runtimeEntries` other than `data`, the first-level symlinks in `.ploinky/code` and `.ploinky/skills`, `.ploinky/data/{edge-routing,edge-publication}`, `.ploinky/data/router-security` (after it is stashed, contract 2), and the workflow's own staging files `.ploinky/.explorer-qa-edge-desired.json` and `.ploinky/.explorer-qa-cloudflare-credentials.json` | `:2591` and `:2669`. A leftover credentials file holds plaintext Cloudflare tokens, so it is never kept. |
| Identity fingerprint | Every present `AUTH_FILES` entry (`rollback-explorer-qa.mjs:35-38`): `{relative, sha256, uid, gid, mode, nlink}` | Unchanged from r1 |

Refusals, which delete nothing (exit 1). The r1 refusal of unknown `.ploinky/data` names is withdrawn, because D1 keeps them.

| Code | Condition | Scope |
| --- | --- | --- |
| `QA_TEARDOWN_RETIRED_IDENTITY` | Any of `.ploinky/{master-key,.secrets,ploinky_subject_identity_ed25519_v1.enc}` is present | Deploy scopes only (`rebuild`, `fresh`), as admission does at `:1294-1296`. Destroy keeps these files and never deletes them in keep-data mode. |
| `QA_TEARDOWN_KEY_MISSING` | `.data` is present but `.ploinky/data/master-key` is not | All keep-data scopes (`:1299`) |
| `QA_TEARDOWN_UNSAFE_PATH` | W, `.ploinky`, `.ploinky/data`, `.ploinky/code`, `.ploinky/skills`, `.data` or `.runtime` is a symlink or not a directory; or an identity file is not a regular file with `nlink === 1` | All keep-data scopes (`:1279-1281`, `:1291`) |
| `QA_TEARDOWN_MOUNT_INSIDE` | `/proc/self/mountinfo` lists a mount at or under W, at or under any deletion target, or (for legacy backups) at or under the backups root or one of its entries; or a target's `st_dev` differs from W's | All scopes, including delete-data. This reuses `parseMountPoints`, `readMountPoints` and `assertNoMount` (`qa-backups-privileged.mjs:43-55`, `:96-102`) and is checked again before each removal. |

The proof is a recursive listing. `plan-workspace` records K as a recursive `{path, type, ino, size}` listing, plus the identity fingerprint. `reduce-workspace` requires the plan digest to match, deletes, recomputes both, and requires them byte-identical to the plan. A second run reports `delete: []`.

## Contract 2 r2: state directory `S=/home/admin/.qa-deployment-state` (admin, mode 700)

| Entry | Contract |
| --- | --- |
| `install-pending.json` | `{version:1, operation:"update"\|"rebuild"\|"destroy-keep", createdAt, dispatch}` |
| Who writes the marker | `mark` in the deploy (contract 5, step 11). The destroy in keep-data mode writes `operation:"destroy-keep"` itself, after the containers are removed and before the stash and the reduction (decision D4). |
| `router-security/` (the stash) | Written as before: a temporary copy, then `cp -a`, then `diff -qr`, then a rename. It is never overwritten while it exists. |
| After a successful restore | Once the restore at `:2516-2536` passes `diff -qr`, the stash is removed immediately, before `ploinky start` (finding F6). The removal renames it to `router-security.removing-<pid>` and then deletes that, so a leftover `.removing-*` is discarded on the next run. From that point the live `router-security` is the authority, and a later rebuild stashes it again from live. |
| `complete` | Removes only the marker. The stash is already gone. If a stash is still present here, `complete` refuses with `QA_TEARDOWN_STASH_NOT_RESTORED`. |
| Destroy, delete-data | Removes all of S |

## Contract 3 r2: `node qa-teardown.mjs route --lock-held`

The output adds the fields the preflight needs (finding F9):

`{"result":"routed","route":…,"reason":…,"marker":{"operation":…}|null,"stash":bool,"exact":{"engine","id","running"}|null,"legacy":[{"engine","id","name"}]}`

Row changes against r1. The other rows stand.

| Row | Workspace W | QA containers | Marker / stash | Route |
| --- | --- | --- | --- | --- |
| R1 | absent | none | no marker and no stash, or a marker without a stash | `fresh` |
| R1b (new) | absent | none | a stash, with or without a marker | refuse `QA_ROUTE_STASH_WITHOUT_WORKSPACE` |
| R3 | real directory | none, or only stopped legacy Boxes | any marker (including `destroy-keep`), with or without a stash; or no marker and no stash | `fresh`. With a stash, the tail restores it. |
| R10 | real directory | any | a stash without a marker | refuse `QA_ROUTE_STALE_POLICY_STASH`. This state no longer arises from any workflow path: a keep-data destroy writes its marker before stashing. |

## Contract 4 r2: `qa-teardown.mjs execute`

New signature:

`execute --scope rebuild|fresh|destroy --mode keep-data|delete-data --quiesce fatal|warn|skip --plan-digest <D> --lock-held`

The r1 flag `--legacy-backups` is dropped: user decision Q1 (a) makes legacy-backup removal part of `--scope destroy` in both modes.

1. Recompute the inventory and the workspace plan. Refuse if a refusal appears that the pre-mark plan (contract 5) did not show. The workspace part is planned again after the containers are stopped, because a running Box keeps writing to W. A refusal at that point leaves the "no containers, W ⊇ K" state, which route R3 handles.
2. Quiesce, as before. `--quiesce fatal` exits 1 when quiesce fails. In a keep-data destroy this happens before anything is stopped or deleted, so QA stays up (decision D2). The destroy runs the quiesce preflight first (`QA_QUIESCE_PREFLIGHT_ONLY=1`, as at `:1626-1630`).
3. Stop and remove the containers, as before.
4. Images (finding F7). The only candidates are the `.Image` IDs of the QA containers removed in step 3. An ID is removed only when no remaining container in that engine references it: first `<engine> image untag <id>`, then `<engine> image rm <id>` (never `-f`). A failure to remove a candidate is fatal in every scope; the state left behind is covered by the crash-point table. A candidate still referenced by a non-QA container is retained and logged as `retained-in-use`, which is not a failure. Any other `docker.io/assistos/ploinky-box` image in the store is never removed; it is logged as `foreign-ploinky-box-image-retained` with its ID and tags.
5. Volumes: unchanged from r1.
6. Workspace. In keep-data mode, scope `destroy` first writes the `destroy-keep` marker (contract 2). Then, in every scope: stash the policy if live `router-security/policy-state.json` exists and there is no stash, then run `reduce-workspace`. In delete-data mode, remove W and then S. All workspace deletion runs in the privileged program with the mount guard from contract 1.
7. Legacy backups (scope `destroy`, both modes, user decision Q1 (a); finding F5). A directory `redeploy-XXXXXXXX` is removed only when one of these holds:
   - It holds a regular file `preservation.json` with `exactCopiesVerified === true` and no `failed-workspace/`.
   - It holds no `workspace/` and no `failed-workspace/`.

   A `-helpers` or lock-receipt sibling is removed only when its backup was removed or is absent. A `.pruning-redeploy-XXXXXXXX` tombstone is removed. Every other entry is kept and listed in the receipt as `{name, reason}`. The guards are: owner admin, not a symlink, the same device, and no mount (contract 1).
8. The receipt adds `retainedImages` and `retainedBackups`.

## Contract 5 r2: Reconcile order (deploy `rebuild` and fresh install)

This fixes findings F3, F4 and F9: the helpers and Node are staged in one place, before the route re-proof, and the workspace plan runs before `mark`.

1. Identity checks (`:1025-1124`) and the helper integrity check (`:1002-1023`, covering the new sources).
2. Install the QA Node (`:1356-1438`, moved up).
3. Stage the helpers, the only staging location: `/tmp/explorer_qa_helpers.XXXXXX`, holding `qa-teardown.mjs`, `qa-teardown-privileged.mjs`, `rollback-explorer-qa.mjs` and `quiesce-explorer-qa.mjs`, each checked against its SHA with `sha256sum -c`.
4. Protected snapshot, through `node "$QA_HELPERS_DIR/qa-teardown.mjs" protected-snapshot`.
5. Route re-proof with the staged helper. Parse `exact.engine`, `exact.id` and `exact.running` into `QA_EXACT_ENGINE`, `QA_EXACT_ID` and `QA_EXACT_RUNNING`, and `marker` into `QA_MARKER_AT_ROUTE`.
6. Preservation admission (`:1265-1351`), only when W exists and `QA_MARKER_AT_ROUTE` is null.
7. Early fast-forward check (`:1519-1528`).
8. Quiesce preflight (`:1621-1642`). It now reads `QA_EXACT_ENGINE`, `QA_EXACT_ID` and `QA_EXACT_RUNNING` instead of `QA_CONTAINER_RECORDS` (`:1623-1625`). It runs for `rebuild` when the Box is running and there was no marker.
9. `qa-teardown.mjs plan --scope … --mode keep-data`, read-only: the workspace plan (contract 1, run as root) plus the container and image plan. A refusal here exits 1 with nothing stopped. Print `[deploy-qa] Teardown plan: {…digest…}`.
10. Capacity (contract 7), which reads its numbers from that plan.
11. `mark`, the first mutation.
12. `execute … --plan-digest <D>`.
13. The tail, unchanged from r1, except that the stash is removed right after the restore passes (contract 2).
14. `complete`.

## Contract 6 r2: `destroy-explorer-qa.yml` (replaces the "Steps" and "Host script" rows)

| Aspect | Contract |
| --- | --- |
| Steps | Checkout and setup Node 24. Then run `QA_TEARDOWN_PRIVILEGED_TESTS=1 node --test tests/smoke/lib/qa-teardown.test.mjs tests/smoke/lib/deploy-qa-destroy-workflow.test.mjs`. Then validate the configuration, pin SSH, run the host teardown, delete the Cloudflare publication from the runner (unchanged from r1), write the summary and clean up. |
| Host script | 1. Identity checks and the QA Node.<br>2. Stage the helpers (SHA-checked).<br>3. Protected snapshot.<br>4. `plan --scope destroy --mode …`, read-only.<br>5. `execute --scope destroy --mode keep-data --quiesce fatal`, or `--mode delete-data --quiesce skip` (decision D2).<br>6. Protected snapshot again and compare.<br>7. Soul health check. |
| Outcome of a keep-data destroy | W reduced to K, S holding `install-pending.json` with `operation:"destroy-keep"` plus the policy stash, no QA containers, no QA image. The next deploy takes route R3 (`fresh`) and restores the stash (decision D4). |
| Outcome of a delete-data destroy | No W, no S, no QA containers, no QA image, no legacy backups. `/home/admin/.ploinky-box` is left in place (R9). |

## Contract 7 r2: capacity (runs as root, after the read-only plan, before `mark`)

The rule is `free + reclaimable ≥ 16 GiB + pullBytes`.

| Term | Value |
| --- | --- |
| `reclaimable` | The allocated size of the plan's deletion targets, measured with `allocated()` (`:1690-1711`), plus the bytes of the QA image IDs the plan removes |
| `pullBytes` | The bytes of the exact Box's current image (from the image inspect `Size`), or 2 GiB when there is no QA image. The removed outer image is pulled again. |

The observed QA image is 1414184938 B (`inspect.json.txt`). A capacity failure is fatal, and nothing has been mutated at that point.

## Contract 8 (new): protected snapshot covers images

`protected-snapshot` keeps the record format of `:1126-1170`. For each protected (non-QA) container it adds `{engine, kind:"image", id, tags}` for the container's image, sorted.

`tags` excludes the QA Box reference `docker.io/assistos/ploinky-box:latest`. A fresh pull may legitimately move that tag; if a non-QA container also used it, the move would otherwise fail every deploy after the new QA is already up (R10).

## Crash-point table r2 (replaces r1)

| Failure point | State left | Next deploy |
| --- | --- | --- |
| Before `mark` (including a plan or capacity refusal) | Untouched running QA | R4 `select` |
| After `mark`, during quiesce or stop | Marker, Box running or stopped | R5 or R6 `rebuild` (quiesce `warn`) |
| During container or image removal | Marker, a subset of containers or images | R6 if the exact Box remains, otherwise R3 |
| During the stash | Marker, live policy untouched, perhaps a `.tmp-*` | R3 or R6. The leftover is discarded and the policy is stashed again from live. |
| During the reduction | Marker and stash, no containers, W ⊇ K | R3, which reduces again |
| Tail, after edge init and before the restore | Marker and stash, a new exact Box, fresh empty policy live | R5 or R6 `rebuild`. The stash is kept and restored. |
| Tail, after the restore passed and the stash was removed | Marker, no stash, restored policy live, a Box | R5 or R6 `rebuild`. The policy is stashed again from live. |
| During the stash removal | Marker, a `.removing-*` leftover, restored policy live | The leftover is discarded and the policy is stashed from live |
| Keep-data destroy: quiesce or preflight fails | No marker, running Box, nothing deleted | R4 `select` |
| Keep-data destroy: after the containers are removed, before the marker | No containers, W full, no marker | R3, which reduces. This assumes no stash yet; the live policy is stashed by the deploy. |
| Keep-data destroy: after the marker, at any later point | `destroy-keep` marker, with or without a stash, W ⊇ K | R3, which reduces and restores the stash if present |
| After `complete`, in the runner-side checks | Running Box, no marker | R4 `select` |

## Files to modify and delete (delta)

| Path:lines | Change |
| --- | --- |
| `.github/workflows/deploy-explorer-qa.yml:70-72` | The test step becomes `QA_TEARDOWN_PRIVILEGED_TESTS=1 node --test tests/smoke/lib/deploy-*.test.mjs tests/smoke/lib/qa-*.test.mjs tests/smoke/lib/retired-source-absence.test.mjs`. The retired-source scan now runs on every deploy (decision D3). |
| `…:1002-1023`, `:1356-1438`, `:1530-1548` | Helpers and Node are staged before the route re-proof (contract 5, steps 1-3), and only there |
| `…:1621-1642` | The preflight reads `QA_EXACT_*`. `QA_CONTAINER_RECORDS` no longer exists. |
| `docs/specs/DS002-ploinky-runtime.md:54` | Replace "the QA deploy workflow, its runtime verifier, and the QA rollback prediction" with "the QA deploy workflow and `EXPECTED_DEFAULT_GRAPH`" |
| `tests/smoke/lib/deploy-qa-preservation.test.mjs` | Not deleted (this replaces the r1 delete entry). Retarget the `:50-58` fixture into `qa-teardown.test.mjs` (AC10). Move `:102-116` (bootstrap `.env`), `:117-225` (admission cases) and `:440-468` (tunnel lookup) into `deploy-qa-rebuild-workflow.test.mjs`, still slicing the retained blocks. Delete the remaining tests, which cover the removed preservation, copy and capacity behaviour (`:226-439`), and then delete the file. |
| `tests/smoke/lib/deploy-qa-userpersisto.test.mjs:145-146` | Re-anchor to `# END QA teardown` with `assert(anchor > 0)` before the ordering check. With a missing anchor, `indexOf` returns -1 and the current check passes falsely. |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:11-30` | Delete. The nested-inventory exec (`:1213-1221`) is removed together with the record loop. |
| `…:32-158` (the deploy `expected` list, specifically `:131-141` and `:155-157`) | Remove `Exact prior Explorer QA runtime retired`, `hold-workspace-lock.mjs`, `release_qa_workspace_lock`, `QA Box identity changed before workspace-lock acquisition`, `BEGIN QA durable workspace preservation`, `snapshot_protected_resources()` and `QA_VOLUME_ROLES=(workspace containers ploinky-deps)`. Add `BEGIN QA install marker`, `BEGIN QA teardown`, `qa-teardown.mjs" complete --lock-held` and `protected-snapshot`. Keep the rest. |
| The r1 "Files to delete" list | Drop `deploy-qa-preservation.test.mjs` from the list, per the retarget above |

## Acceptance criteria (delta)

| ID | Requirement | Check |
| --- | --- | --- |
| AC6 r2 | No stale references | Same `rg` command as r1. Tests that assert absence build their patterns from parts, joined at runtime, as `retired-source-absence.test.mjs:10-12` does, so the `rg` cannot match the tests' own assertion literals. The `rg` prints nothing. |
| AC10 r2 | Keep-set | Run `qa-teardown.test.mjs` on the retargeted `deploy-qa-preservation.test.mjs:52-58` durable list plus the observed layout (`testN2/`, `WebMeet/`, `test1.backlog`, `.env`), and add `.ploinky/code/explorer → ../repos/AchillesIDE/explorer` (a symlink) and `.ploinky/data/{edge-routing,router-security}`. After destroy keep-data: every durable entry is byte-identical; the three regenerated maps (`:59`), `agents.json`, `running`, `run`, `edge-routing`, `.runtime`, `AdvancedLanguageAgent` and the `code/explorer` symlink are absent; `router-security` is in S. The recursive `{path, type, ino, size}` listing of K is identical before and after, and a second run reports `delete: []`. In scope `rebuild` the same fixture refuses with `QA_TEARDOWN_RETIRED_IDENTITY` because of its `.ploinky/master-key`. Without the retired names it reduces exactly as destroy does. |
| AC11 r2 | Refusals change nothing | One fixture for each refusal in contract 1 r2. Each exits with its code, and a recursive `{path, type, sha256}` listing is identical before and after. |
| AC12 r2 | Stash lifecycle | The stash is created and `diff -qr`-equal to live. While it exists it is not overwritten. After the sliced restore block passes, it is absent and a leftover `.removing-*` is discarded. `complete` refuses while a stash is present. |
| AC14 r2 | Images limited to QA | With stub engines: a removed QA container's image gives `image untag <id>` then `image rm <id>`, never `-f`. An image shared with a non-QA container is logged `retained-in-use` and the run succeeds. A foreign `ploinky-box` image that no removed container used is never touched and is logged as retained. A stub `image rm` failure on a candidate exits 1 and leaves a crash-table state. |
| AC15 r2 | Crash points | Every row of crash-point table r2 has a failure-injection fixture that yields the listed route, and running that route to completion yields exactly K plus the restored policy |
| AC22 r2 | Fail-before evidence | Failing at base is trivial for the new modules (they are missing there) and does not count. The cases that must fail at base and pass on the candidate are: route R6 (stopped exact Box: base `select` exits 1); AC19 (destroy without a runtime: base stops at `destroy-explorer-qa.yml:313-317`); AC27 (the base destroy has no `delete_data` input and removes all of W); AC28 (at base the preflight reads `QA_CONTAINER_RECORDS`, which the new admission never fills). |
| AC25 r2 | Privileged cases | The privileged tests run only when `QA_TEARDOWN_PRIVILEGED_TESTS=1` and `sudo -n true` succeeds. They call `sudo -n "$(process.execPath)"`, because the runner has no `/usr/bin/node` guarantee, and they create root-owned and `100999`-owned fixture files with `sudo chown`. Otherwise they skip and name the reason. GitHub `ubuntu-latest` runners have passwordless sudo, so the deploy and destroy test steps set the variable. On the apparatus host the variable is required, and a skip there is a failure. On the Mac they skip; never use local Podman or root there. |
| AC27 (new) | Chained keep-data destroy, then route, then fresh install, then restore (finding F1) | Fixture: destroy keep-data `execute` gives a `destroy-keep` marker and a stash. `route` then gives `fresh` (R3), not R10. A sliced restore block then copies the stash into a fresh `router-security`, passes `diff -qr` and removes the stash. `complete` removes the marker. |
| AC28 (new) | The preflight runs before `mark` from the route output (finding F9) | Sliced with route JSON `exact:{engine:"podman",id:<64 hex>,running:true}` and a stub engine whose preflight-only exec returns a receipt that is not `preflight-passed`: exit 1, with no call to `mark`. Static check: `rg -n 'QA_CONTAINER_RECORDS' .github/workflows/deploy-explorer-qa.yml` prints nothing. |
| AC29 (new) | Plan before `mark` (finding F3) | Static order: `teardown plan` < capacity < `BEGIN QA install marker` < `execute`. Sliced: a plan refusal (`QA_TEARDOWN_RETIRED_IDENTITY`) exits 1 with no call to `mark`. |
| AC30 (new) | Mount guard (finding F10) | Unit test: a `mountPoints` hook that reports `W/.ploinky/box/images`, a deletion target, or the backups root and an entry gives `QA_TEARDOWN_MOUNT_INSIDE`, with an identical listing before and after, in both modes. On apparatus: run `sudo mount --bind <scratch> <fixtureW>/.ploinky/box/images` and confirm the same refusal from the real `/proc/self/mountinfo`. |
| AC31 (new) | Legacy backups (finding F5) | Fixtures that are removed: verified `preservation.json`; no `workspace/`; a tombstone; the sibling of a removed backup. Fixtures that are kept and reported: `workspace/` without `preservation.json`; `exactCopiesVerified: false`; a backup containing `failed-workspace/`; an unrecognized name; the sibling of a kept backup. |
| AC32 (new) | The retired-source scan still runs (decision D3) | `rg -n 'retired-source-absence\.test\.mjs' .github/workflows/deploy-explorer-qa.yml` prints the test-step line, and the deploy test step's TAP output lists that test as passing |
| AC33 (new) | No required check names a deleted workflow | `gh api repos/AssistOS-AI/AssistOSExplorer/rules/branches/main` prints `[]`, `gh api repos/AssistOS-AI/AssistOSExplorer/rulesets` prints `[]`, and `gh api repos/AssistOS-AI/AssistOSExplorer/branches/main/protection/required_status_checks` returns HTTP 404 "Branch not protected", all re-run at merge time. Any listed context matching `source-absence`, `Verify retired source absence`, `verify-explorer-qa-runtime` or `rollback` blocks the merge until it is removed. |
| AC34 (new) | Anchors cannot pass falsely | The `deploy-qa-userpersisto` anchor test fails on a candidate copy with `# END QA teardown` deleted, and passes on the candidate |
| AC35 (new) | Helpers staged once and checked (finding F4) | Static: exactly one `mktemp -d /tmp/explorer_qa_helpers`, and its index is smaller than the route re-proof's. Sliced: a tampered `QA_TEARDOWN_SOURCE` exits 1 before the route runs. |

## Adversarial probes (additions)

| Category | Probe | Expected |
| --- | --- | --- |
| Boundary | `.ploinky/code` containing a symlink to `/` and a real directory with the same agent name; `.ploinky/skills` itself a symlink | The link is deleted without being followed and the real directory is kept; a `skills` symlink is refused |
| Idempotency | Keep-data destroy twice, then deploy | The second destroy reduces nothing and keeps the marker and the stash; the deploy takes R3 and restores the stash once |
| Orphan | A stash with W absent (R1b); a `destroy-keep` marker with no stash | Refused; R3 `fresh` with fresh policy |
| Concurrency | Destroy dispatched while a deploy holds the host flock | Exit 75 before the plan runs, and nothing is quiesced |
| Error injection | Keep-data destroy whose preflight passes but whose real quiesce fails | Exit 1, no container stopped by the teardown, no marker, W unchanged |

## Review, verification and gates (delta)

| Topic | Requirement |
| --- | --- |
| Independent verification r2 | `implementation-verifier` runs AC10-AC15, AC27-AC31 and the probes. AC25, the privileged part of AC30 and the bind-mount probe run on the apparatus host. `test-runner` runs AC1-AC3, AC22, AC24 and AC32-AC35. |
| D3 evidence (observed 2026-10-21) | `gh api repos/AssistOS-AI/AssistOSExplorer/rules/branches/main` printed `[]`. `gh api repos/AssistOS-AI/AssistOSExplorer/rulesets` printed `[]`. `gh api repos/AssistOS-AI/AssistOSExplorer/branches/main/protection/required_status_checks` returned `{"message":"Branch not protected",…,"status":"404"}`. No required check names `verify-retired-source-absence.yml` today; AC33 repeats the check at merge time. |

## Open questions / risks (delta)

| ID | Item |
| --- | --- |
| R3 r2 | Under D1, unknown `.ploinky/<name>` and custom `.ploinky/data/<store>` entries are kept, as today's preservation keeps them. The cost is that stale non-runtime Ploinky state can survive a rebuild. The deploy rewrites `edge-desired.json`, and the three repository maps are regenerated because they appear in `runtimeEntries`. |
| R6 r2 | The push/PR workflow is deleted, but the retired-source scan runs inside every deploy (AC32). Pull requests no longer run it, and nothing requires it today (D3 evidence). |
| R9 | `/home/admin/.ploinky-box` (12288 B; the Ploinky lock and any per-workspace records; contents not inspected) is kept by both destroy modes, because other Boxes owned by admin may share it |
| R10 | The protected snapshot leaves out the `ploinky-box:latest` tag (contract 8). A non-QA container that uses that tag would lose its tag to a QA pull without the snapshot noticing. Its image ID stays protected. |
| R11 | When the real quiesce fails during a keep-data destroy after the preflight passed, the Box stays running but some nested services may already be stopped. A later deploy routes `select`; `restart` may be needed. |
| R12 | A keep-data destroy keeps the retired legacy identity files at `.ploinky/`. The next deploy refuses them at its read-only plan, before `mark`, until they are migrated into `.ploinky/data`. |

## Implementation order r2

1. `qa-teardown-privileged.mjs`: plan and reduce with D1, the mount guard, the stash lifecycle, and legacy backups per F5. Checkpoint: AC10-AC12, AC30 (unit), AC31.
2. `qa-teardown.mjs`: inventory, route r2, `plan`, `mark`, `execute` r2 (images per F7, the D4 marker), `complete`, `protected-snapshot` with images. Checkpoint: AC14, AC15, AC27, AC20.
3. Deploy, in-place step: route and handler. Checkpoint: AC8.
4. Deploy, Reconcile, in contract 5 r2 order: stage helpers and Node, re-proof, the preflight on `QA_EXACT_*`, plan, capacity, `mark`, `execute`, stash removal after restore, `complete`; the test step adds the retired-source scan. Checkpoint: AC16, AC17, AC21, AC28, AC29, AC32, AC35.
5. Destroy rewrite. Checkpoint: AC18, AC19.
6. Deletions and test retargets, including the preservation fixture, the userpersisto anchor and the contract ranges. Checkpoint: AC1, AC2, AC4-AC6, AC34.
7. Docs, plus DS002 `:54` and `:92`. Checkpoint: AC23.
8. Apparatus runs (AC25, the AC30 bind-mount probe), the fail-before worktree (AC22), lint, the frozen hash, the AC33 check, then the reviews.

**Verification status.** I checked these r1 statements against the code:

| Finding | Confirmed by |
| --- | --- |
| F1 | R10 conflicts with Q2 (a), as r1 wrote it |
| F2 | `deploy-qa-preservation.test.mjs:50-58` |
| F4 | r1 placed the re-proof at `:898` and the helpers at `:1530` |
| F9 | `:1623-1625` reads `QA_CONTAINER_RECORDS` |
| F10 | `qa-backups-privileged.mjs:96-102` (same-filesystem bind mounts keep their device) |
| D1 | `.ploinky/code` and `.ploinky/skills` are agent symlinks (ploinky `workspaceStructure.js:37-66`) |
| AC34 | The `deploy-qa-userpersisto.test.mjs:145` anchor passes falsely when its marker is missing |
| DS002 | `:54` names the deleted verifier and the rollback prediction |

Not verified:
- Podman's `image untag` followed by `image rm` on this host's Podman version.
- Whether passwordless `sudo` with `process.execPath` works on the current `ubuntu-latest` image.
- The contents of `/home/admin/.ploinky-box`.

---

## Plan review outcome and implementer notes (2026-10-21)

r1 review: REVISE. r2 delta review: APPROVE WITH CHANGES — one Important item, applied here as a targeted amendment (no further review round). Plan frozen.

| # | Amends | Note |
| --- | --- | --- |
| I1 (Important) | Contract 4 r2 step 7 | Legacy-backup deletion reuses the existing classifier: port `classify` (and `BACKUP_INNER_ENTRIES`, rollback markers incl. `rollback-result.json` and its `.json.<16hex>` journal temporaries, sibling rules) from `.github/scripts/qa-backups-privileged.mjs` into `qa-teardown-privileged.mjs`. Remove only the `PRUNABLE_CLASSES` (`complete-redeploy`: verified `preservation.json` with matching `source`/`target`, `policy-restoration.json` with `exactCopiesVerified`, `restored-selections.json` with a 64-hex `boxId`; and `no-workspace`). Keep and report `rollback-attempted`, `incomplete-redeploy`, `stop-attempted-unpreserved`, `unrecognized-entry`. AC31 adds three kept fixtures: `rollback-result.json` + verified preservation and no `failed-workspace/`; verified preservation but no `policy-restoration.json`; `preservation.source` not matching the backup's `workspace/`. |
| N1 | Contract 4 r2 step 4 | Record the candidate image IDs in the marker; a later run retries any still-dangling, unreferenced candidate, so a crash between `untag` and `rm` does not leak the ~1.4 GB image. |
| N2 | AC25 | Root/100999-owned fixtures are removed with `sudo -n rm -rf` in `t.after` on runners and apparatus. |
| N3 | AC30 | Also run `plan` while a rootless Box has a fixture bind-mounted, to prove no false `QA_TEARDOWN_MOUNT_INSIDE` (rootless mounts are in another namespace — confirm). |
| N4 | Contract 4 r2 step 1 | The pre-stop recompute covers containers and images only; the workspace re-plan follows step 3 (after stop). |
| N5 | In-place step | The route runs after the QA Node check (`:392-400`); state that R1 needs `/home/admin/.qa-deployment-tools` Node, which neither destroy mode removes. |
