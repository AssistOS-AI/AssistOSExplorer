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

The tracked `deploy-explorer-qa.yml` and `destroy-explorer-qa.yml` workflows are the supported execution channels. Before dispatch, inspect the workflow at the requested revision and verify its exact inputs, target guards, credentials, branch selection, and fallback behavior against the user's requirements. A workflow name or historical successful run is not evidence that its current implementation satisfies those requirements. If an explicit request forbids `--branch-fallback`, do not dispatch a workflow that injects that option; use an authorized direct channel or update and verify the workflow first.

Explorer QA has exactly two tracked workflows. `deploy-explorer-qa.yml` takes no inputs, decides by itself what is needed, and always deploys the head of AssistOSExplorer `main` as resolved at the start of the run. `destroy-explorer-qa.yml` has one input, the `delete_data` checkbox. The former host-storage inspect and cleanup, runtime-verify, recovery and retired-source-absence workflows are gone: the route, the teardown receipts and the readiness checks inside the two workflows replace them, and the deploy test step still runs `tests/smoke/lib/retired-source-absence.test.mjs` on every dispatch. Both workflows share the concurrency group `deploy-explorer-qa` and take the host operation lock, so a destroy never overlaps a deploy.

The first deploy step pins that commit P. The in-place path keeps the exact pin: its selection and its update compare the remote head with P, because the selection classified P's diff. The Reconcile path (fresh installation and rebuild) accepts the head R it resolves later when R is P or a fast-forward descendant of P, so a teammate's ordinary push during a long run does not abort a rebuild after the old Box was removed. The ancestry is proven on the host from the remote history (a partial clone of the default branch, then `git merge-base --is-ancestor P R`). A rewritten or rewound `main`, a sibling branch head, or any failure of the proof (fetch error, missing commit, a `merge-base` status other than 0) fails closed. Every accepted move is logged as `AssistOSExplorer main moved from P to R (fast-forward, early|late)`. After `ploinky start` the deployed commit of every graph repository must equal the resolved one or be a fast-forward descendant of it, proven inside the Box. Helpers and tests come from the dispatched ref, so a branch can be dispatched to test a workflow change; the run summary records `ref@sha`, the pinned commit, the route and the deployed commit.

A read-only route step runs under the host lock before anything is stopped and prints one `Deployment route:` line.

| State found | Action |
| --- | --- |
| The QA workspace and its Box are absent | Fresh installation |
| The workspace exists but no current Box does: a destroy that kept the data, or a run that stopped after the Box was removed | Fresh installation onto the preserved data. The Reconcile first reduces the workspace to the kept set (see "Destroying QA") and restores the stashed access policy |
| Only AssistOSExplorer differs, the exact Box is running and the in-place updater accepts the change | In-place update with no downtime |
| Anything else differs: the Ploinky runtime, any other managed repository, AdvancedLanguageAgent, the Box image, an Explorer change the updater classifies as needing reconfiguration, a stopped exact Box, or an install marker left by an unfinished run while the exact Box is present (a marker with no exact Box routes to a fresh installation onto the preserved data) | Rebuild |
| An unexpected or unproven state: dirty sources, diverged history, ambiguous ownership, an unreachable image registry, a running Box that is not the exact one, an unknown QA-labelled container, a QA volume, QA containers without a workspace, a workspace that is not a real directory, a policy stash without a workspace or without a marker, or an engine listing that fails | The run is refused or fails; it never falls through to a rebuild or a fresh installation |

Ploinky, every other managed repository, AdvancedLanguageAgent and the Box image are updated only by a rebuild. The in-place update never changes them, and the selection never treats the image-owned AgentLib or its generations as drift. When `/home/admin/explorerQaWorkspace` exists and only AssistOSExplorer differs, the in-place update changes only its clean `AchillesIDE` checkout from the remote's configured default branch, pinned to the exact commit above. It fast-forwards the checkout under the workspace lock. Browser assets served directly from the verified managed source paths become available without restarting containers; affected server code uses Ploinky's targeted restart command. The existing Box, image, AgentLib, other repositories, accounts, documents, and caches remain in place. The deploy does not copy the workspace or create any backup. An unchanged commit is a verified no-op.

