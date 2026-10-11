# Plan: Move the OnlyOffice agent into `AssistOS-AI/OnlyOfficeAgent`

Status: **Proposed.** Nothing here has been done yet. Created 2026-09-18.

## 1. Goal and scope

Move the Ploinky `onlyOffice` agent out of `AssistOS-AI/AssistOSExplorer` into its own public repository, `AssistOS-AI/OnlyOfficeAgent`. Keep its git history. Explorer deployments should keep offering OnlyOffice as an optional Marketplace agent, and no copy should stay behind in Explorer.

| In scope | Out of scope |
| --- | --- |
| New repository with the agent and its history | Changes to OnlyOffice runtime behaviour |
| Explorer rewiring (manifest `repos`, agent ref, tests, docs, QA workflows) | Moving the Explorer-side editor host (`explorer/services/onlyoffice/*` stays in Explorer) |
| Ploinky listener profile and security inventory alignment | Changing the route shape `/base-agent-additional-server/onlyOffice/...` |
| Migration runbook for deployments that already run OnlyOffice | Rebuilding or moving the `assistos/onlyoffice-agent` image (digest stays) |

## 2. Baseline

| Repository | Ref | SHA | Note |
| --- | --- | --- | --- |
| `AssistOS-AI/AssistOSExplorer` | `origin/main` | `1522e38c` | Local `main` (`74f12b9c`) is 7 commits behind. Its `onlyOffice/` tree is still identical: `42ae8fe9c2eb319feea7162c0246f7725cd6ad27` |
| `AssistOS-AI/ploinky` | `origin/master` | `e1eb2e90` | Local `master` (`d4eae337`) is 1 commit behind |
| `AssistOS-AI/container-image-builds` | `origin/main` | `6e3b6a1` | Builds the `assistos/onlyoffice-agent` image |
| `AssistOS-AI/UmamiAgent` | `main` | n/a | Precedent for an agent that lives in its own repository |

The `onlyOffice/` directory has 87 files, 73 commits (first one `ed067158`, 2026-05-08) and no npm dependencies.

## 3. Decisions (recommended defaults)

| # | Decision | Recommendation | Reason |
| --- | --- | --- | --- |
| D1 | Repository name | `OnlyOfficeAgent` (confirmed free on 2026-09-18) | Follows the `UmamiAgent` pattern and matches the image name. Everything below uses this name. Changing it changes every identity string in §4 |
| D2 | Layout | Keep the agent in an `onlyOffice/` subdirectory and keep the agent name `onlyOffice` | Ploinky finds agents as `<repo>/<agent>/manifest.json` (`cli/utils/repos.js` `classifyRepoKind`). Keeping the name preserves the route key, the `.data/onlyOffice/*` volumes, the `ploinky restart onlyOffice` gate call and the quiesce scripts |
| D3 | History | Keep it with `git filter-repo --path onlyOffice/`. The alternative is one squashed import commit | Keeps authorship and blame. `--path` keeps the `onlyOffice/` prefix. `git subtree split` would move the files to the repository root instead |
| D4 | Visibility | Public | Deploy hosts clone `https://github.com/AssistOS-AI/<repo>.git` without credentials. Every repository in the QA graph is public (inferred requirement) |
| D5 | Image | Leave it in `container-image-builds/images/onlyoffice-agent`. Keep the manifest digest | The publish workflow never checks out Explorer, and the manifest runs `node /code/src/index.mjs`. So the image carries no agent code and the move does not require a rebuild |
| D6 | How Explorer installs it | Add the repository to `explorer/manifest.json` `repos` only. Do not add it to `enable` or to Ploinky `PREDEFINED_REPOS` | Ploinky installs and enables every repository listed in a manifest's `repos` (`cli/utils/runtime/bootstrapManifest.js:354-392`). OnlyOffice must stay disabled by default. `UmamiAgent` is not predefined either |
| D7 | dpuAgent delegation target | Use the absolute `agent:AchillesIDE/dpuAgent` | See §4. The relative form breaks once the agent is in a different repository |
| D8 | Integration gate | The gate stays in Explorer (`tests/smoke/specs/50-onlyoffice-dpu.spec.mjs`, `tests/smoke/lib/onlyoffice-*.mjs`, `docs/specs/DS007-onlyoffice.md`) | It tests the Explorer to OnlyOffice to dpuAgent path, and `ploinky/CLAUDE.md` runs it from `AssistOSExplorer/tests/smoke` |
| D9 | License | **Needs your decision** | Explorer has no root `LICENSE`. `explorer/package.json` declares MIT |
| D10 | CI in the new repository | Optional | Explorer has no unit-test CI workflow today |
| D11 | Documentation site | Turn on GitHub Pages for the new repository from `main` at `/` | Explorer Pages serves `main` at `/`, so these docs are live today at `https://assistos-ai.github.io/AssistOSExplorer/onlyOffice/docs/` (inferred). That URL goes away. The new one would be `https://assistos-ai.github.io/OnlyOfficeAgent/onlyOffice/docs/` |

