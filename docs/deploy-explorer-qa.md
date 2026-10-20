# Deploy Explorer QA with Ploinky Box

Deployment is operator-controlled. Codex sessions are authorized operators when
the user's task selects the target deployment operation. They may invoke the
tracked GitHub Actions deployment workflows with `gh` or use direct SSH,
Ploinky CLI, container, registry, Cloudflare, DNS, and other remote operations
needed to complete that selected task.

This repository deploys only Explorer QA (`explorer-qa.axiologic.dev`). The
former `skills.axiologic.dev` production deployment and its
`deploy-skills-explorer.yml` and `destroy-explorer.yml` workflows were removed
on 2026-10-20, when its host was reinstalled.

The tracked `deploy-explorer-qa.yml` workflow is a supported execution channel.
Before dispatch, inspect the workflow at the
requested revision and verify its exact inputs, target guards, credentials,
branch selection, and fallback behavior against the user's requirements. A
workflow name or historical successful run is not evidence that its current
implementation satisfies those requirements. If an explicit request forbids
`--branch-fallback`, do not dispatch a workflow that injects that option; use an
authorized direct channel or update and verify the workflow first.

The Explorer QA deploy workflow never tears down an existing installation. Its
`operation` input defaults to `update`, so a dispatch with no inputs behaves as
described here. The other operations (`redeploy-rehearsal`, `redeploy`,
`rollback-plan` and `rollback-execute`) are described under "Preserving
redeploy, rehearsal and rollback" below. When `/home/admin/explorerQaWorkspace` exists, `update` updates
only its clean `AchillesIDE` checkout (AssistOSExplorer) from the remote's
configured default branch, pinned to an exact commit. It fast-forwards the
checkout under the workspace lock. Browser assets served directly from the
verified managed source paths become available without restarting containers;
affected server code uses Ploinky's targeted restart command. The existing Box, image, AgentLib, other
repositories, accounts, documents, and caches remain in place. Deployment does
not copy the workspace or create a large rollback backup. An unchanged commit
is a verified no-op.

Dirty sources, a different branch, divergent history, ambiguous ownership, or
changes to dependencies, manifests, or runtime installation configuration stop
the in-place update before checkout. A failed restart restores the prior clean
source commit. When the reviewed runtime proves the restart was rejected before signalling
and the predecessor container is still running with its exact original identity,
recovery republishes its withdrawn route through Ploinky's
coordinated routing API; replaced runtimes restart against the previous code. A failure is still
reported. The workflow never falls through from an unsuccessful update into
fresh installation. Its host operation lock covers the complete update and
recovery, while each source mutation and targeted restart uses the workspace
lock. Source and runtime identities are checked again after activation.

Fresh installation runs only when both the QA workspace and its Box are absent,
with absence checked again under the workspace lock. Removal remains a separate,
explicit operation in `destroy-explorer-qa.yml`. An existing installation is
retired only by the confirmed `redeploy` operation, which retains it for rollback
instead of deleting it. For a fresh installation it resolves
Ploinky and every managed application repository from each remote's configured
default branch, while keeping explicit per-repository selections for the graph.
It never applies one global branch to the differently named application
branches. AchillesAgentLib is not a selected repository: the Box image supplies
it and that exact outer image is its identity, so the workflow pins no AgentLib
commit. Once every agent in the default graph is running, the workflow validates
every managed repository revision and the outer Box's image-owned AgentLib: the
image-owned labels and `PLOINKY_BOX_IMAGE_ID` bound to the outer image, and the
image's own `smoke-libraries.mjs inspect achillesAgentLib` probe on the sealed
image and in the running Box. The library's build provenance is recorded as
diagnostic only. A current QA Box in any other AgentLib mode is refused with the
observed mode and the recovery. A predecessor Box from a Ploinky release before
image-owned libraries is still captured and rolled back by its own verifier. The paired
destroy workflow requires only its explicit destructive confirmation and
preserves the deployed runtime as the authority for teardown.

QA Boxes use Ploinky's same-path workspace contract. The host workspace
`/home/admin/explorerQaWorkspace` is mounted read-write at that same absolute
path inside the Box, is the Box working directory, and is its only
`PLOINKY_WORKSPACE_ROOT`. There is no `/workspace` alias. Deployment, teardown,
shutdown, recovery and runtime verification run every in-Box command against
that path, and Box admission rejects a different workspace mount, working
directory or workspace root. A Box created under the retired `/workspace`
layout is neither adopted nor recovered by these helpers; replace it through an
explicitly authorized QA reset.

