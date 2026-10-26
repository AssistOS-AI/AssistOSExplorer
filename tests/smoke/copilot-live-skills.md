# Deployed Copilot live skills gate

This gate implements the registered fixture, the seven-phase C5 wiring and its route-A credential lifecycle. It runs only through the route-A parent, `SMOKE_ARTIFACT_DIR=<abs dir> npm run test:copilot-live-skills` (`CODEX_TEST_AUTH_GATE=c5 node ./scripts/codex-test-auth.mjs run`), on apparatus. The `beforeAll` preflight (`assertLiveSkillsLivePreflight(process.env)`) refuses any launch without the parent's variables: `SMOKE_COPILOT_LIVE_SKILLS=1`, `CODEX_TEST_AUTH_GATE=c5`, `CODEX_TEST_AUTH_SOURCE=owner`, a UUID v4 `SMOKE_RUN_ID`, absolute normalized `CODEX_TEST_AUTH_ROOT`, `SMOKE_ARTIFACT_DIR`, `SMOKE_WORKSPACE_ROOT`, `SMOKE_RELEASE_MANIFEST` and `SMOKE_ALA_COMMAND`, a Box deployment with its container and origin, release source verification, an absolute owner override when one is set, and exactly the runner's `verifyExplorerReleaseBundle.mjs` in `SMOKE_COPILOT_RELEASE_VERIFIER`. Setting `SMOKE_COPILOT_LIVE_SKILLS=1` alone cannot pass it, and the ledger refuses a direct runner selection before any browser starts. Test discovery and offline checks do not launch browsers, native backends or services.

The earlier settings rewrite was unexecuted until the deployment gate (D1/D2); Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance. That status records the earlier acceptance window. It does not waive any current C5 or final acceptance requirement.

`npm run test:copilot-live-skills` selects one Chromium test, one worker and zero retries. It submits exactly seven requests in one continuing native Codex conversation. Each request retains the 150 second limit. The composed test retains its 25 minute limit and maximum 30 minute Box generation age.

## Credential lifecycle (route A)

`lib/copilot-live-skills-credential.mjs` gives the run-owned Codex-only robot `copilot-live-<SMOKE_RUN_ID>` the access-only credential derived in memory from the owner's Codex login, and takes it back before the robot goes. The order is fixed:

| Step | What happens |
| --- | --- |
| Begin (before sign-in) | ROOT checks, the host lock, refusal of a route-B marker and of a gate-c2 marker (`inflight-other-gate`), the RoboTeam binding, then the exec-chain half of any recovery |
| Recovery (after sign-in) | Unregister, robot-delete and the recovery-mode folder removal, then the marker |
| Derive and mark | The owner login is read once, read-only; then `inflight-owner-c5.json` is written before anything of the run exists |
| Setup | The owned source, robot, registration and defaults (unchanged) |
| Qualify | Spec 07 step 7 checks (provider environment, `config.toml`, no existing `auth.json`, the version pin) and the exact client build from the allowlist |
| Inject | Only for the qualified robot, after re-reading the client build, and only if the first turn still fits the window |
| Seven turns | Before each turn the window fence and the unchanged qualified build; before each submit the submit fence |
| Settle | The BUSY-polled copy check and removal by hash, then the CLI exit |
| Cleanup and finish | Links, registration, robot and folders; the generation check; the marker only when every cleanup flag is true; `codex-auth/result.json`; the lock |

The window comes from the verified Box start: the native-use deadline is E' = min(Box start + 30 min - 90 s, test start + 25 min) - (225 s + 240 s + 60 s + 60 s), so the credential settle time, the cleanup, the finish and a margin always fit before the generation cap less the runner postflight. A turn starts only if `now + 45 s + 150 s + 10 s <= E'`, and its submit only if `now + 160 s <= E'`; otherwise the run stops with `RUNTIME_PREREQ_FAILED generation-window` and still settles the credential. The credential gates require the access token to outlive E' + 225 s + 5 minutes. On a Box that started together with the test, setup and all seven turns must end within about 18.75 minutes of the Box start when the generation cap binds. A native completion that fails or times out is `NATIVE_TURN_FAILED` (`failed` or `timeout`) with `authRejectionSuspected` from the sanitized chat text.

`result.json` has the C2 fields plus `gate: "c5"`, `window` (`boxStartedAt`, `nativeUseDeadline`, `credentialDeadline`), `turns.completed` and six cleanup flags (`credentialPersisted`, `credentialRemoved`, `linksRemoved`, `sourceUnregistered`, `robotDeleted`, `folderDeleted`). A run is `OK` only with every flag true; otherwise the first false flag decides the `CLEANUP_INCOMPLETE` reason. A CLI that does not exit after the credential removal leaves the robot in place (`robot-not-deleted`) and the marker for recovery.