## 4. Why this is more than moving a directory

Ploinky builds an agent's identity from the repository name: the principal is `agent:${repoName}/${agentName}` (`cli/utils/security/agentIdentity.js:18`), and the Marketplace ref is `${repo}/${name}` (`cli/server/authHandlers/marketplaceRoutes.js:325-447`).

| Property | Today | After |
| --- | --- | --- |
| Marketplace / enable ref | `AchillesIDE/onlyOffice` | `OnlyOfficeAgent/onlyOffice` |
| Agent principal | `agent:AchillesIDE/onlyOffice` | `agent:OnlyOfficeAgent/onlyOffice` |
| Container name | `ploinky_AchillesIDE_onlyOffice_<ws>_<hash>` | `ploinky_OnlyOfficeAgent_onlyOffice_<ws>_<hash>` |
| dpuAgent delegation target | `agent:./dpuAgent` becomes `agent:AchillesIDE/dpuAgent` | `agent:./dpuAgent` would become `agent:OnlyOfficeAgent/dpuAgent`, **which does not exist**. It must be written as `agent:AchillesIDE/dpuAgent` |
| Route prefix | `/base-agent-additional-server/onlyOffice/*` | Unchanged (route key `onlyOffice`, `onlyOffice/src/edge-topology.mjs:19`) |
| Data | `<workspace>/.data/onlyOffice/{log,data,lib}` | Unchanged. The path is relative to the workspace root, not the repository (`cli/utils/runtime/manifestVolumePolicy.js:20-32`) |
| `ONLYOFFICE_JWT_SECRET` | Shared generated secret | Unchanged. It is scoped to the workspace and keyed by the variable name (`cli/utils/security/secretVars.js:133-140`) |
| Image | `docker.io/assistos/onlyoffice-agent@sha256:70484bd7…` | Unchanged |

`cli/server/httpRouteAuth.js:68-75` resolves `agent:./X` against the repository of the agent that declares the route. The delegation edge (`onlyOffice/manifest.json:32`) is the one change that can quietly break Confidential documents. Unit tests will not catch it; only the routing-level Confidential gate proves it. After the change, the extracted agent hardcodes Explorer's install name `AchillesIDE`. Explorer's own code already does the same (the `AchillesIDE/onlyOffice` refs, the QA intent `AchillesIDE/explorer`, the predefined repository name).

Explorer's "Starting OnlyOffice…" loader should keep working with a ref from another repository. It looks the ref up through the Router's `/api/marketplace` (`explorer/shared/ui/agent-runtime-loader/agent-runtime-loader.js:19-31`), not in Explorer's own files. The wait route only checks that the ref has the form `repo/agent` (`agent-runtime-wait-route.js:4-8`). The Marketplace lists agents from every installed repository. No agent from another repository has gone through this loader before, so Phase 5 is the first time this is actually run.

## 5. Phases

### Phase 0: Preflight (read-only)