Dirty sources, a different branch, divergent history, ambiguous ownership, or changes to dependencies, manifests, or runtime installation configuration stop the in-place update before checkout. A failed restart restores the prior clean source commit. When the reviewed runtime proves the restart was rejected before signalling and the predecessor container is still running with its exact original identity, recovery republishes its withdrawn route through Ploinky's coordinated routing API; replaced runtimes restart against the previous code. A failure is still reported. The workflow never falls through from an unsuccessful update into a rebuild or a fresh installation. Its host operation lock covers the complete update and recovery, while each source mutation and targeted restart uses the workspace lock. Source and runtime identities are checked again after activation.

A rebuild is a destroy that keeps the data, followed by a fresh installation, in one run. After the read-only plan and the capacity check, it writes the install marker, quiesces and stops the Box, removes the Box and every QA container (including stopped legacy Boxes that older redeploys left behind), removes the cached outer Box image when no other container uses it, stashes the router access policy, and deletes the regenerable workspace state. It then installs fresh onto the data left in place. It makes no backup, retains no old Box and renames nothing. A fresh installation resolves Ploinky and every managed application repository from each remote's configured default branch, while keeping explicit per-repository selections for the graph. It never applies one global branch to the differently named application branches. A rebuild reuses the existing dedicated Cloudflare tunnel and refuses to create one; only a fresh installation, which has no old Box, may create it. AchillesAgentLib is not a selected repository: the Box image supplies it and that exact outer image is its identity, so the workflow pins no AgentLib commit. Once every agent in the default graph is running, the workflow validates every managed repository revision and the outer Box's image-owned AgentLib: the image-owned labels and `PLOINKY_BOX_IMAGE_ID` bound to the outer image, and the image's own `smoke-libraries.mjs inspect achillesAgentLib` probe on the sealed image and in the running Box. The library's build provenance is recorded as diagnostic only. A current QA Box in any other AgentLib mode is refused with the observed mode and the remedy.

QA Boxes use Ploinky's same-path workspace contract. The host workspace `/home/admin/explorerQaWorkspace` is mounted read-write at that same absolute path inside the Box, is the Box working directory, and is its only `PLOINKY_WORKSPACE_ROOT`. There is no `/workspace` alias. Deployment, teardown and readiness checks run every in-Box command against that path, and Box admission rejects a different workspace mount, working directory or workspace root. A Box created under the retired `/workspace` layout is neither adopted nor repaired by these helpers; remove it with the destroy workflow.

The deploy verifies the current image-bundled AgentLib source without inventing a host checkout or mount. It requires an exact Linux/amd64 image ID, the locked commit, matching bundle fingerprint and derived image source ID, and no mount covering the bundled library, sealed verifier, or Node interpreter. An offline, read-only, unprivileged temporary container verifies the immutable image's sealed metadata, root ownership and actual content. The running QA Box must independently return the same proof. Mounted managed/local selections retain clean Git-source, content fingerprint and physical source checks.

The workspace encryption identity is the master key, the encrypted `.secrets` store and the subject identity key. Ploinky `7d8c04d0` keeps them under `.ploinky/data` (`master-key`, `.secrets`, `ploinky_subject_identity_ed25519_v1.enc`, plus `passwords.enc`; Ploinky commit `12d76a76` moved them there so the masked controller root covers them), while earlier runtimes kept them directly under `.ploinky`. A rebuild or fresh installation onto existing data refuses, in its read-only plan and before anything is stopped, any of `.ploinky/master-key`, `.ploinky/.secrets` or `.ploinky/ploinky_subject_identity_ed25519_v1.enc` (code `QA_TEARDOWN_RETIRED_IDENTITY`), because the pinned runtime refuses them once QA is stopped; migrate each into `.ploinky/data` first. A workspace with `.data` needs `.ploinky/data/master-key` (`QA_TEARDOWN_KEY_MISSING`). Each identity file must be a regular file with one link, and the workspace, `.ploinky`, `.ploinky/data`, `.ploinky/code`, `.ploinky/skills`, `.data` and `.runtime` must be real directories rather than symlinks (`QA_TEARDOWN_UNSAFE_PATH`). A mount at or below the workspace or a deletion target stops the run with `QA_TEARDOWN_MOUNT_INSIDE`; remove the mount and dispatch again. Every refusal happens before anything is deleted. The reduction checks the identity files by SHA-256, owner and mode before and after, and fails if any changed.