The QA verifier accepts the current image-bundled AgentLib source without
inventing a host checkout or mount. It requires an exact Linux/amd64 image ID,
the locked commit, matching bundle fingerprint and derived image source ID,
and no mount covering the bundled library, sealed verifier, or Node interpreter.
An offline, read-only, unprivileged temporary container verifies the immutable
image's sealed metadata, root ownership and actual content. The running QA Box
must independently return the same proof. Mounted managed/local selections
retain clean Git-source, content fingerprint and physical source checks.
Rollback records retain image-backed source authority alongside the exact base
image; only actual host sources become checkout pins. Recovery rejects a
different bundle before initializing its fresh graph.

Ordinary QA deployment uses the in-place path above. The fresh-install path
retains the guarded admission and recovery helpers used by older deployments,
but its mandatory absence checks prevent them from stopping or moving an
existing installation unless the operator selects the confirmed `redeploy`
operation. The 25 GiB capacity requirement applies to that opt-in redeploy and to
a fresh install, never to an in-place source update.

Existing backups from older recreation deployments remain available for their
separately reviewed recovery procedure. Their shutdown helper pins registered
containers and mounts, drains consumers before providers, and requires clean
database shutdown. Recovery retains encryption identities, accounts, documents,
policy, revocations and audit history together. The deploy workflow does not
create another predecessor snapshot during an in-place update.

Each backup contains reviewed recovery helpers and an authority record written before any stop or move. With SSH access, run `node BACKUP/helpers/rollback-explorer-qa.mjs plan BACKUP --current-id FULL_ID` for a read-only recovery check, then replace `plan` with `execute` for the selected recovery operation. Without SSH, dispatch the `rollback-plan` and `rollback-execute` operations described below, which run exactly those commands. Use `absent` only when the failed replacement Box is absent. Recovery creates a fresh Box from the predecessor's pinned base image and clean source revisions, copies the saved durable data, restores policy and agent choices, and verifies new runtime identities and readiness. It preserves the predecessor and failed replacement snapshots. Recovery does not resume saved nested containers and does not claim browser acceptance.

Older runtimes that overwrite saved accounts during graph registration cannot be used for exact-code rollback. The workflow rejects them before shutdown. A runtime is admitted only when its account-handling files match one complete reviewed set. Set A is the original release with the local password store. Set B is Ploinky `7d8c04d0`, where local password authentication and its credential seeding were removed (commit `df976761`): `cli/utils/agents.js` must match its reviewed digest and `cli/utils/security/encryptedPasswordStore.js` and `passwordStoreLock.mjs` must be absent. Files from different sets never combine. They require a separately reviewed forward migration using fixed source revisions and the authoritative saved data. Low disk capacity likewise requires a scoped operator recovery plan. A complete quiesced GNU tar archive can be streamed over SSH to protected local storage with checksum verification and numeric ownership, ACLs and xattrs retained. Record that off-host archive dependency before clearing any proven generated QA cache. Never prune unrelated host resources. Retain backups and image references until data preservation and browser acceptance pass; retained predecessor Boxes require explicit review before a later automated deployment.

QA also clones `AdvancedLanguageAgent` into the fresh workspace root from its remote default branch and records its exact commit. Before starting Explorer, the workflow checks ALA's package identity, absence of runtime dependencies, real checkout and CLI directories, executable CLI, and the `--home`, `--cwd`, and `--MCPServers` help options required by RoboTeam. It rejects incompatible CLI options or a dirty or moved ALA revision. ALA needs no dependency installation or AgentLib binding. The Box's image-owned AgentLib checks remain required, and this workspace prerequisite does not change the readiness gate.