1. Record live SHAs with `ls-remote`. Do not rely on tracking refs, because this clone is shared with parallel sessions.

   ```bash
   git ls-remote https://github.com/AssistOS-AI/AssistOSExplorer.git refs/heads/main
   git ls-remote https://github.com/AssistOS-AI/ploinky.git refs/heads/master
   gh repo view AssistOS-AI/OnlyOfficeAgent --json name   # must fail: "Could not resolve"
   ```

2. Check that no OnlyOffice work exists outside `main`. On 2026-09-18, 8 branches had 0 commits touching `onlyOffice/` that are not in `origin/main`, and no worktree had uncommitted `onlyOffice/` changes. Repeat right before the cutover:

   ```bash
   cd ~/work/file-parser/AssistOSExplorer && git fetch origin --prune
   for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin refs/heads); do
     n=$(git rev-list --count "origin/main..$b" -- onlyOffice); [ "$n" != 0 ] && echo "$b: $n"
   done
   git worktree list --porcelain | awk '/^worktree /{print $2}' | while read wt; do
     [ -d "$wt" ] && git -C "$wt" status --porcelain -- onlyOffice
   done
   ```

3. Freeze edits to `onlyOffice/` in Explorer until Phase 3 lands. Later OnlyOffice fixes go to the new repository only.
4. Record baselines for the suites Phase 3 touches: `cd explorer && npm test`, `cd tests/smoke && npm run test:unit`, and `cd dpuAgent && npm test`. None of these were recorded for this plan.
5. List the deployments where OnlyOffice is enabled today. Read-only check: look for an `AchillesIDE/onlyOffice` record in each workspace's `.ploinky/agents.json`, on QA (`explorerQaWorkspace`) and on production (`skills.axiologic.dev`). It is not enabled in the local `~/work/testExplorerFresh` (checked 2026-09-18).
6. Install `git-filter-repo` (`brew install git-filter-repo`). It is not installed on this machine.

### Phase 1: Create the repository with history

Filter a throwaway clone. Never filter the shared checkout.

```bash
BASELINE=<Explorer main SHA from Phase 0>
git clone --single-branch --branch main --no-tags https://github.com/AssistOS-AI/AssistOSExplorer.git "$WORK/OnlyOfficeAgent"
cd "$WORK/OnlyOfficeAgent"
test "$(git rev-parse HEAD)" = "$BASELINE" || { echo "main moved - redo Phase 0"; exit 1; }
git filter-repo --path onlyOffice/
test "$(git rev-parse HEAD:onlyOffice)" = "$(git -C ~/work/file-parser/AssistOSExplorer rev-parse "$BASELINE:onlyOffice")"
git log --oneline | wc -l          # about 73. The tree check above is the hard criterion
gh repo create AssistOS-AI/OnlyOfficeAgent --public \
  --description "Ploinky OnlyOffice Document Server agent for AssistOS Explorer"
git remote add origin https://github.com/AssistOS-AI/OnlyOfficeAgent.git
git push -u origin main
```

Then clone the repository to `~/work/file-parser/OnlyOfficeAgent`, next to `ploinky/`, the same way `UmamiAgent/` is set up. The test dependency in Phase 2 relies on this sibling layout.

Creating the repository and pushing to it are visible outside this machine. Both need your approval at the time.

### Phase 2: Make the agent work on its own (new commits in the new repository)