The deploy workflow's remaining hard stops need no forced-rebuild input. When the selection itself fails the run exits and nothing is changed: `QA_UPDATE_NOT_FAST_FORWARD` (rewritten `main` history), `QA_UPDATE_STATIC_SOURCE_UNPROVEN` (a browser route rooted outside the managed checkout, for example a `devel` agent) and `QA_UPDATE_TARGET_NOT_UNAMBIGUOUS` (an aliased, `devel` or duplicate `AchillesIDE` agent). Remove the cause, that is disable the aliased or `devel` agent through Marketplace or Ploinky or restore fast-forward history on `main`, and dispatch again. Any drift in Ploinky, another repository, AdvancedLanguageAgent or the image selects the rebuild before the AssistOSExplorer change is classified, so the next such upstream change also clears a stuck AssistOSExplorer classification.

QA also clones `AdvancedLanguageAgent` into the fresh workspace root from its remote default branch and records its exact commit. Before starting Explorer, the workflow checks ALA's package identity, absence of runtime dependencies, real checkout and CLI directories, executable CLI, and the `--home`, `--cwd`, and `--MCPServers` help options required by RoboTeam. It rejects incompatible CLI options or a dirty or moved ALA revision. ALA needs no dependency installation or AgentLib binding. The Box's image-owned AgentLib checks remain required, and this workspace prerequisite does not change the readiness gate.

The default Explorer graph no longer enables Umami, WebMeet or LiveKit, and no longer installs the `legacy-agents` repository: `UmamiAgent` and `webmeet` stay in `repos` and Marketplace offers `UmamiAgent/umamiAgent` and `webmeet/webmeetAgent`, while `soplangAgent`, `tasksAgent`, `webAssist` and the other `legacy-agents` agents are neither cloned nor started, so the tracked-agent totals are 9 with 4 no-wait agents. Copilot runs through RoboTeam’s ordinary `default` robot; the retired `AchillesCLI/achilles-cli` agent is not a dependency. The default graph excludes the external `OnlyOfficeAgent/onlyOffice` agent, `webmeetAgent`, `liveKitServerAgent`, `webmeetScribeAgent`, and `webmeetStt`; the deployment pins the `OnlyOfficeAgent` repository alongside the other graph repositories while leaving the agent disabled. Readiness requires every runtime of the recursive default graph and every no-wait completion it declares; the workflow constants are checked against that graph by `explorer/tests/unit/retiredLocalModelGraph.test.js`. QA never re-enables prior optional agent selections. Administrators enable optional agents through Explorer Marketplace; a `legacy-agents` agent first needs its repository installed with `ploinky install repo https://github.com/AssistOS-AI/legacy-agents.git`. Meeting Secretary uses final browser SpeechRecognition transcripts and does not depend on the separate STT service.

The QA deployment workflow does not pull, start, or inspect a local model image; the retired `proxies/default-local-llm` agent is not part of the default graph. The local Soul Gateway seeds a restricted free OpenRouter provider on first start with the tiers `fast`, `code`, `plan`, `write`, `deep`, `ultra`, and `web-assist`. Its bundled credential is guarded to free models only and shares one daily quota with every installation using it, so deployments need outbound internet access for these tiers and must not rely on them as unlimited or offline capacity. Administrators replace the credential through the admin-only Soul Gateway settings dashboard. OpenCode's free models are available through the optional `legacy-agents/opencode-free` agent, which `ploinky start explorer` does not enable; its `legacy-agents` repository is not installed by default either, so to add it to a workspace run `ploinky install repo https://github.com/AssistOS-AI/legacy-agents.git` and then `ploinky enable agent legacy-agents/opencode-free` from the workspace root. The agent wraps the unmodified OpenCode CLI; once enabled, Soul Gateway discovers it like any other agent and adds it to no tier by default: plain-text chat only, no tool calls and no images, one answer per request delivered as a single chunk after several seconds, a free quota shared by every installation that uses the bundled key, and prompts subject to the free models' data-use terms. Native OpenCode execution through RoboTeam's installed OpenCode CLI is unchanged.

The `webmeet` repository supplies `webmeet/liveKitServerAgent` alongside WebMeet, and a fresh deployment starts neither: the workflow neither pulls the LiveKit image nor gates on LiveKit health, and keeps the `WEBMEET_*` variables for an administrator who enables WebMeet later; Explorer installs that repository through the `repos` map of `explorer/manifest.json`. Deployment repository lists must not install a separate media-runtime repository or `basic`. LiveKit keeps its immutable image, readiness contract, `.data/liveKitServerAgent/` storage, Router signaling/private Twirp paths, and single UDP `7882` media mux. Its relocation does not change the readiness gate. The image publication workflow in `container-image-builds` must select the `liveKitServerAgent/` build context from the `webmeet` repository. Integrate that source selection and the matching Ploinky listener profile before retiring the previous runtime source.