The default Explorer graph no longer enables Umami, WebMeet or LiveKit: `UmamiAgent` and `webmeet` stay in `repos` and Marketplace offers `UmamiAgent/umamiAgent` and `webmeet/webmeetAgent`, so the tracked-agent totals are 12 with 6 no-wait agents. Copilot runs through RoboTeam’s ordinary `default` robot; the retired `AchillesCLI/achilles-cli` agent is not a dependency. The default graph excludes the external `OnlyOfficeAgent/onlyOffice` agent, `webmeetAgent`, `liveKitServerAgent`, `webmeetScribeAgent`, and `webmeetStt`; the deployment pins the `OnlyOfficeAgent` repository alongside the other graph repositories while leaving the agent disabled. Readiness requires every runtime of the recursive default graph and every no-wait completion it declares; the workflow constants are checked against that graph by `explorer/tests/unit/retiredLocalModelGraph.test.js`. After that baseline is ready, QA restores prior optional agent selections through the supported CLI and verifies their aliases, authentication modes, profiles and readiness. Administrators can also enable optional agents through Explorer Marketplace. Meeting Secretary uses final browser SpeechRecognition transcripts and does not depend on the separate STT service.

The QA deployment workflow does not pull, start, or inspect a local model image; the retired `proxies/default-local-llm` agent is not part of the default graph. The local Soul Gateway seeds a restricted free OpenRouter provider on first start with the tiers `fast`, `code`, `plan`, `write`, `deep`, `ultra`, and `web-assist`. Its bundled credential is guarded to free models only and shares one daily quota with every installation using it, so deployments need outbound internet access for these tiers and must not rely on them as unlimited or offline capacity. Administrators replace the credential through the admin-only Soul Gateway settings dashboard. OpenCode's free models are available through the optional `legacy-agents/opencode-free` agent, which `ploinky start explorer` does not enable; to add it to a workspace, run `ploinky enable agent legacy-agents/opencode-free` from the workspace root. The agent wraps the unmodified OpenCode CLI; once enabled, Soul Gateway discovers it like any other agent and adds it to no tier by default: plain-text chat only, no tool calls and no images, one answer per request delivered as a single chunk after several seconds, a free quota shared by every installation that uses the bundled key, and prompts subject to the free models' data-use terms. Native OpenCode execution through RoboTeam's installed OpenCode CLI is unchanged.

The `webmeet` repository supplies `webmeet/liveKitServerAgent` alongside WebMeet, and a fresh deployment starts neither: the workflow neither pulls the LiveKit image nor gates on LiveKit health, and keeps the `WEBMEET_*` variables for an administrator who enables WebMeet later; Explorer installs that repository through the `repos` map of `explorer/manifest.json`, together with `legacy-agents`. Deployment repository lists must not install a separate media-runtime repository or `basic`. LiveKit keeps its immutable image, readiness contract, `.data/liveKitServerAgent/` storage, Router signaling/private Twirp paths, and single UDP `7882` media mux. Its relocation does not change the readiness gate. The image publication workflow in `container-image-builds` must select the `liveKitServerAgent/` build context from the `webmeet` repository. Integrate that source selection and the matching Ploinky listener profile before retiring the previous runtime source.

A workspace that still has the retired media repository must move its LiveKit owner to `webmeet` before startup: disable the old runtime records and repository through Ploinky, confirm no old runtime remains in the Box's nested Podman, and keep `.data/liveKitServerAgent/` throughout. Two owners cannot share the fixed media socket.

Direct operator execution has the same authority and safety boundary. Before a
destructive or externally visible mutation, positively identify the exact host,
workspace, environment, revisions, images, and rollback state. Authorization
for QA or local deployment never authorizes production or unrelated workloads.
Never expose secret values in commands, logs, reports, or artifacts.

## Required sequence

For an explicitly requested QA reset, first run
`inspect-explorer-host-storage.yml` and review its container, image and filesystem
identities. `cleanup-explorer-host-storage.yml` requires `confirm_reset=true`
and that exact JSON plan. It removes the selected Podman containers, unreferenced
images and the four supported QA workspace/test-artifact roots under both the
deployment and workspace locks. It checks identities again before deletion and
retains the dedicated Cloudflare tunnel and DNS for the next deployment. This
operation permanently removes the selected QA data; use it only when that reset
has been explicitly authorized.

Fresh-install QA capacity admission prints byte counts for available and required space,
the shortfall, retained QA backups, durable data, and source/dependency/image
caches before stopping any service. The categories overlap and must not be
added together. Admission still requires free space of at least the larger of
25 GiB and the current QA workspace allocation plus 4 GiB. The diagnostics do
not authorize deleting caches, backups, or other host resources.