| File | Change | Why |
| --- | --- | --- |
| `onlyOffice/manifest.json:32` | `"agent:./dpuAgent"` → `"agent:AchillesIDE/dpuAgent"` | §4 |
| `onlyOffice/tests/manifest-env.test.mjs` (or a new test) | Assert that every `targetAgentId` is absolute and that none starts with `agent:./` | Guards against regression |
| `onlyOffice/docs/partials-loader.js:52` | Replace the import of `../../docs/documentation-breadcrumb.js`, which is an Explorer file, with a local copy. Point its back-link at `https://assistos-ai.github.io/AssistOSExplorer/docs/index.html` | The import breaks outside Explorer |
| `onlyOffice/CLAUDE.md:12,28-29` | Reading order: start from the new repository's root `CLAUDE.md`. Link Explorer's `DS007-onlyoffice.md` and `DS002-ploinky-runtime.md` by GitHub URL. Add the test prerequisites below | The `../docs/specs/*` paths do not exist in the new repository |
| `onlyOffice/tests/control-route.test.mjs:11` | Change the fixture principal to `agent:OnlyOfficeAgent/onlyOffice` | Cosmetic. Keeps the fixture accurate |
| New `onlyOffice/tests/source-contract.test.mjs` | Carry over two Explorer checks that read files here: the rule that `src/edge-topology.mjs` must not use `PLOINKY_ROUTER_URL` (`tests/smoke/lib/direct-router-consumer-safety.test.mjs:90-97`), and the rule that `src/index.mjs` reaches the Router only through the mounted `AgentMcpClient` (same file, lines 21-24) | Keeps these rules enforced where the code lives |
| Root `README.md`, `CLAUDE.md`, `AGENTS.md` (pointer stub), `.gitignore`, `.nojekyll` | New files. The README explains installing with `ploinky add repo OnlyOfficeAgent <url>` and `ploinky enable agent OnlyOfficeAgent/onlyOffice global`, or through Explorer's manifest | Repository conventions. Pages needs `.nojekyll` at the root |
| Optional `.github/workflows/test.yml` | Check out this repository as `OnlyOfficeAgent/`, `AssistOS-AI/ploinky` as `ploinky/`, and AchillesAgentLib. Set `PLOINKY_AGENTLIB_DIR` and run `npm test` in `onlyOffice/` | D10 |

The test prerequisite exists already and is not introduced by this move. `onlyOffice/tests/control-route.test.mjs:6-7,15` imports `../../../ploinky/Agent/lib/*`, and those modules need `PLOINKY_AGENTLIB_DIR`. Without it, that one test file fails with `PLOINKY_AGENTLIB_CONTRACT_MISSING`.

Verification:

```bash
cd ~/work/file-parser/OnlyOfficeAgent/onlyOffice
PLOINKY_AGENTLIB_DIR="$(cd ../../ploinky/node_modules/achillesAgentLib && pwd)" npm test
# expect fail 0 (baseline: 244 tests, 236 pass, 0 fail, 8 skipped, plus the new tests)
! grep -n 'agent:\./' manifest.json
# nothing outside code may link out of the agent directory. On 2026-09-18 the only hits were
# CLAUDE.md:12,28,29 and docs/partials-loader.js:52, which the table above fixes
! git -C .. grep -n -E '\.\./' -- onlyOffice ':!onlyOffice/src' ':!onlyOffice/scripts' ':!onlyOffice/tests'
```

### Phase 3: Explorer cutover (one commit on `AssistOSExplorer` `main`)

The deletion and the new manifest `repos` entry must land in the same commit. With both in place, Marketplace never shows zero or two `*/onlyOffice` entries; the check "Exactly one installed Marketplace entry" is in `tests/smoke/specs/03-optional-agents.spec.mjs:42-44`.

