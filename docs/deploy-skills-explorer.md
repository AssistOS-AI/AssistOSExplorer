# Deploy Explorer with Ploinky Box

Deployment is operator-controlled. Codex sessions are authorized operators when
the user's task selects the target deployment operation. They may invoke the
tracked GitHub Actions deployment workflows with `gh` or use direct SSH,
Ploinky CLI, container, registry, Cloudflare, DNS, and other remote operations
needed to complete that selected task.

The tracked `deploy-explorer-qa.yml` and `deploy-skills-explorer.yml` workflows
are supported execution channels. Before dispatch, inspect the workflow at the
requested revision and verify its exact inputs, target guards, credentials,
branch selection, and fallback behavior against the user's requirements. A
workflow name or historical successful run is not evidence that its current
implementation satisfies those requirements. If an explicit request forbids
`--branch-fallback`, do not dispatch a workflow that injects that option; use an
authorized direct channel or update and verify the workflow first.

The Explorer QA deploy workflow has no mutable branch inputs. It resolves
Ploinky and every managed application repository from each remote's configured
default branch, while keeping explicit per-repository selections for the graph.
It then reads the canonical achillesAgentLib URL and immutable commit from the
selected Ploinky dependency lock, requires that commit to equal the AgentLib
remote default-branch head, and leaves AgentLib on that exact locked commit
without applying one global branch to the differently named application
branches. Once all 14 agents are running, the workflow validates every managed
repository revision and the outer Box's locked AgentLib identity. The paired
destroy workflow requires only its explicit destructive confirmation and
preserves the deployed runtime as the authority for teardown.

An ordinary QA redeployment preserves workspace data. Before shutdown, the workflow rejects modified managed sources, unreviewed volumes or routing intent, unsupported recovery code, and insufficient disk space. It captures the exact predecessor, source revisions, image and agent selections in a new protected backup directory. A host lock serializes deployment and recovery operations.

The shutdown helper pins every registered container and its mounts. It drains OnlyOffice while DPU and Router remain available, stops consumers before providers, and requires PostgreSQL to report a clean shutdown. Router and its watchdog exit last. Failed or uncertain shutdown leaves the workspace in place. After shutdown, the workflow retains the stopped Box and its base image, moves the complete workspace under `/home/admin/.qa-deployment-backups/`, and copies durable files back with byte, ownership and permission comparisons. Operator files, local skills, database files and symlink targets remain intact. The master key, encrypted accounts and secrets, and subject-signing identity stay together. Fresh routing initialization precedes restoration of access policy, session revocations and audit history. Runtime registries, leases and compiled generations are regenerated.

Each backup contains reviewed recovery helpers and an authority record written before any stop or move. Run `node BACKUP/helpers/rollback-explorer-qa.mjs plan BACKUP --current-id FULL_ID` for a read-only recovery check, then replace `plan` with `execute` for the selected recovery operation. Use `absent` only when the failed replacement Box is absent. Recovery creates a fresh Box from the predecessor's pinned base image and clean source revisions, copies the saved durable data, restores policy and agent choices, and verifies new runtime identities and readiness. It preserves the predecessor and failed replacement snapshots. Recovery does not resume saved nested containers and does not claim browser acceptance.

Older runtimes that overwrite saved accounts during graph registration cannot be used for exact-code rollback. The workflow rejects them before shutdown. They require a separately reviewed forward migration using fixed source revisions and the authoritative saved data. Low disk capacity likewise requires a scoped operator recovery plan. A complete quiesced GNU tar archive can be streamed over SSH to protected local storage with checksum verification and numeric ownership, ACLs and xattrs retained. Record that off-host archive dependency before clearing any proven generated QA cache. Never prune unrelated host resources. Retain backups and image references until data preservation and browser acceptance pass; retained predecessor Boxes require explicit review before a later automated deployment.