After capacity admission, the QA workflow installs the SHA-256-pinned official
Node.js 24.19.0 archive under `/home/admin/.qa-deployment-tools/` and prepends
its `bin` directory only for that workflow. Existing installs are compared
against the verified archive before execution. The shared host Node installation
is unchanged. The toolchain survives workspace archival; each new backup records
its directory in `helpers/node-runtime-path`. For recovery, read that path into
`QA_NODE_HOME`, prepend `$QA_NODE_HOME/bin` to `PATH`, and invoke the retained
rollback helper with `$QA_NODE_HOME/bin/node`. Older backups without that record
need an independently verified Node.js 22-or-newer runtime before recovery.

The QA workflow configures UserPersisto's public OIDC issuer and Google callback
for `explorer-qa.axiologic.dev` before graph startup, using Ploinky's encrypted
variable API. It adds the QA origin to the existing effective redirect list,
including a saved UserPersisto policy when no environment override applies.
The preserved `.data/userPersistoAgent/persisto` snapshot retains accounts,
installation ownership, and OIDC clients and keys together with the original
workspace encryption identity. Authentication methods and self-registration
policy are not changed. An optional repository variable,
`EXPLORER_QA_USERPERSISTO_GOOGLE_CLIENT_ID`, can select the QA Google Web client;
otherwise an existing client is retained. Without one, Google is unavailable
instead of using the distributed localhost client.

Public deployment checks follow the Router's same-origin SSO handoff to the
sign-in wizard shell, confirm that its opening page carries no password field,
and verify OIDC discovery and its exact public issuer. They report only
ownership-complete, registration, and method-availability booleans and never
submit a sign-up or claim the first administrator.
No account is pre-created. On an unclaimed installation, enter the owner's
email, select **Next**, enter the literal password `admin`, and select **Log in**.
This creates the first administrator without email delivery or a verification
code; its email remains unverified. Google sign-in and password signup (verified
or direct) can also claim the installation first. By default **Sign up** creates
the account immediately with an unverified mailbox, so ordinary QA and local
deployments need no mail provider; setting
`USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED=true` on an internet-facing
host restores the emailed-code flow, and **Forgot password?** needs real
delivery. The exception closes permanently after the first claim. Configure
EmailAgent delivery to verify the initial administrator's email and enable
email codes and password reset. Complete the selected owner's setup before inviting restricted users.
When upgrading a running workspace to a release that adds the EmailAgent
`email_send_password_reset` tool, restart the Router afterwards: it registers
agent tools in its tool policy only at startup, so until it restarts
**Forgot password?** answers "We could not send the email" (`502
delivery_failed`). Fresh deployments and direct sign-up are unaffected.
Subsequent public sign-ups receive `selfRegistered` and do not gain Explorer
access automatically. Automated release gates sign in and sign up through the
same screens with the smoke helper described in `tests/smoke/README.md`.

1. Preserve a consistent backup of application data and its encryption keys.
   Ordinary QA redeployment must retain accounts, documents, local skills,
   access policies and revocations. A requested test-workspace reset is a
   separate operation with its own explicit target.
2. Build or pull the pinned multi-architecture box and dependency images.
3. Configure either explicit local-only mode or a complete dedicated-tunnel
   Cloudflare configuration. Never create a quick tunnel. The tracked Explorer
   QA workflow reuses the single `explorer-qa` tunnel, creates it through the
   Cloudflare API when it is absent (for example after the destroy workflow
   deleted it), and fails if the name is ambiguous;
   it must preserve the pinned shared `proxies` tunnel and unrelated DNS,
   validate the connector credential against the selected account/tunnel,
   and keep connector and management credentials in separate encrypted handles.
4. Configure the literal public media IPv4 and external relay service.
5. Recreate the Box explicitly under the semantic Box contract.
6. Inspect the real outer container and prove its normalized bindings are
   exactly loopback Router TCP and wildcard LiveKit UDP `7882`.
7. Start the full Explorer graph and validate the topology-aware in-box
   listener gate. Loopback is `required-loopback`; a managed gateway is
   `required-assigned-managed-gateway` only when current Podman and kernel
   evidence prove assignment to the exact reported `network_interface`; an
   unassigned gateway is `inactive-unassigned-managed-gateway`, has no
   listener, and remains inactive and fail-closed.
8. While the graph remains alive, run the fixed Chromium Router/auth baseline
   below with no retry or skip.