| File | Change |
| --- | --- |
| `onlyOffice/` (87 files) | `git rm -r onlyOffice`. Do not leave a stub `manifest.json` |
| `explorer/manifest.json:29-32` | Add `"OnlyOfficeAgent": "https://github.com/AssistOS-AI/OnlyOfficeAgent.git"` to `repos`. **Do not** add it to `enable` |
| `explorer/services/onlyoffice/onlyoffice-preview-service.js:146` and `explorer/web-components/pages/file-exp/file-exp-preview-renderer.js:400` | `AchillesIDE/onlyOffice` → `OnlyOfficeAgent/onlyOffice`, preferably through one exported constant |
| `explorer/tests/unit/optionalAgentDefaults.test.js:6-7,31-34` | OnlyOffice is now external. Assert that `repos.OnlyOfficeAgent` has the canonical URL and that nothing in the graph enables it. Keep the local-manifest checks for `webmeetScribeAgent` and `webmeetStt` |
| `explorer/tests/unit/agentRuntimeLoader.test.js:94,117` and `explorer/tests/unit/onlyofficePreviewService.test.js:311` | Use the new ref |
| `docs/index.html:143` | Point the agent card at the absolute Pages URL (D11). `explorer/tests/unit/docsConsistency.test.js:88-104` follows only `href="../…"` links, so a leftover relative link would fail with ENOENT |
| `explorer/README.md:129` and the comment in `explorer/scripts/hooks/preinstall.sh:9-13` | Point to the new repository |
| `docs/specs/DS007-onlyoffice.md`, `docs/specs/matrix.md`, `docs/specs/DS002-ploinky-runtime.md`, `docs/architecture.html`, `docs/wiki.html`, `docs/documents.html`, `docs/assets/architecture-diagram.svg`, `dependencies.md` | Record the new location, ref, principal and the explicit cross-repository delegation. Explorer's rules require docs and specs to change in the same commit |
| `tests/smoke/lib/direct-router-consumer-safety.test.mjs:21-24,90-97` | Remove the OnlyOffice disposition and the source read. Both moved in Phase 2 |
| `tests/smoke/lib/qa-rollback.test.mjs:364-367,436` | Change the fixtures' `repo` to `OnlyOfficeAgent` |
| `.github/workflows/deploy-explorer-qa.yml:1438-1445` and `.github/workflows/destroy-explorer-qa.yml:429-436` | Add `'OnlyOfficeAgent\|https://github.com/AssistOS-AI/OnlyOfficeAgent.git'` to `GRAPH_REPOSITORIES`, as for `UmamiAgent`. The QA deploy pins each listed repository with `--repo-branch` and checks its commit, branch, upstream and clean state (`deploy-explorer-qa.yml:2137-2165`) |
| `tests/smoke/lib/deploy-workflow-contract.test.mjs:48-53` | Add the same line to the pinned list |
| `.github/scripts/rollback-explorer-qa.mjs:66-92,127-139` | Only if QA has OnlyOffice enabled and you choose Phase 6 Option A over the default Option B. Map the retired ref `AchillesIDE/onlyOffice` to `OnlyOfficeAgent/onlyOffice` when restoring prior selections, and add a test |
| `dpuAgent/tests/{dpu-store,runtime-contract}.test.mjs` | Optional and cosmetic: the fixture principal `agent:AssistOSExplorer/onlyOffice`. dpuAgent's source has no OnlyOffice-specific trust rules |

These stay in Explorer and should not move: `explorer/services/onlyoffice/*`, `tests/smoke/specs/50-onlyoffice-dpu.spec.mjs`, `tests/smoke/lib/onlyoffice-*.mjs`, and `.github/scripts/quiesce-explorer-qa.mjs`, which uses the short name `onlyOffice`. The retired-name absence tests also stay (`liveKitServerAgent/tests/v5-source-absence.test.mjs`, `tests/smoke/lib/retired-source-absence.test.mjs`).

Verification:

```bash
cd ~/work/file-parser/AssistOSExplorer
test ! -e onlyOffice
! git grep -n -E "AchillesIDE/onlyOffice|agent:\./dpuAgent|\.\./onlyOffice/" -- . ':!docs/plans' ':!docs/regression'
# if Phase 6 Option A is chosen, also exclude ':!.github/scripts/rollback-explorer-qa.mjs' ':!tests/smoke/lib/qa-rollback.test.mjs'
node -e "const m=require('./explorer/manifest.json');
  if (m.repos.OnlyOfficeAgent !== 'https://github.com/AssistOS-AI/OnlyOfficeAgent.git') process.exit(1);
  if (JSON.stringify(m.enable).includes('onlyOffice')) process.exit(1)"
(cd explorer && npm test) && (cd tests/smoke && npm run test:unit) && (cd dpuAgent && npm test)
# expect: pass/fail counts equal to or better than the Phase 0 baselines
```

### Phase 4: Ploinky alignment (`AssistOS-AI/ploinky` `master`)

Phase 4a covers the listener profile and fixtures, and lands with Phase 3. Phase 4b is the inventory regeneration. It runs after Phase 5, because `inventory-generate.mjs` needs a live deployment and its preflight evidence.