A workspace that still has the retired media repository must move its LiveKit owner to `webmeet` before startup: disable the old runtime records and repository through Ploinky, confirm no old runtime remains in the Box's nested Podman, and keep `.data/liveKitServerAgent/` throughout. Two owners cannot share the fixed media socket.

Direct operator execution has the same authority and safety boundary. Before a
destructive or externally visible mutation, positively identify the exact host,
workspace, environment, revisions, images, and recovery state. Authorization
for QA or local deployment never authorizes production or unrelated workloads.
Never expose secret values in commands, logs, reports, or artifacts.

## Required sequence

For an explicitly requested QA reset, dispatch `destroy-explorer-qa.yml` with `delete_data` checked and then `deploy-explorer-qa.yml`; leave the checkbox unchecked to remove everything a fresh deployment regenerates while keeping the data (see "Destroying QA"). A checked box permanently removes the QA data, so use it only when that reset has been explicitly authorized. Never prune unrelated host resources: both workflows act only on QA-owned containers, images, volumes, workspace and state paths, and both compare the protected non-QA resources before and after.

QA capacity admission, for a fresh install and for a rebuild, runs before the install marker is written and before anything is stopped (see "Install marker and crash recovery"). It prints byte counts for available and required space and for the reclaimable bytes. The diagnostics do not authorize deleting caches or other host resources.

Before the Reconcile checks, the QA workflow installs the SHA-256-pinned official Node.js 24.19.0 archive under `/home/admin/.qa-deployment-tools/` and prepends its `bin` directory only for that workflow. Existing installs are compared against the verified archive before execution. The shared host Node installation is unchanged, and neither destroy mode removes the toolchain, so a fresh installation uses it on the next dispatch. The in-place step also needs that toolchain. When it is missing and nothing of QA exists (no workspace, no QA container), the deploy proves absence in the shell and continues to a fresh installation, which installs the toolchain; when it is missing but QA exists, the run stops with a message naming the toolchain. Install the pinned archive under `/home/admin/.qa-deployment-tools/node-v24.19.0-linux-<arch>` by hand on the QA host and dispatch again; the deploy does not reinstall the toolchain over an existing installation.

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

1. Keep application data and its encryption keys in place. A QA rebuild must
   retain accounts, documents, local skills, access policies and revocations.
   A requested test-workspace reset is the destroy workflow with `delete_data`
   checked and has its own explicit target.
2. Build or pull the pinned multi-architecture box and dependency images.
3. Configure either explicit local-only mode or a complete dedicated-tunnel
   Cloudflare configuration. Never create a quick tunnel. The tracked Explorer
   QA workflow reuses the single `explorer-qa` tunnel, creates it through the
   Cloudflare API when it is absent (for example after the destroy workflow
   deleted it; only a fresh installation creates it), and fails if the name is ambiguous;
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
11. Enable `webmeet/webmeetAgent` in global mode (Marketplace or `ploinky enable agent webmeet/webmeetAgent global`), since the default graph does not start it, then run the real-browser OnlyOffice, Umami, and WebMeet gates. The GPTResearcher gate needs the `legacy-agents` repository, which the default graph no longer installs: run it only after installing that repository for the gate (`ploinky install repo https://github.com/AssistOS-AI/legacy-agents.git`) and enabling `legacy-agents/GPTResearcher`.
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
Explorer-owned target chooser, which requires a robot choice and an
explicit Open. It proves Ploinky Box is first, checks the exact
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

## Destroying QA