9. Run the local Ploinky core WebTTY gate against the exact mounted workspace.
10. Revalidate outer publication and listener ownership.
11. Enable `webmeet/webmeetAgent` in global mode (Marketplace or `ploinky enable agent webmeet/webmeetAgent global`), since the default graph does not start it, then run the real-browser OnlyOffice, Umami, GPTResearcher, and WebMeet gates.
12. Clean up and destroy the graph only after all graph-dependent gates finish.

The Ploinky release harness runs this exact baseline after the full graph and
listener gate succeed and before cleanup or graph destruction:

```bash
cd tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:18080 npm test -- --project=chromium specs/00-router-auth.spec.mjs
```

It proves the dashboard, Explorer shell, and routed WebChat shell through
Router. This oracle is distinct from the WebMeet external-network and
ScreenShare gates below; none substitutes for another. A missing or failing
baseline is a release failure and must not be retried, skipped, or weakened.

The local Ploinky core WebTTY gate is:

```bash
cd tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:18080 \
SMOKE_WORKSPACE_ROOT=/absolute/path/to/the/box/workspace \
npm run test:webtty
```

It requires the canonical local `admin` and `user` accounts and a fresh Box.
The gate exercises the local administrator browser-mutation path through the
Explorer-owned target chooser. It proves Ploinky Box is first, checks the exact
eligible-agent rows returned for the selected folder, and opens WebTTY only
through an opaque fragment launch. It proves the selected Box or agent working
directory and bidirectional PTY behavior, closes the terminal, and creates a
second terminal through a fresh chooser discovery to prove cleanup did not
disable WebTTY. It also proves launch replay and stale-target rejection,
fragment stripping, UI omission, and page/discovery/session API `403`
responses for the ordinary user. A direct `?dir=` launch, non-loopback target,
missing workspace root, skipped case, or failed assertion is a release failure.

The WebMeet screen gate is:

```bash
cd tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_WEBMEET_MEDIA=1 \
SMOKE_WEBMEET_SCREEN=1 \
SMOKE_TEST_TIMEOUT_MS=240000 \
npm test -- --headed --project=chromium specs/30-webmeet-room-chat.spec.mjs
```

This command requires two distinct authenticated accounts. On Linux without a
display, the runner creates a deterministic Xvfb display. Missing accounts,
media, or real infrastructure are hard failures while the screen flag is set.
The local gate removes TURN and requires both browsers to use active non-relay
UDP `7882` pairs during each ScreenShare direction. Exact configured-public-IP
selection is intentionally reserved for the distinct-network native x64/arm64
matrix, which also rejects `7881` and private/discovered alternatives.

Cloudflare, external relay, cross-network, native x64, and native arm64 gates
must use dedicated test resources. A missing prerequisite is reported as
BLOCKED with the reproducible command; it is never treated as a pass.

An inactive managed gateway does not authorize a wider bind, forwarder, direct
target, or alternate authorization path. Ploinky DS004 Question #8 remains the
owner of any architecture change needed to activate that lane.

## Preserving redeploy, rehearsal and rollback

Moving QA to a graph that differs from the running one, for example from the larger graph of the layout before the repository split to the twelve agents of the current default graph, cannot use the in-place updater: it refuses manifest, selection and identity changes by design. The `redeploy` operation does the work through the guarded Reconcile path. It moves the workspace into a protected backup, copies every durable file back and compares it byte for byte, regenerates the registry, and keeps the old Box stopped under the name `<box>-rollback-<backup>`. Nothing is deleted. A failed redeploy is acceptable; lost data is not, so every new branch either fails before services stop or leaves a backup that can be rolled back.

| Operation | Inputs | Effect |
| --- | --- | --- |
| `update` (default) | none | The in-place update above, or a fresh installation when the workspace and Box are absent |
| `redeploy-rehearsal` | `expected_explorer_commit` | Read-only. Runs the admission, capacity, account-runtime and capture checks and the quiesce helper's preflight proofs inside the running Box (registry, container ownership and mount contract, with no lease, lock or stop), prints every verdict and a prediction for each prior agent selection, and stops before any backup directory is created |
| `redeploy` | `expected_explorer_commit`, `confirm` = `redeploy explorerQaWorkspace` | Retires the running installation into a backup and starts a fresh one |
| `rollback-plan` | `rollback_backup`, `rollback_current_id` | Read-only recovery check using the helper stored in the backup |
| `rollback-execute` | `rollback_backup`, `rollback_current_id`, `confirm` = the backup name | Recovers the predecessor from the backup |