| File | Change |
| --- | --- |
| 4a: `container/profiles/full-explorer-listeners.json:84-87` and `:336-455` (12 patterns) | `^ploinky_AssistOSExplorer_onlyOffice_` → `^ploinky_OnlyOfficeAgent_onlyOffice_`, and `agent:AssistOSExplorer/onlyOffice` → `agent:OnlyOfficeAgent/onlyOffice`. Follow the `UmamiAgent` entry at `:151-153`. The profile sets `rejectAdditionalContainers: true` |
| 4b: `tests/security/authorization/agent-inventory.mjs` (for example `:319`, `:1128-1140`, `:1554-1557`) | Regenerate with `inventory-generate.mjs` (see `inventory-notes.md:28`) against the Phase 5 deployment. Do not edit it by hand, because it pins an `AchillesIDE` revision |
| 4a: `tests/helpers/generatedRouterRuntime.mjs:18` and fixtures in `tests/unit/{agentMcpClient,invocationAuthInfo,mcpProxyDelegation,cloudflarePublicationPlan}.test.mjs` | Optional and cosmetic |
| `cli/utils/repos.js:127-143` (`PREDEFINED_REPOS`, `BOOT_REPO_NAMES`) | No change (D6) |

Verification:

```bash
cd ~/work/file-parser/ploinky
node --test container/listener-inventory-tests.mjs                   # 4a
npm test                                                             # 4a
node --test tests/security/authorization/inventory-probes.test.mjs   # 4b, after regeneration
```

### Phase 5: Fresh-deploy acceptance (local)

Follow `ploinky/CLAUDE.md` §1-§3 exactly. Pin the pushed SHAs, recreate `~/work/testExplorerFresh`, and run `ploinky start explorer` with no flags. Then:

```bash
cd ~/work/testExplorerFresh
git -C .ploinky/repos/OnlyOfficeAgent status --porcelain          # empty
git -C .ploinky/repos/OnlyOfficeAgent rev-parse HEAD              # the pinned new-repo main SHA
test ! -e .ploinky/repos/AchillesIDE/onlyOffice
cd ~/work/file-parser/AssistOSExplorer/tests/smoke
SMOKE_RUN_ID=<new> npm run test:optional-agents          # one OnlyOfficeAgent/onlyOffice entry, Disabled, then Running in global mode
SMOKE_RUN_ID=<new> npm run test:onlyoffice-confidential  # must finish "1 passed"
```

The Confidential gate is the only test that proves the new principal can still get a delegation grant for `agent:AchillesIDE/dpuAgent` through the Router. After it passes, `.ploinky/agents.json` should show `OnlyOfficeAgent/onlyOffice` with `runMode` `global`, and the container name should start with `ploinky_OnlyOfficeAgent_onlyOffice_`. If you want the full release gate, also run the Copilot and WebMeet gates as `ploinky/CLAUDE.md` §4 requires.

### Phase 6: Existing deployments (QA first; production only when you authorize it)

1. **Rehearse** in a scratch workspace. Do not use `testExplorerFresh`, and use a free port. Deploy Explorer at the pre-cutover SHA, enable `AchillesIDE/onlyOffice`, and save a document. Then move Explorer to the cutover SHA and run `ploinky start explorer`. Record what Ploinky does with a registry record whose manifest no longer exists; this is unknown today. Then apply steps 3-5 and check that the saved document reopens.
2. **QA:** the QA deploy captures every agent from `.ploinky/agents.json` (`rollback-explorer-qa.mjs:127-139`) and re-enables it after the fresh Box starts (`:66-92`). A captured `AchillesIDE/onlyOffice` would be re-enabled from a manifest that is gone, so the deploy would fail (inferred). There are two options:
   - Option B (default, no code): disable OnlyOffice on QA before running the deploy, so it is not captured. Enable `OnlyOfficeAgent/onlyOffice` through Marketplace afterwards.
   - Option A (fallback): ship the retired-ref mapping from Phase 3, so the restore re-enables the new ref automatically.
