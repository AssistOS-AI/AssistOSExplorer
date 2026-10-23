# Explorer QA update analysis (2026-10-19)

Scope: a read-only analysis of AssistOSExplorer `main` at `f8c930d6` against the existing QA install (`admin@45.136.70.141:/home/admin/explorerQaWorkspace`). I dispatched no workflow and touched no host. I edited no repository file except this report. Outside the repository I wrote four session-scratchpad files: three logs downloaded with read-only `gh run view --log` (`run_38405260417.log`, `run_38403649166.log`, `destroy_38400556470.log`) and a classifier script, `classify.mjs`, which was never run because the command was not approved. All four are in `/private/tmp/claude-501/-Users-danielsava-work-file-parser-AssistOSExplorer/9e3bbabd-1bce-4e81-892d-a9071f165b79/scratchpad/`. A repo-explorer subagent traced the Ploinky internals; I spot-checked its citations at `workspaceUtil.js:1480-1495` and `agents.js:1494-1548`.

## Verdict

**Option A does nothing useful.** Dispatching `deploy-explorer-qa.yml` as it stands rejects the update and changes nothing. All 16 old agents keep running, the stale ones included. **I recommend Option C, done as one preserving redeploy inside the deploy workflow.** Do not use `destroy-explorer-qa.yml`, because it has no backup step. The preservation machinery already exists and ran live on 2026-09-23, but it is currently unreachable. Before anything is dispatched it needs a reviewed change in four places: an admission input, a filter on prior selections (for both restore and readiness), a no-SSH rollback path, and tests.

## 1. In-place step

| Claim | Status | Evidence |
| --- | --- | --- |
| An existing workspace always takes `update-explorer-qa.mjs execute`. Exit 42 (workspace absent) is the only route to `updated=false` and the Reconcile step. Any other failure fails the job. | Observed | `deploy-explorer-qa.yml:343-354,367-374` |
| The range `fa8d9c25..f8c930d6` is rejected. It modifies `explorer/manifest.json` and `userPersistoAgent/manifest.json`, deletes 9 agent manifests, and adds the roots `roboTeamAgent/` and `soul-gateway/`. | Observed (diff); the rejection itself is Inferred (classifier not run) | `update-explorer-qa.mjs:89-97`; `git diff --name-status` |
| Before the rejection, the only mutation is a `git fetch` into `.ploinky/repos/AchillesIDE`. No receipt is written and nothing restarts. | Observed (code) | `update-explorer-qa.mjs:303-311,348` |
| Sibling repos, `ploinky enable` and the stopping or disabling of removed agents are never touched. | Observed | `:321` fast-forwards AchillesIDE only; `:463` targets only `restart AchillesIDE/<agent>` |
| Any change to the agent selection is forbidden. | Observed | `:215` `QA_UPDATE_SELECTION_CHANGED` |

```js
        prove(!/(?:^|\/)(?:manifest\.json|package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Dockerfile(?:\.[^/]*)?|docker-compose[^/]*|compose\.ya?ml|dependencies[^/]*|requirements[^/]*|\.gitmodules|\.gitattributes|\.npmrc)$/i.test(file)
            && !parts.some(part => /^(?:hooks|scripts|install|preinstall|postinstall|uninstall|migrations|vendor|node_modules)$/i.test(part))
            && !/^(?:pre|post)?(?:install|uninstall|start|stop|build)(?:[.-]|$)/i.test(name),
        'QA_UPDATE_REQUIRES_RECONFIGURATION');
```

Expected log (Inferred): `{"result":"failed","status":"rejected","code":"QA_UPDATE_REQUIRES_RECONFIGURATION"}` (or `QA_UPDATE_UNKNOWN_RUNTIME_PATH`), followed by `::error::In-place update failed. The deploy workflow will not recreate or destroy this installation.`

The Reconcile step refuses an existing workspace (Observed). Commit `e1eeceb5` added this gate; `git show` confirms it.

```bash
          assert_qa_bootstrap_absent() {
            if [ -e /home/admin/explorerQaWorkspace ] || [ -L /home/admin/explorerQaWorkspace ]; then
              echo '[deploy-qa] ERROR: fresh installation requires an absent QA workspace; use in-place deployment for an existing installation.' >&2
              return 1
```

The gate is checked at `:748` and again at `:1374`. As a result, today's preservation block (`:1409-1484`) and the replay of "prior agent choices" (`:2169-2211`) only ever see an empty prior state, so they cannot re-enable multimedia. Pre-gate run 35859121829 (2026-09-23) did run them against a live predecessor (Observed): `Prior workspace retained; durable files ... copied and compared`, `Exact prior Explorer QA runtime retired and retained stopped for rollback`, and `Prior agent choices restored`.

## 2. Ploinky when an agent leaves `enable`