Both redeploy operations need the 40-character lowercase commit of AssistOSExplorer `main` that the dispatch is meant to deploy. The runner checks it against `git ls-remote` before SSH, the host checks it again before anything is stopped, and the redeploy checks it a third time after source resolution. A mismatch fails closed. Redeploy also requires an existing real workspace directory and exactly one Box with the exact name, so an accidental first installation can never replace the safety of a backup. It refuses to create a Cloudflare tunnel and reuses the existing dedicated one.

The workspace encryption identity is the master key, the encrypted `.secrets` store and the subject identity key. Ploinky `7d8c04d0` keeps them under `.ploinky/data` (`master-key`, `.secrets`, `ploinky_subject_identity_ed25519_v1.enc`; Ploinky commit `12d76a76` moved them there so the masked controller root covers them), while earlier runtimes kept them directly under `.ploinky`. Admission for a new redeploy refuses, before anything is stopped, any of `.ploinky/master-key`, `.ploinky/.secrets` or `.ploinky/ploinky_subject_identity_ed25519_v1.enc`, alone or beside the `.ploinky/data` copies, because the pinned runtime refuses them once QA is stopped; migrate each into `.ploinky/data` first. Capture, the preserving copy and recovery still fingerprint both locations so a rollback of an older backup keeps working. A workspace with `.data` needs `.ploinky/data/master-key`; each identity file must be a regular file with one link, the key must be owned by the workspace owner, and no identity file may be a symlink or hardlink; capture still refuses differing keys in both locations as an ambiguous identity. The copy keeps `.ploinky/data` at its previous owner and mode, then requires every identity file present in either layout to be copied and byte-compared, and recovery compares the same files against the fingerprints captured before the redeploy.

The rehearsal reports a capacity shortfall instead of stopping at it, so that the account-runtime and capture proofs are visible before the disk is resized. Any failed gate, capacity included, fails the rehearsal. The real `redeploy` keeps the capacity gate fatal: the free space must be at least the larger of 25 GiB and the workspace allocation plus 4 GiB. Do not dispatch `redeploy` while the rehearsal shows `admitted=false`. Resize the disk; do not lower the floor and do not delete durable data to make room.

The prior selections of the old runtime are never enabled again. Each is classified against the fresh registry and logged: `retained`, `policy superseded` when the fresh graph sets another profile, auth mode or run mode, `not replayed` when the agent moved to another repository, and `not replayed` when it left the default graph. Re-enable an optional agent through Marketplace if it is still required. The totals line reports the live count, so no number is fixed in advance. Readiness is checked for the fresh graph only.