3. **Stop the old container before starting the new one.** Both containers mount the same `.data/onlyOffice/{data,lib}`. Two Document Servers on one Postgres/RabbitMQ state would corrupt it. Disable the old agent first, with `ploinky disable agent AchillesIDE/onlyOffice` or the Marketplace Disable button. The agent drains and force-saves open sessions when it stops (`onlyOffice/src/drain.mjs`); use the rehearsal to confirm that `disable` stops it through that same path. Then check that `podman ps --format '{{.Names}}' | grep '^ploinky_AchillesIDE_onlyOffice_'` prints nothing.
4. Update Explorer, then enable `OnlyOfficeAgent/onlyOffice` in `global` mode. Data and the JWT secret carry over (§4). Open editor sessions are lost, as with any restart.
5. **Production** (`deploy-skills-explorer.yml`) runs in place, not in a fresh Box, so the stale registry record from step 1 applies directly. Run it only after the rehearsal passes and you have authorized that target.

### Phase 7: Follow-up

| Item | Action |
| --- | --- |
| Workspace map `~/work/file-parser/CLAUDE.md` | Remove `onlyOffice` from the AssistOSExplorer agent list and add `OnlyOfficeAgent/` as a top-level subrepo |
| Long-lived Explorer branches (`ploinky-proxy`, `ploinky-bwrap`, `ploinky-box`, `subject-identity-decoupling`, `soul-gateway-local-integration`, `fix/onlyoffice-*`) | They still carry older `onlyOffice/` trees. They take the deletion when they next merge `main`. Do not port OnlyOffice fixes to them; fix in the new repository. A merge into `ploinky-proxy` triggers the mandatory acceptance gate |
| Old GitHub Pages URL | Keep the Explorer docs index pointing at the new URL. There is no redirect for the old path |
| Later, optional | Move `images/onlyoffice-agent` and `publish-onlyoffice-agent-image.yml` into the new repository |

## 6. Order and rollback

Order: Phase 0 → Phase 1 → Phase 2. At that point the new repository is public but nothing uses it yet. Then Phase 3 and Phase 4a land together, followed by Phase 5, Phase 4b, and Phase 6.

Rollback: revert the Phase 3 commit, which restores `onlyOffice/`, the `AchillesIDE/onlyOffice` refs and the old manifest. Revert the Phase 4a profile change. On any migrated host, disable `OnlyOfficeAgent/onlyOffice` and re-enable `AchillesIDE/onlyOffice`; the data and secret are shared, so nothing is lost. The new repository can stay unused. Rollback needs no data restore because the data path never changes.

## 7. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| The relative `agent:./dpuAgent` stays | Confidential Office files fail: the grant targets `agent:OnlyOfficeAgent/dpuAgent`, which does not exist | Phase 2 edit and test. Phase 5 Confidential gate |
| The agent now hardcodes Explorer's install name `AchillesIDE` | A workspace that installs Explorer under another name loses the Confidential delegation | Same assumption Explorer already makes. Document it in DS007. A later Ploinky option could resolve targets by repository URL |
| Old and new containers run at the same time | Document Server state corruption | Phase 6 step 3 is a hard precondition |
| Two `*/onlyOffice` Marketplace entries | `03-optional-agents` fails and the short name becomes ambiguous | Single-commit cutover, no stub. A workspace that switches back to an old Explorer branch keeps the installed new repository |
| QA restore replays the old ref | The QA deploy fails when restoring selections | Phase 6 step 2: Option B by default, Option A as fallback |
| The listener profile is stale | The Box listener check rejects the new container | Phase 4. See the naming inconsistency in §9 |
| The security inventory is pinned to the old layout | The authorization harness drifts | Regenerate in Phase 4 |
| OnlyOffice work in flight elsewhere | Lost in the move | Phase 0 re-scan and freeze |
| Tests depend on the sibling layout | New-repository tests fail in a standalone clone | Document the prerequisite. The optional CI sets it up |

## 8. Acceptance criteria