| Claim | Status | Evidence |
| --- | --- | --- |
| `.ploinky/agents.json` is never pruned against the manifest. On `start`, every record not in the graph is launched as an "additional enabled agent". | Delegated, spot-checked | `ploinky/cli/commands/workspaceUtil.js:1480-1492,3400-3401` |
| If a record's source folder is missing, the start preflight throws (`findAgent`). A no-target `restart` stops all agents first, then throws. | Delegated | `workspaceUtil.js:1491`, `utils.js:82-84`, `cli.js:663-667` |
| Only `ploinky disable agent <container>` deletes the record and the container. It keeps `.data`. | Delegated, spot-checked | `agents.js:1498,1515,1547` |
| Data lives in `.data/<alias or agentName>` or `.data/<persistentStorage.key>`, keyed by agent name, not by repo. Registry keys, container names and principals include the repo. | Delegated | `ploinky/cli/sandbox/docker/common.js:79-85`; `docs/deploy-skills-explorer.md:281,286` |

```js
  return Object.entries(reg || {})
    .filter(([containerName, record]) => (
      containerName !== '_config'
      && record?.type === 'agent'
      && !graphRegistryNames.has(containerName)
    ))
```

Inferred consequence: on the old registry, an in-place `ploinky start` would either fail its preflight (for example on `AchillesIDE/soplangAgent`) or run `proxies/soul-gateway` and `AchillesIDE/soul-gateway` side by side on the same `.data/soul-gateway`. `docs/deploy-skills-explorer.md:286` says the same and prescribes disabling old records before the first start.

## 3. Readiness assertions

| Path | Count check | A stale extra agent | Status |
| --- | --- | --- | --- |
| In-place | None. It checks only that registered agents are running and the selection is unchanged (`update-explorer-qa.mjs:202-204,215`). | Passes silently | Observed |
| Reconcile | `Tracked agents: 12`, `Running agents: 12`, no-wait `6` (`deploy-explorer-qa.yml:2082,2120-2121,2155-2156`) | Fails | Observed |
| `verify-explorer-qa-runtime.yml` | `assert.equal(records.length, 12)`, no-wait `'6'` | Fails | Observed |

The HEAD graph has 12 agents: explorer, gitAgent, userPersistoAgent, emailAgent (`userPersistoAgent/manifest.json:10-12`), dpuAgent, legacy-agents/{soplangAgent, tasksAgent, webAssist}, roboTeamAgent, soul-gateway, workspaceMonitorAgent and local-llm.

## 4. Run history and destroy

(Observed) Run 38403649166 (2026-10-13 13:16Z, `fa8d9c25`, which predates the split) was a fresh install after destroy run 38400556470. It logged `Tracked agents: 16` / `Running agents: 16`:

```
[start] No-wait dependencies (background launch): soplangAgent, roboTeamAgent, soul-gateway, liveKitServerAgent, webmeetAgent, multimedia, webAssist, umamiAgent, workspaceMonitorAgent, local-llm
[start] Dependency wave 1/3: dpuAgent, emailAgent, gitAgent, tasksAgent (no-wait: liveKitServerAgent, multimedia, soplangAgent, webAssist, workspaceMonitorAgent, local-llm, soul-gateway, umamiAgent)
[start] Dependency wave 2/3: userPersistoAgent (no-wait: roboTeamAgent, webmeetAgent)
```

Run 38405260417 (42 s) took the in-place path and returned `"status":"unchanged"` at `fa8d9c25`. QA data therefore dates from 2026-10-13 13:16Z. Destroy-then-deploy has also run on 10-06, 10-08 and 10-11.

The agents that would be stale against HEAD (Inferred from the diff) are AchillesIDE/{soplangAgent, tasksAgent, multimedia, webAssist, webmeetAgent, liveKitServerAgent}, UmamiAgent/umamiAgent, and the renamed identities proxies/soul-gateway and AchillesCLI/roboTeamAgent. legacy-agents/multimedia was never installed on QA.

`destroy-explorer-qa.yml` (Observed) runs `fs.rmSync` on the whole workspace (`:884-893`), then removes the named volumes (`:873`), the DNS record and the tunnel (`:797-803`). It has no backup step.

## 5. Recommendation: C as a preserving redeploy

I am not recommending B. The in-place updater forbids manifest, selection and identity changes by design, so B would need a new migration engine: clone legacy-agents and webmeet, enable new identities, disable old records. Plain C via destroy loses all data, and the operator has no SSH to back anything up first. The Reconcile path instead does the following. It moves the workspace to `~/.qa-deployment-backups/redeploy-XXXXXXXX`. It copies durable state back and verifies the copy. It regenerates `.ploinky/agents.json`, routing and repos (`:1466-1478`). It retains the old Box, stopped, for rollback. Because the registry is regenerated, no stale record survives. That meets the `:286` requirement without having to run `disable`.

**Required changes.** These touch data recovery, so they need a formal plan and an independent review.