The `Redeploy backup`, `Rollback reference` and `Verification expectation` log lines are the only source of the inputs for the later operations when the operator has no SSH. `Rollback reference` carries the backup name, the 64-character ID of the retained predecessor and the ID of the fresh Box; use the `current` value, or `absent` when the run stopped before the fresh Box existed (the failure handler prints it only once stopping began, that is after the `Stopping nested QA services` marker or, when the old Box was already stopped, immediately before the durable-data preservation; a failure before that leaves QA untouched and prints no reference), as `rollback_current_id`. Feed the JSON of `Verification expectation` to `verify-explorer-qa-runtime.yml`. GitHub echoes each step's script into its log, so filter the raw log before searching it: `grep -v $'\x1b\[36;1m' run.log`.

| Last marker in the log | State | Action |
| --- | --- | --- |
| No `Stopping nested QA services` and no `Rollback reference` | QA untouched | Fix and rehearse again; do not roll back |
| `Stopping nested QA services`, without `Exact prior Explorer QA runtime retired` | The old Box keeps its exact name and may be stopped or running | `rollback-plan` with `rollback_current_id=absent` |
| `Exact prior Explorer QA runtime retired` | Old Box renamed and stopped; a failure after the backup exists still prints `Rollback reference` from the exit handler, with `current=absent` when no fresh Box exists | `rollback-plan` with the `current` value of the last `Rollback reference` line |
| `Rollback reference` | Fresh Box present, or `current=absent` | `rollback-plan` with its `current` value |

After `"result":"planned"`, dispatch `rollback-execute` with the same inputs and the backup name as `confirm`. Data written after the redeploy survives only in `failed-workspace` inside the backup. The retained stopped Boxes remain until a separately reviewed removal; they make a second `redeploy` fail, and the updater and the runtime verifier ignore only stopped Boxes named `<box>-rollback-redeploy-XXXXXXXX` or `<box>-failed-redeploy-XXXXXXXX`.

The redeploy regenerates `.ploinky/enabled_repos.json`, `.ploinky/repo_sources.json` and `.ploinky/unregistered_agent_repos.json`, because a stale unregistered name makes agent resolution throw and a stale source entry pins a clone branch. The backup keeps the old copies and rollback restores them. Principal-keyed state is not re-keyed automatically; see the checklist below.

## Migrating principal-keyed state after the agent repository split

Moving agents to the `legacy-agents` and `webmeet` repositories, and `soul-gateway` and `roboTeamAgent` into this repository, renames their Ploinky identities. Ploinky derives an agent identity, its principal and its container name from the repository name and the agent name, so a workspace that already ran the earlier layout must be reviewed before it starts the new one. A fresh deployment is not affected.

| State | Old key | New key | Action |
| --- | --- | --- | --- |
| Per-agent data volumes such as `.data/soul-gateway` and `.data/roboTeamAgent` | Agent name | Agent name | Keyed by agent name, so they are expected to survive the move; confirm the mount after the first start |
| DPU agent policy for the search agent | `agent:proxies/searchAgent` | `agent:legacy-agents/searchAgent` | The default policy is added for the new key only when it is absent (`applyFreshDefaultAgentPolicies`). Re-apply a grant an administrator edited under the old key |
| Soul Gateway subject keys and agent provider rows | `agent:proxies/soul-gateway`, `agent:AchillesIDE/<moved agent>` | `agent:AchillesIDE/soul-gateway`, `agent:legacy-agents/<agent>`, `agent:webmeet/<agent>` | Subjects are stored by principal; review the old rows in the Soul Gateway dashboard and remove them once the new subjects work |
| Meeting Secretary write authorization | `agent:AchillesIDE/webmeetScribeAgent` | `agent:webmeet/webmeetScribeAgent` | Defined in the webmeet source (`MEETING_SECRETARY_PRINCIPAL`); no stored state is known to convert, so verify meeting notes after the update |
| RoboTeam principal | `agent:AchillesCLI/roboTeamAgent` | `agent:AchillesIDE/roboTeamAgent` | Re-select any stored reference to the old ref (the Copilot launcher, WebTTY target and tests use the new ref) |
| Ploinky registry and selections (`.ploinky/agents.json`, enabled repositories, routing, QA prior-selection restoration) | Records `proxies/soul-gateway`, `AchillesCLI/roboTeamAgent`, `AchillesIDE/<moved agent>` and the `proxies` repository entry | `AchillesIDE/soul-gateway`, `AchillesIDE/roboTeamAgent`, `legacy-agents/<agent>`, `webmeet/<agent>` | Records are keyed by repository and agent, so an old record can coexist with the new one or fail the start preflight, and prior-selection restoration would re-enable the old ref. Disable the old records and repository through Ploinky before the first start, as the LiveKit repository migration does. This change ships no script for it |
| Containers and repository checkouts | `ploinky_proxies_soul-gateway_*`, `.ploinky/repos/proxies` and the former agent folders | `ploinky_AchillesIDE_*`, `ploinky_legacy-agents_*`, `ploinky_webmeet_*` | Old containers and the unused `proxies` checkout stay until removed with the supported Ploinky commands |

Post-redeploy checklist for QA. The preserving redeploy copies all durable data but does not re-key it, and Soul Gateway creates subject rows on the first signed call. Before the redeploy, export the DPU agent policy and the Soul Gateway subject and provider listings. After `verify-explorer-qa-runtime.yml` passes, review the rows for the old `agent:proxies/soul-gateway`, `agent:AchillesCLI/roboTeamAgent` and `agent:AchillesIDE/<moved agent>` principals and the DPU agent policies, and re-apply any customized limit or grant under the new key. The old keys stay inert. Confirm that an existing user signs in and finds their Explorer files, and that the Soul Gateway settings still list the prior providers and tiers with no tier naming a disabled provider. The migration of principals stays manual: this change ships the reference table above and no migration script. The post-split graph has not been deployed to QA before; the workflows were edited for the new repositories and the first redeploy is their first run.