QA also clones `AdvancedLanguageAgent` into the fresh workspace root from its remote default branch and records its exact commit. Before starting Explorer, the workflow links ALA's package dependency to the prepared Box's `/opt/ploinky-agentlib`, exercises the real loader, and checks the CLI options required by RoboTeam. It rejects a second AgentLib copy, a shadowing checkout, incompatible CLI options, or a dirty or moved ALA revision. No separate `npm install` is used for ALA, and this prerequisite does not change the fourteen-agent readiness gate.

Copilot runs through RoboTeam’s ordinary `default` robot; the retired `AchillesCLI/achilles-cli` agent is not a dependency. The default graph excludes `onlyOffice`, `webmeetScribeAgent`, and `webmeetStt`; readiness requires fourteen runtimes and ten no-wait completions. After that baseline is ready, QA restores prior optional agent selections through the supported CLI and verifies their aliases, authentication modes, profiles and readiness. Administrators can also enable optional agents through Explorer Marketplace. Meeting Secretary uses final browser SpeechRecognition transcripts and does not depend on the separate STT service.

The same AchillesIDE checkout supplies `AchillesIDE/liveKitServerAgent` alongside WebMeet. Deployment repository lists must not install a separate media-runtime repository or `basic`. LiveKit keeps its immutable image, readiness contract, `.data/liveKitServerAgent/` storage, Router signaling/private Twirp paths, and single UDP `7882` media mux. Its relocation does not change the fourteen-runtime or ten-no-wait gate. The image publication workflow in `container-image-builds` must select the `liveKitServerAgent/` build context from AssistOSExplorer. Integrate that source selection and the matching Ploinky listener profile before retiring the previous runtime source.

The Skills Explorer workflow migrates an existing media repository before installing, synchronizing, or updating application sources. It records every exact retiring runtime key in `.ploinky/livekit-repository-migration.json`, disables currently registered owners through Ploinky, and disables the old repository. Before uninstalling its checkout, a read-only Ploinky supervisor inspection validates the canonical workspace and owning Box. A bounded command checks the captured runtimes in that Box's nested Podman, requires an exact acknowledgement of their absence, and revalidates the Box identity. Host-engine absence is not sufficient. The workflow then uninstalls through Ploinky and verifies that no old runtime, enabled-repository entry, or checkout remains. Ploinky may retain inactive source-catalog metadata; that does not install or enable the repository.

Any lifecycle failure, uncertain ownership, retained runtime, or missing acknowledgement stops the workflow before source update. The migration record survives failure because a failed runtime stop can already have removed its registry row. Retrying inspects these saved keys but disables only records still owned by the retiring repository, preserving unrelated aliases. Complete supported Ploinky shutdown or recovery if a captured runtime remains, then retry. The workflow removes its migration record only after all postconditions pass and preserves `.data/liveKitServerAgent/` throughout. Other deployment paths must complete the same owner transition before startup; two owners cannot share the fixed media socket.

Direct operator execution has the same authority and safety boundary. Before a
destructive or externally visible mutation, positively identify the exact host,
workspace, environment, revisions, images, and rollback state. Authorization
for QA or local deployment never authorizes production or unrelated workloads.
Never expose secret values in commands, logs, reports, or artifacts.

## Required sequence

1. Preserve a consistent backup of application data and its encryption keys.
   Ordinary QA redeployment must retain accounts, documents, local skills,
   access policies and revocations. A requested test-workspace reset is a
   separate operation with its own explicit target.
2. Build or pull the pinned multi-architecture box and dependency images.
3. Configure either explicit local-only mode or a complete dedicated-tunnel
   Cloudflare configuration. Never create a quick tunnel. The tracked Explorer
   QA workflow requires the existing `explorer-qa` tunnel
   `89dd05b5-05a7-4bd4-9626-ec4343b07c67` and fails if it is absent or ambiguous;
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
11. Run the real-browser OnlyOffice, Umami, GPTResearcher, and WebMeet gates.
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