A crashed run is recovered by the next C5 run, in a fresh process, from its marker and observed state only, and the owner login is never read for it. Before sign-in the leftover copy is discarded inside the container whatever the CLI does, and then the CLI must exit. After sign-in the registration listing drives the unregistration, the robot is deleted, and `remove-folders` in recovery mode removes the present roots. Links are not removed one by one, because they live in the run folder. Recovery mode tolerates unfinished turn records only when the robot's metadata is absent, no process has a cwd or argument inside the owned roots or the robot storage, and every present root still carries its ownership marker. A root without one stops the recovery with `CLEANUP_INCOMPLETE recovery-incomplete`, which an operator resolves.

The fixture owns two unique paths below the verified workspace. Its uncommitted Git repository contains `skills/<name>/SKILL.md` and `receipt.mjs`; the separate execution folder contains receipts and `.roboteam` conversation state. Setup refuses existing paths or robot names, discovers the exact source through Marketplace `list-repos`, creates a new robot with only `codex`, and registers that canonical source on that robot. Required DocumentationSkills must already be local. Setup never downloads a repository or prepares another backend.

Before either conversation opens, the pinned `SkillPolicies.ensure` seeds an absent owned defaults policy with the entire repository selected. Existing policy files are refused. The first browser conversation remains untouched; the browser's New action creates the conversation used by all seven requests. C5 opens WebChat with the explicit owned robot and folder. The ordinary C1 default folder-launch gate remains separate.

| Native turn | Source or policy change | Required result |
| --- | --- | --- |
| Original | Control and probe exist before defaults and conversations | Two fresh helper receipts and both source-only answers |
| Descriptor edit | Change only the probe descriptor | New descriptor answer, unchanged helper bytes and link revision |
| Helper edit | Change only the probe helper | New helper answer, unchanged descriptor bytes and link revision |
| Addition | Add a third source skill through Explorer | Execute control and added helper; three fixture skills installed; changed link revision |
| Disable | Disable probe through RoboTeam's Conversation skills page (WebChat menu) | Advancing UI policy version, persistent exclusion, fresh control receipt and no probe link or receipt |
| Re-enable | Re-enable probe through the same page | Advancing UI version, removed exclusion, restored live link and fresh control/probe receipts |
| Delete | Delete the probe source directory through Explorer | Whole-source policy handles deletion; fresh control receipt, no probe link or receipt |

Prompts contain skill names and a fresh public phase UUID. Expected answers occur only in current descriptor/helper bytes. Each generated helper runs through its actual Ploinky symlink, resolves the registered source, checks canonical cwd, and writes one receipt with exclusive creation. Its version2 receipt records run, phase, skill, invoked link, resolved source, cwd, current helper hash and time. A copied helper or replayed phase fails. Previous receipts must remain byte-for-byte unchanged.

The revision is the hash of the managed links of the session-private skills directory `<execution-folder>/.roboteam/sessions/<id>/skills`, which the sandbox projects at `<execution-folder>/.agents/skills` for the native backend. Descriptor/helper byte edits keep it stable. Addition, deletion and selection membership change it. The reader checks real symlinks, their literal targets and canonical sources, current source hashes, `skillExecution.live`, and the completed inventory revision. Inventory alone cannot establish execution.

Conversation metadata comes from `<execution-folder>/.roboteam/sessions/<id>/config.json`. The deployed pinned ALA transcript API reads the matching folder transcript. The browser assistant message must join exactly one completed native turn. Raw final text, native Codex backend, robot ID, home, cwd, session and continuing thread remain bound across phases. The supported View Thinking suffix is validated separately against the metadata's exact session/message URL. The observer does not read that log or project intermediate output and tools.

Every phase preserves the untouched conversation and owned defaults. A separate read-only snapshot preserves the existing default robot's configuration, repository registration and defaults policy, including after cleanup. The default robot is never opened or mutated by C5.

Live invocation requires the existing exact release/Box/workspace pins and `SMOKE_ALA_COMMAND` naming the deployed canonical `<workspace>/<ALA>/bin/ala.mjs`. The reader checks the executable, package and transcript-reader hashes and all imported RoboTeam contract files. It also preserves the Box/runtime generation, image, mount and source guards. Observer and native execution use the canonical workspace path; `/workspace` is not an alternate namespace.

Cleanup first cancels and proves native quiescence, then closes Copilot/settings pages, removes owned links, unregisters the owned source, deletes the owned robot, and removes its folders and project-location reference. An ambiguous setup outcome, unfinished turn, identity mismatch, deletion conflict or cleanup failure retains ownership and fails the gate. The credential is settled before any of these steps (see the credential lifecycle above).

The offline fixture suite uses the pinned policy service, Marketplace discovery and Ploinky link installer with disposable files. It executes generated helpers through real symlinks and produces synthetic transcripts through ALA's recorder. These checks validate seven-phase obligations and isolation. They do not claim seven deployed native turns passed.