`destroy-explorer-qa.yml` has one input, the boolean `delete_data` (default unchecked). The dispatch itself is the confirmation; there is no separate confirm box. It needs no Ploinky runtime: it never calls the Ploinky CLI, `ploinky start` or `ploinky destroy`, it takes the host operation lock, and it succeeds when nothing is left. Logs and step summaries never print user file names or identity hashes, only counts, digests, IDs, stash state and codes. The plan also checks the legacy backups, so a backup refusal happens before anything is stopped. A `delete_data` destroy first renames the workspace and the state directory to `.deleting-*` tombstones next to them, so an interrupted destroy leaves QA absent and the next destroy finishes the tombstones; the deploy ignores them. It uses the same helpers as the rebuild, checked against their SHA-256, and runs a read-only plan before it changes anything. It compares the protected non-QA resources (containers, volumes and their images) before and after and fails if they changed. It never touches the shared `proxies` tunnel, the Soul Gateway workspace, the root Podman store, `/home/admin/.ploinky-box` or the QA Node toolchain under `/home/admin/.qa-deployment-tools`. After the host teardown succeeds, the runner deletes the dedicated `explorer-qa` Cloudflare tunnel and its DNS record in both modes (DNS first, so a partial failure never leaves DNS without its tunnel); it refuses the shared protected tunnel ID, and it is idempotent. The next fresh installation creates a new tunnel and record.

| Aspect | `delete_data` unchecked (keep data) | `delete_data` checked |
| --- | --- | --- |
| QA containers, volumes and image | Every QA container is stopped and removed, including stopped legacy Boxes left by older redeploys. The QA Box image is removed when no other container uses it. A QA volume makes the run refuse | The same, and QA volumes are removed |
| Quiesce | Fatal: if the Box cannot be quiesced, the teardown stops no container and deletes nothing, but nested services may already be stopped inside the running Box and a restart may be needed | Skipped |
| Workspace `/home/admin/explorerQaWorkspace` | Reduced to the kept set below | Removed entirely |
| State directory `/home/admin/.qa-deployment-state` | Holds the `destroy-keep` marker and the access-policy stash for the next deploy | Removed entirely |
| Legacy backups in `/home/admin/.qa-deployment-backups` | Removed when they are classified as safe to prune, see below | The same |
| Dedicated Cloudflare tunnel and DNS | Deleted | Deleted |

The kept set of a keep-data destroy (and of a rebuild or a fresh installation onto existing data) is every user file and the identity:

1. Every top-level entry of the workspace except `.ploinky`, `.runtime` and `AdvancedLanguageAgent`. This includes `.data`, `.env` and user documents such as `testN2/`, `WebMeet/` and `test1.backlog`; top-level inodes are unchanged.
2. Inside `.ploinky`, every entry whose name is not one of the regenerated runtime entries (`agents.json`, `routing.json`, `running`, `run`, `logs`, `box`, `deps`, `repos`, `agentlib`, `container-runtime`, `graph-skill-scope.json`, `data`, `enabled_repos.json`, `repo_sources.json`, `unregistered_agent_repos.json`). Only the second level of `.ploinky` is classified: unknown names are kept. Inside `.ploinky/code` and `.ploinky/skills`, real files and directories are kept; the symlinks Ploinky creates there are deleted without being followed.
3. Inside `.ploinky/data`, every entry except `edge-routing`, `edge-publication` and `router-security`. This keeps the identity files (`master-key`, `.secrets`, `passwords.enc`, `ploinky_subject_identity_ed25519_v1.enc`) and custom stores, and keeps their owner and mode.
4. The router access policy (`router-security`: policy, session revocations, audit log). It is copied to `/home/admin/.qa-deployment-state/router-security`, compared, and only then deleted from the workspace. The next deploy restores it, compares it again and removes the stash.

Deleted: `.runtime`, `AdvancedLanguageAgent`, the runtime entries listed above (other than `data`), the symlinks in `.ploinky/code` and `.ploinky/skills`, `.ploinky/data/edge-routing`, `.ploinky/data/edge-publication`, and the staging files `.ploinky/.explorer-qa-edge-desired.json` and `.ploinky/.explorer-qa-cloudflare-credentials.json` (the latter holds plaintext credentials and is never kept). The reduction is idempotent: a second run deletes nothing, and the kept listing is compared byte for byte before and after.

Legacy backups are the directories that the retired redeploy created under `/home/admin/.qa-deployment-backups`, with their helper and lock-receipt siblings. A deploy never touches them. A destroy, in both modes, removes only those proven complete: a `complete-redeploy` backup (a verified `preservation.json` whose source and target match, a `policy-restoration.json` with verified copies, and a `restored-selections.json` with a 64-hex Box ID) and a `no-workspace` backup (no `workspace/` and no quiesce evidence), together with their siblings and with `.pruning-redeploy-XXXXXXXX` tombstones. It keeps and lists in its receipt every other backup (one that records a recovery attempt, an incomplete redeploy, an unpreserved stop attempt, or an unrecognized entry), because data written after a redeploy may exist only there; remove those by hand under the host lock after review. A mount below the backups root stops the removal with `QA_TEARDOWN_MOUNT_INSIDE`.