| # | Change | Why |
| --- | --- | --- |
| 1 | Add a `workflow_dispatch` boolean `redeploy_existing` (default false). When it is true and the workspace exists, `inplace` runs only `plan` and emits `updated=false`, and `assert_qa_bootstrap_absent` admits exactly one existing QA workspace and Box. | The gate at `:733-748,:1374` blocks this path today. |
| 2 | Build one filtered selection list and pass it to both `restorePriorSelections` (`:2193`) and `adapters.ready` (`:2205`). Drop every prior selection whose `repo/agent` is not in the fresh registry. For graph agents, accept the fresh policy. Log each one as `[deploy-qa] Prior selection not replayed: <repo>/<agent> (<reason>)`. | Unfiltered, there are two failure routes. Replay runs `enable agent AchillesIDE/multimedia …` (`rollback-explorer-qa.mjs:64-71,94`). `ready()` requires every old selection to match a running row with the same profile, auth and runMode, so it hits `QA_RECOVERY_DEADLINE` after 15 min (`:757-763,777`). Also `userPersistoAgent` moved from profile `default` to `explorer` (`explorer/manifest.json` diff), so `restorePriorSelections` throws `QA_SELECTION_POLICY_CHANGED` (`:87-88`). |
| 3 | Add a workflow path that runs `rollback-explorer-qa.mjs plan` / `execute <backup>`. | No workflow invokes rollback today (grep finds no caller), so a no-SSH operator cannot recover. |
| 4 | Extend the tests `deploy-qa-in-place-workflow`, `deploy-qa-preservation` and `qa-rollback` to cover admission of an existing workspace, filtered replay and readiness, policy drift, and the rollback dispatch. | These are required regression checks. |

**Preserved** (Observed, `:1465-1479`). All top-level workspace entries except `.ploinky`, `.runtime` and `AdvancedLanguageAgent`; that covers Explorer files, the files of global-mode agents, `.env`, and `.data/*` (userPersistoAgent, soul-gateway, roboTeamAgent, emailAgent, dpu-data, workspace-monitor, local-llm). From `.ploinky/`: `master-key`, `.secrets`, `passwords.enc`, the subject identity, `profile` and `edge-desired.json`. From `.ploinky/data/*`: everything except `edge-routing`, `edge-publication` and `router-security`. The `.data` of stale agents also survives, inert.

**Verification.** All of the following must appear in the run log:

| Check | Expected text |
| --- | --- |
| Admission | `Durable-state admission passed before stopping the previous runtime.` |
| Preservation | `Prior workspace retained; durable files ...` and `Exact prior Explorer QA runtime retired and retained stopped for rollback` |
| Graph | The no-wait list is exactly soplangAgent, roboTeamAgent, soul-gateway, webAssist, workspaceMonitorAgent and local-llm, with no multimedia, webmeet, liveKit or umami |
| Counts | `Tracked agents: 12`, `Running agents: 12`, `no-wait readiness 6/6 ready` |
| Replay | One `not replayed` line for each stale or renamed selection, then `Prior agent choices restored and checked against the fresh runtime.` |
| Sources | `Verified legacy-agents/main at …`, `Verified webmeet/main at …`, `Verified AchillesIDE/main at f8c930d6…` |
| After the run | `verify-explorer-qa-runtime.yml` passes. The public `/auth/login?agent=explorer` returns 200. An existing QA user can sign in. Soul Gateway providers are intact. Run `inspect-explorer-host-storage.yml` (read-only) before and after. |

## Risks and unknowns

| Item | Status |
| --- | --- |
| The admission check refuses dirty or untracked managed checkouts, non-AssistOS-AI origins, unexpected `.runtime` entries, unsafe secrets or `.env`, and any drift in `edge-desired.json` from the pinned surfaces (`:1010-1070`). All refusals happen before anything is stopped. | Observed gates; the host state against them is Unknown |
| Capture refuses with "cannot preserve saved accounts" if the QA `.runtime/ploinky` files do not match the `ACCOUNT_CAPABILITY` digests (`rollback-explorer-qa.mjs:39-43`, `deploy-explorer-qa.yml:1384-1390`). | Unknown (hash not run; no host access) |
| Named volumes abort the run (`:994-996`). Free space must be at least the prior size plus 4 GiB (`:1113,1163`). | Unknown (the inspect workflow would show it) |
| Principal-keyed state is preserved under the old keys and needs a manual re-grant: Soul Gateway subjects and providers (`agent:proxies/soul-gateway`), the RoboTeam principal, and edited DPU grants (`docs/deploy-skills-explorer.md:282-289`). | Inferred |
| The `ploinky` code paths the subagent did not read (`removeDisabledRuntimes`, `containerMonitor.js:1922`). | Unknown |
| `reconcile-qa-soul-settings.mjs` has no workflow caller, and its purpose was not checked. | Observed / Unknown |