| # | Command or check | Expected |
| --- | --- | --- |
| 1 | `gh repo view AssistOS-AI/OnlyOfficeAgent --json visibility,defaultBranchRef` | `PUBLIC`, `main` |
| 2 | In the new repository: `git rev-parse <last imported commit>:onlyOffice` | Equals `git rev-parse $BASELINE:onlyOffice` in Explorer (`42ae8fe9…` if `main` has not moved) |
| 3 | New repository `npm test`, with `PLOINKY_AGENTLIB_DIR` set | `fail 0` |
| 4 | `grep -c 'agent:AchillesIDE/dpuAgent' onlyOffice/manifest.json`; `grep -c 'agent:\./' onlyOffice/manifest.json` | `1`; `0` |
| 5 | Phase 3 verification block | Every command exits 0; counts equal to or better than the baselines |
| 6 | Phase 4 verification block | All pass |
| 7 | `npm run test:optional-agents` against the fresh deploy | Passes, with exactly one `OnlyOfficeAgent/onlyOffice` entry |
| 8 | `npm run test:onlyoffice-confidential` against the fresh deploy | `1 passed`, no skips or retries |
| 9 | After migrating a host: `podman ps --format '{{.Names}}' \| grep -c '^ploinky_AchillesIDE_onlyOffice_'` | `0`, and a document saved before the migration reopens |

## 9. Open questions

| Unknown | How to resolve |
| --- | --- |
| Is OnlyOffice enabled on QA or production today? | Phase 0 step 5 (read-only) |
| What Ploinky does on start when an enabled agent's manifest is gone | Phase 6 rehearsal |
| Is `full-explorer-listeners.json` checked against live Boxes? Its Explorer entries say `AssistOSExplorer`, while `AchillesIDE/liveKitServerAgent`, `UmamiAgent` and the deploy workflows use the real names | Find what calls the Box listener check before editing. The inconsistency for the other Explorer agents is out of scope |
| Test baselines for Explorer, the smoke library and dpuAgent | Phase 0 step 4 |
| The new repository's license | D9, your decision |

## Appendix: Evidence gathered on 2026-09-18

| Kind | What | Result |
| --- | --- | --- |
| Checked | `git fetch` plus `rev-parse`/`rev-list` on Explorer, ploinky and container-image-builds | SHAs in §2. Explorer local main is 7 behind; `git diff --stat main origin/main -- onlyOffice` is empty |
| Checked | `git rev-list --count origin/main..<branch> -- onlyOffice` on 8 branches, and a scan of every worktree | 0 unmerged OnlyOffice commits and 0 uncommitted `onlyOffice/` changes |
| Tested | `npm test` in `onlyOffice/` at `74f12b9c` (same tree as `origin/main`) | Without `PLOINKY_AGENTLIB_DIR`: 233 tests, 224 pass, 1 fail (`control-route.test.mjs` import), 8 skipped. With `PLOINKY_AGENTLIB_DIR=ploinky/node_modules/achillesAgentLib`: 244 tests, 236 pass, 0 fail, 8 skipped |
| Checked | `gh repo view AssistOS-AI/OnlyOfficeAgent` | Does not exist |
| Checked | `gh api repos/AssistOS-AI/{AssistOSExplorer,UmamiAgent}/pages` | Explorer Pages: `main` at `/`. UmamiAgent Pages: `main` at `/docs` |
| Checked | `~/work/testExplorerFresh/.ploinky` (`repos/`, `agents.json`, `repo_sources.json`, `.data/`) | Repositories are installed as `AchillesIDE` and `UmamiAgent`. OnlyOffice is not enabled. `.data/<agent>` sits at the workspace root |
| Checked | `container-image-builds` `publish-onlyoffice-agent-image.yml` | Builds only `images/onlyoffice-agent`. Never checks out Explorer |
| Checked | Explorer runtime loader (`agent-runtime-loader.js`, `agent-runtime-wait-route.js`) | Looks refs up through `/api/marketplace`; does not read Explorer's own files |
| Checked | `git grep '\.\./'` in `onlyOffice/` outside `src`, `scripts` and `tests` | Only `CLAUDE.md:12,28,29` and `docs/partials-loader.js:52` point outside the agent directory |
| Inferred | Public visibility is required; no image rebuild is needed; QA restore fails on the old ref | Based on the checks above. Confirm during implementation |