## Install marker and crash recovery

The deploy and the keep-data destroy follow one rule: never lose data and never leave two Boxes. Every failure leaves either the untouched running QA or a state that the next dispatch finishes by itself.

The marker `/home/admin/.qa-deployment-state/install-pending.json` records `{version, operation, createdAt, dispatch}` with the operation `update` (fresh install), `rebuild` or `destroy-keep`. The deploy writes it as its first mutation, after the read-only plan, the quiesce preflight and the capacity check. It removes it as the last step before it reports "Explorer QA Box is ready", after the Box, the sources, AgentLib, Router and Soul checks and the protected-resource comparison have passed. A keep-data destroy writes its marker after the containers are removed and before the stash and the reduction. A policy stash is valid only with a marker; a stash without a marker, or a stash without a workspace, is refused so that nobody restores stale policy.

The deploy order for a rebuild or a fresh installation is: identity checks, QA Node installation, helper staging and SHA check, protected-resource snapshot, route re-proof under the Reconcile lock, preservation admission (only when the workspace exists and no marker was present), early commit check, quiesce preflight (a rebuild with a running Box and no marker), read-only teardown plan, capacity, marker, teardown, the install tail (clone sources, edge intent, prepare, restore the stashed policy and remove the stash, start, readiness, source and AgentLib checks), and completion. The plan runs before the marker, so a refusal, a failed preflight or a capacity shortfall leaves the running QA untouched.

Capacity is checked as root before the marker: free space plus the reclaimable bytes of the deletion targets and the removed image must be at least 16 GiB plus the size of the Box image to pull again (the size of the exact Box's image, or 2 GiB when there is no exact Box image). A shortfall is fatal and nothing has been changed. Resize the disk; do not delete durable data to make room.

| Where a run stopped | State left | What the next dispatch does |
| --- | --- | --- |
| Before the marker, including a refusal or capacity failure | QA untouched and running | Selects as usual |
| After the marker, during quiesce or stop | Marker, Box running or stopped | Rebuild (a quiesce failure only warns, because the marker predates the run) |
| During container or image removal | Marker, some containers | Rebuild if the exact Box remains, otherwise a fresh installation onto the data |
| During the stash | Marker, live policy intact, maybe a temporary copy | Discards the temporary copy and stashes again from the live policy |
| During the reduction | Marker and stash, no containers, workspace still holds the kept set | Fresh installation, which reduces again |
| In the install tail before the policy restore | Marker and stash, a new Box, empty policy | Rebuild; the stash is kept and restored |
| After the policy restore | Marker, no stash, restored policy, a Box | Rebuild; the policy is stashed again from the live files |
| In the runner checks after completion | Running Box, no marker | Selects as usual |
| Keep-data destroy: quiesce fails | No container stopped and nothing deleted, but nested services may already be stopped; the Box may need a restart | Selects as usual |
| Keep-data destroy: after the marker | `destroy-keep` marker, with or without stash, kept set intact | Fresh installation onto the data, restoring the stash if present |

The deploy log prints `Install marker kept; the next deploy finishes this installation from the preserved data.` when a run fails after the marker was written. Do not delete the marker by hand: dispatch the deploy again. An interrupted marker write heals on the next run.

A rebuild regenerates `.ploinky/enabled_repos.json`, `.ploinky/repo_sources.json` and `.ploinky/unregistered_agent_repos.json`, because a stale unregistered name makes agent resolution throw and a stale source entry pins a clone branch. Principal-keyed state is not re-keyed automatically; see the checklist below.

The prior agent selections of an old runtime are never enabled again; the fresh default graph is installed, and readiness is checked for that graph only. A `soplangAgent`, `tasksAgent`, `webAssist` or other `legacy-agents` selection is not carried over, because the fresh graph no longer installs that repository. Re-enable an optional agent through Marketplace if it is still required; a `legacy-agents` agent first needs its repository installed.

## Migrating principal-keyed state after the agent repository split

Moving agents to the `legacy-agents` and `webmeet` repositories, and `soul-gateway` and `roboTeamAgent` into this repository, renames their Ploinky identities. Ploinky derives an agent identity, its principal and its container name from the repository name and the agent name, so a workspace that already ran the earlier layout must be reviewed before it starts the new one. A fresh deployment is not affected.

| State | Old key | New key | Action |
| --- | --- | --- | --- |
| Per-agent data volumes such as `.data/soul-gateway` and `.data/roboTeamAgent` | Agent name | Agent name | Keyed by agent name, so they are expected to survive the move; confirm the mount after the first start |
| DPU agent policy for the search agent | `agent:proxies/searchAgent` | `agent:legacy-agents/searchAgent` | The default policy is added for the new key only when it is absent (`applyFreshDefaultAgentPolicies`). Re-apply a grant an administrator edited under the old key |
| Soul Gateway subject keys and agent provider rows | `agent:proxies/soul-gateway`, `agent:AchillesIDE/<moved agent>` | `agent:AchillesIDE/soul-gateway`, `agent:legacy-agents/<agent>`, `agent:webmeet/<agent>` | Subjects are stored by principal; review the old rows in the Soul Gateway dashboard and remove them once the new subjects work |
| Meeting Secretary write authorization | `agent:AchillesIDE/webmeetScribeAgent` | `agent:webmeet/webmeetScribeAgent` | Defined in the webmeet source (`MEETING_SECRETARY_PRINCIPAL`); no stored state is known to convert, so verify meeting notes after the update |
| RoboTeam principal | `agent:AchillesCLI/roboTeamAgent` | `agent:AchillesIDE/roboTeamAgent` | Re-select any stored reference to the old ref (the Copilot launcher, WebTTY target and tests use the new ref) |
| Ploinky registry and selections (`.ploinky/agents.json`, enabled repositories, routing) | Records `proxies/soul-gateway`, `AchillesCLI/roboTeamAgent`, `AchillesIDE/<moved agent>` and the `proxies` repository entry | `AchillesIDE/soul-gateway`, `AchillesIDE/roboTeamAgent`, `legacy-agents/<agent>`, `webmeet/<agent>` | Records are keyed by repository and agent, so an old record can coexist with the new one or fail the start preflight, and a rebuild regenerates the registry but does not remove records that live in kept state. Disable the old records and repository through Ploinky before the first start, as the LiveKit repository migration does. This change ships no script for it |
| Legacy agents in an existing local workspace | `legacy-agents/soplangAgent`, `legacy-agents/tasksAgent`, `legacy-agents/webAssist` (and any opted-in `legacy-agents` agent) enabled, `.ploinky/repos/legacy-agents` installed | None: the default graph no longer installs `legacy-agents` | Ploinky does not reset existing enablement, so a workspace started before the removal keeps them. Run `ploinky disable agent legacy-agents/soplangAgent`, the same for `tasksAgent`, `webAssist` and any other enabled `legacy-agents` agent, then `ploinky uninstall repo legacy-agents`. A `legacy-agents` checkout placed directly in the workspace root still contributes its IDE plugins, because Explorer also scans workspace-root repositories, until it is removed. Enabling the `copilot-agents/research-agents` bundle installs `legacy-agents` again, since that bundle declares it in `repos` and enables `legacy-agents/GPTResearcher`. This change ships no script for it |
| Containers and repository checkouts | `ploinky_proxies_soul-gateway_*`, `.ploinky/repos/proxies` and the former agent folders | `ploinky_AchillesIDE_*`, `ploinky_legacy-agents_*`, `ploinky_webmeet_*` | Old containers and the unused `proxies` checkout stay until removed with the supported Ploinky commands |

Post-rebuild checklist for QA. A rebuild keeps all durable data in place but does not re-key it, and Soul Gateway creates subject rows on the first signed call. Before the rebuild, export the DPU agent policy and the Soul Gateway subject and provider listings. After the deploy reports the Box ready, review the rows for the old `agent:proxies/soul-gateway`, `agent:AchillesCLI/roboTeamAgent` and `agent:AchillesIDE/<moved agent>` principals and the DPU agent policies, and re-apply any customized limit or grant under the new key. The old keys stay inert. Confirm that an existing user signs in and finds their Explorer files, and that the Soul Gateway settings still list the prior providers and tiers with no tier naming a disabled provider. The migration of principals stays manual: this change ships the reference table above and no migration script. The post-split graph has not been deployed to QA before; the workflows were edited for the new repositories and the first rebuild is their first run.
