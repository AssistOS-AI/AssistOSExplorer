# AssistOS Explorer Headless Smoke Suite

This package contains the maintainable Playwright smoke suite for Explorer, WebChat, WebMeet, DPU/OnlyOffice, and GitHub plugin paths.

## Quick Start

On a fresh deployment, run `npm run test:optional-agents` before any gate that
requires OnlyOffice. This opt-in gate requires OnlyOffice, WebMeet Scribe, and
WebMeet STT to be disabled in both Marketplace and the real runtime snapshot.
It enables all three through the actual Marketplace UI (OnlyOffice in global
mode), waits for Running in the UI and independent runtime evidence, and leaves
them enabled for subsequent editor and meeting gates. It fails if any agent is
already enabled; rerunning it requires another fresh deployment. Each service
has a ten-minute startup allowance for uncached image pulls. The evidence
attachment contains only agent identities and lifecycle states.

From this directory:

```bash
npm ci
npm run install:browsers
SMOKE_BASE_URL=http://127.0.0.1:8080 npm test
```

Run the exact Confidential `.docx` persistence gate with the repository-owned
selector. The command scopes collection to the OnlyOffice spec and uses the
distinctive test title without a start anchor because Playwright prepends the
project and spec filename to its internal grep title:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_WORKSPACE_ROOT=/path/to/explorer-workspace \
SMOKE_DEPLOYMENT_MODE=box \
SMOKE_BOX_BASE_URL=http://127.0.0.1:8080 \
SMOKE_PLOINKY_BOX_CONTAINER=<exact-box-container> \
SMOKE_PLOINKY_BIN=/absolute/path/to/candidate/ploinky/bin/ploinky \
npm run test:onlyoffice-confidential
```

`SMOKE_PLOINKY_BIN` is mandatory for this Box-mode gate so the targeted restart
uses the exact Ploinky checkout mounted read-only at `/opt/ploinky`. A different
checkout is rejected even when it happens to name the same commit.

The sign-in helper requires existing UserPersisto test accounts; it does not seed
local browser credentials or create accounts. The three release gates require
two distinct accounts. Complete the fresh
installation's **Create admin account** flow, register the second account, and
have the administrator grant that account the `user` role. Later public
registration defaults to `selfRegistered`, which permits the account dashboard
but does not permit Explorer access.

`SMOKE_USERNAME` and `SMOKE_SECONDARY_USERNAME` identify the expected Router
usernames when known. Set `SMOKE_LOGIN_EMAIL` and
`SMOKE_SECONDARY_LOGIN_EMAIL` to the UserPersisto sign-in emails; these are
independent account selectors and may differ from the stored usernames. Login
emails otherwise default to the corresponding `SMOKE_USERNAME` value.

```bash
SMOKE_USERNAME=owner SMOKE_LOGIN_EMAIL=owner@example.test \
SMOKE_PASSWORD='<owner-password>' \
SMOKE_SECONDARY_USERNAME=member SMOKE_SECONDARY_LOGIN_EMAIL=member@example.test \
SMOKE_SECONDARY_PASSWORD='<member-password>' \
SMOKE_BASE_URL=http://127.0.0.1:8080 \
npm test
```

For UserPersisto, the helper submits credentials only to its recognized password
form and verifies the resulting Router principal. A returned username matches
only the configured username, and a returned email matches only the configured
login email; either exact normalized field match identifies the configured
account. The returned username remains the canonical principal label when it is
present. Both accounts must have distinct immutable user ids and canonical
principal labels and must not be guests.

Run the dedicated public QA acceptance gate in headless Chromium with:

```bash
SMOKE_USERNAME=admin SMOKE_LOGIN_EMAIL='<qa-admin-email>' \
SMOKE_PASSWORD='<qa-admin-password>' npm run test:qa
```

`test:qa` is pinned to `https://explorer-qa.axiologic.dev`. It creates two
run-scoped Explorer users through the Administration UI, runs exactly two
browser tests, and removes the generated users afterward. The first test
creates a `.docx` under `/Confidential/My Space`, proves the active
editor is writable OnlyOffice with autosave enabled, makes a browser edit
without clicking Save, and reopens the document to prove persistence. The
second test has the two generated users create and join one WebMeet room and
proves that a message from each user is visible to the other. It also opens the
standalone WebMeet loader as an authenticated user, creates a public room, and
proves an unauthenticated guest can join through its direct invitation URL.

If the machine still has a negative DNS cache from before the QA record was
created, set `SMOKE_QA_EDGE_IP` to one of the hostname's current public
Cloudflare IPv4 addresses. The override is accepted only by the QA profile.

Artifacts are written outside tracked source by default:

```text
../../.ploinky/test-artifacts/headless-smoke/<run-id>/
```

Playwright traces, screenshots, videos, and JSON reports stay under `tests/smoke/test-results/` and `tests/smoke/playwright-report/`.

## Explorer UI A/B Benchmark

`benchmark:ui` measures the same read-only Explorer interaction sequence against
two deployments. Each iteration uses a fresh Chromium context with the browser
cache disabled. The sequence covers Router/login, Explorer interactive
readiness, a root refresh, normal workspace directory navigation, DPU-backed
Confidential navigation, a normal workspace file open, and Git modal readiness.

Run the baseline only after its full agent graph is admitted and stable:

```bash
UI_BENCHMARK_LABEL=master \
UI_BENCHMARK_BASE_URL=http://127.0.0.1:8080 \
UI_BENCHMARK_PLOINKY_SHA=<deployed-ploinky-sha> \
UI_BENCHMARK_EXPLORER_SHA=<deployed-explorer-sha> \
npm run benchmark:ui
```

Cleanly replace the deployment, wait for the comparison graph to reach the same
readiness state, and run the identical command with a different label and the
deployed SHAs:

```bash
UI_BENCHMARK_LABEL=ploinky-proxy \
UI_BENCHMARK_BASE_URL=http://127.0.0.1:8080 \
UI_BENCHMARK_PLOINKY_SHA=<deployed-ploinky-sha> \
UI_BENCHMARK_EXPLORER_SHA=<deployed-explorer-sha> \
npm run benchmark:ui
```

The runner defaults to three fresh iterations and writes a mode-`0600`
`result.json` below:

```text
../../.ploinky/test-artifacts/ui-benchmark/<run-id>/
```

Compare the reports with the first result as the baseline:

```bash
npm run benchmark:ui:compare -- \
  <master-result.json> \
  <ploinky-proxy-result.json> \
  --output <comparison.json>
```

Negative comparison deltas mean the candidate is faster. The artifact contains
per-operation visible and network-settled latency, request timing grouped by
Router/Explorer/DPU/Git route, transfer and cache counts, duplicate and aborted
requests, browser long tasks, rendering/JavaScript CPU counters, and initial
page metrics. It deliberately excludes request and response bodies, headers,
cookies, credentials, URL queries, console text, screenshots, and traces.

Each step records whether its fixed 1,500 ms network tail completed the quiet
window or reached the cutoff. Cutoff samples include only a bounded active
request count and are excluded from settled-latency aggregates; their final
request summaries are rebuilt from the same immutable waterfall snapshot
written for the iteration. Long-task values also include observer support and
availability state, so unavailable instrumentation is reported as missing
rather than as zero work.

For a valid A/B result, use the same host, clean workspace fixture, browser
version, viewport, iteration count, paths, and fully admitted deployment state.
The comparison command validates the complete scenario fingerprint and the
recorded target, browser, headless/cache, viewport, platform, architecture, OS,
and Node controls before producing output. Do not run the deployments
concurrently. This benchmark is a performance probe; it does not replace the
functional smoke or release suites.

## Explorer Deployment Resource A/B Benchmark

`benchmark:resources` measures steady-state resource consumption for the full
Explorer graph. The first report is required to come from the direct-host
`master` deployment; the second is required to come from the nested
`ploinky-proxy` Box deployment. Run both sequentially on the same dedicated
Linux host with the same clean workspace data, exact 16-target graph, container
runtime version, kernel, Node version, CPU, and memory.

Keep the benchmark harness itself at one fixed commit outside the workspace
being replaced. The harness source is not part of the deployment under test.
After the direct-host master graph is admitted and has no active browser or
external workload, record the reference:

```bash
RESOURCE_BENCHMARK_LABEL=master \
RESOURCE_BENCHMARK_VARIANT=master \
RESOURCE_BENCHMARK_DEPLOYMENT_ID=<non-secret-master-deployment-id> \
RESOURCE_BENCHMARK_PLOINKY_SHA=<exact-deployed-master-sha> \
RESOURCE_BENCHMARK_EXPLORER_SHA=<exact-deployed-master-explorer-sha> \
npm run benchmark:resources
```

Cleanly replace the deployment with `ploinky-proxy`, admit the same exact graph,
leave it idle, and record the candidate:

```bash
RESOURCE_BENCHMARK_LABEL=ploinky-proxy \
RESOURCE_BENCHMARK_VARIANT=ploinky-proxy \
RESOURCE_BENCHMARK_DEPLOYMENT_ID=<non-secret-proxy-deployment-id> \
RESOURCE_BENCHMARK_PLOINKY_SHA=<exact-deployed-proxy-sha> \
RESOURCE_BENCHMARK_EXPLORER_SHA=<exact-deployed-proxy-explorer-sha> \
npm run benchmark:resources
```

The v1 protocol uses a five-minute warmup followed by 30 minutes of sampling
every ten seconds. It reads whole-host CPU counters, memory, swap, load,
processes, and zombies directly from `/proc`. It queries Podman only before
warmup, after warmup, and after sampling. A report fails if the direct master
contains an outer Box, the proxy does not contain exactly one outer Box, the
running target count is not exactly 16, or any target/Box identity changes
during the run.

Results are mode-`0600` files below:

```text
../../.ploinky/test-artifacts/resource-benchmark/<run-id>/result.json
```

Compare them with the master report first:

```bash
npm run benchmark:resources:compare -- \
  <master-result.json> \
  <ploinky-proxy-result.json> \
  --output <comparison.json>
```

The comparison rejects different host or scenario fingerprints and reports
master-relative p95 CPU, memory, swap, load, and process counts; maximum zombie
count; and memory, process, and zombie growth per minute. Positive deltas mean
the proxy candidate consumed more. The initial comparison is evidence, not an
arbitrary pass/fail budget: establish explicit release thresholds only after a
valid master reference and a corrected proxy candidate have both been captured.

No historical master resource artifact exists in this repository. Do not
substitute the currently overloaded proxy measurements for the reference, and
do not claim comparability if the exact historical master deployment cannot be
reproduced on the controlled host.

## Fixed Router/Auth Release Baseline

The Ploinky release harness runs this exact Chromium baseline after the full
graph and topology-aware listener gate succeed. The harness keeps the graph
alive while it runs and executes it before cleanup or graph destruction, with
no retry, skip, or weakened assertion:

```bash
cd ${WORKSPACE_ROOT}/AssistOSExplorer/tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:18080 npm test -- --project=chromium specs/00-router-auth.spec.mjs
```

It proves the active Router root landing, Explorer shell, and routed WebChat
shell. The root case enters `/` and waits for the selected Explorer surface to
finish loading. Other cases authenticate directly into their intended surface,
without first booting and abandoning Explorer. Credentials are submitted only
on Router's `/auth/login` page; the retired `/dashboard` route is not a login destination. It is not the separate
WebMeet external-network or two-account
ScreenShare gate, and none of those gates substitutes for another.

The focused authentication navigation regression uses installed Chromium:
`node --test lib/auth-navigation.test.mjs`.

## Ploinky Core WebTTY Release Gate

Run the administrator/ordinary-user WebTTY gate against a fresh local Box and
its exact host workspace:

```bash
SMOKE_BASE_URL=http://127.0.0.1:18080 \
SMOKE_WORKSPACE_ROOT=/absolute/path/to/the/box/workspace \
SMOKE_DEPLOYMENT_MODE=box \
SMOKE_PLOINKY_BIN=/absolute/path/to/the/verified/ploinky/bin/ploinky \
SMOKE_PLOINKY_BOX_CONTAINER=ploinky-box-workspace-0123456789ab \
SMOKE_EXPECT_BOX_IMAGE_ID=sha256:<exact-64-hex-image-id> \
SMOKE_EXPECT_BOX_IMAGE_REF=docker.io/assistos/ploinky-box:<immutable-candidate> \
npm run test:webtty
```

The gate requires the canonical local `admin` and `user` accounts. It proves
the administrator-only Explorer launcher, the native chooser's accessible
name, Box-first ordering, and that the chooser renders exactly the bounded
safe target rows independently derived from exact current registry, immutable
container, ownership-label, and mount evidence. The fresh graph must include
the global `gitAgent` and isolated `liveKitServerAgent`; the former must be
eligible and the latter must be absent for the selected folder. Any naturally
present effective read-only or destination-shadowed mount is evaluated by the
same independent physical inventory instead of being fabricated by the test.

The gate selects both Box and agent targets through opaque fragment-only
launches. It proves immediate fragment stripping and no-referrer handoff,
single-use replay and cross-session rejection, origin/CSRF enforcement, safe
target banners, independently translated working directories, two-way PTY I/O,
resize, disconnect cleanup with a foreground child, targeted agent replacement,
stale launch rejection, real chooser refresh, authentication-revocation
cleanup, default Router restart recovery, and Box availability after agent and
Router lifecycle events. It also proves that an ordinary user does not receive
the launcher and gets `403` from the page, discovery, and exact launch-record
session mutation. A direct `?dir=` URL is required to fail closed without
creating a session. Missing workspace root, non-loopback target, missing exact
fresh graph runtime, softened assertion, or skipped target state is a hard
failure while this gate is selected.
The Box generation must be fresh, but its prebuilt image may be older only when
the gate binds the exact container name, immutable image ID/reference, and
read-only mounted Ploinky candidate derived from `SMOKE_PLOINKY_BIN`.

The intentional Router crash targets the recovery terminal, not unrelated
Explorer background traffic. The gate first requires clean primary-page
diagnostics, navigates that Explorer page to `about:blank`, and keeps the
terminal's exact prior-epoch transport-error oracle active. Only after a new
Router identity and healthy authenticated endpoint are verified does it reopen
Explorer and require clean diagnostics again. Before navigation, WebTTY quiescence
waits for Explorer's deferred runtime-plugin render chain and its outstanding
finite requests through body completion, including authorization and icon loads
outside that render chain. Observation begins before the first navigation;
only successful responses with an exact `text/event-stream` media type are
excluded from the bounded wait. Failed requests remain diagnostic failures,
and both pre-navigation and post-navigation checks remain strict. This wait is
not evidence of a fix for terminal startup or cleanup failures. Evidence records the quiesce,
Router recovery, and Explorer reopen timestamps; no global error filter is used.

The listener gate always requires `required-loopback`, requires exactly one
listener for each eligible `required-assigned-managed-gateway`, and requires no
listener for an `inactive-unassigned-managed-gateway`. The inactive state
remains fail-closed and does not prove managed-bridge activation or
reachability. Missing or stale assignment evidence, cross-interface assignment,
a missing or extra listener, a wildcard, or an unrelated bind fails closed.

## Coverage

Default smoke checks:

- Router auth, root landing, Explorer shell, and WebChat shell.
- WebChat file and folder uploads through the browser.
- WebChat direct-workspace upload containment: exact `relativePath`, selected-project `workspacePath`, and encoded `/workspace-files/` download URL.
- WebChat `@` file suggestions shared by sibling sessions opened at the same selected project directory.
- WebChat provider-looking `@open-interpreter` text is not offered as a dispatch suggestion.
- WebMeet room creation, two-account join, chat delivery, and cleanup.
- WebMeet provider-looking `@open-interpreter` text stays ordinary meeting chat.

Each upload test creates a unique empty project directory through Explorer's
authenticated filesystem MCP, selects it in both relevant WebChat contexts, and
requires the exact `__ASSISTOS_EXPLORER_EMPTY_TEXT__` transport sentinel from its
initial directory listing. An arbitrary empty/missing/error response is not
accepted as proof that the fixture is empty: the MCP helper validates a sole text
block and a successful result before decoding, so error flags or extra blocks
cannot be discarded into a false empty-directory result. The test deletes that
exact fixture through the same MCP during cleanup. Setup authenticates
into an inert same-origin WebChat CSS document, without starting a root chat or
displaying credential responses. Cancellation waits for the exact control request's
successful, completed HTTP 204 response rather than optimistic idle UI. Cleanup
requires clean diagnostics and identifies the sole active, successful EventSource
for that project before navigating back to the inert document. It requires that
stream to terminate and the document's successful response and exact origin/path
before deleting the project. Only the captured stream's intentional navigation
abort may be acknowledged through the exact diagnostic ledger; other, duplicate,
prior, and later failures remain fatal, and evidence is retained. No active WebChat
page watches a removed working directory. Folder suggestions are tested by selecting
the uploaded folder, then its nested folder, then the exact uploaded relative path:
`@` lists the active folder, not all descendants recursively. Browser diagnostics
remain enabled throughout. Ordinary source
checkouts at the workspace root must not determine the upload fixture's quota
usage. The production file-count/byte quotas and reserved-path exclusions remain
unchanged.

`npm run test:unit` includes isolated Chromium regressions for these cleanup and
diagnostic boundaries, so run `npm run install:browsers` before that suite. Missing
Chromium is a test failure, not a silently skipped lifecycle check.

The Marketplace lifecycle test controls both the Marketplace snapshot and the
runtime NDJSON stream with one synthetic lifecycle. It verifies Starting up,
Running, Stopped, and Disabled, including labels, accessibility, Configure and
runtime-mode readiness. This is UI lifecycle evidence, not proof that the mocked
agent was actually started or stopped.

Opt-in checks:

- `SMOKE_OPEN_INTERPRETER=1` runs Copilot semantic routing and AKU memory checks that require configured external provider runtime.
- `SMOKE_CODEX_DELEGATION=1` enables spec 06, which opens Copilot from an Explorer folder, requires delegation to exact `codexAgent`, verifies the structured task reaches `COMPLETED`, and proves the requested file contents through Explorer UI. Configure and validate Soul Gateway's `fast` tier before running it.
- The ordinary Copilot folder-launch spec requires `SMOKE_RELEASE_MANIFEST` and
  binds that immutable 421 release bundle to the running outer Box before and
  after Playwright. For public QA, keep `SMOKE_BASE_URL` on the real public
  application and set `SMOKE_BOX_BASE_URL` to the exact host-loopback Router
  publication used only for local Podman generation inspection. The live Box
  inspector still rejects non-loopback, ambiguous, stale, or mismatched outer
  containers. Its exact semantic-label contract includes the selected
  nested-Podman seccomp profile fingerprint and the selected achillesAgentLib
  mode, source-identity hash, content fingerprint,
  workspace-relative source path, and Git commit. The ordinary Copilot gate
  requires that live AgentLib commit to equal the verified release-manifest
  commit before and after Chromium. It requires a fresh outer-container
  generation and the manifest's exact immutable image digest/reference; unlike
  the screen and native network gates, it does not require that already-pinned
  release image to have been built within the last four hours. The browser never
  substitutes the loopback URL for public QA.
- `SMOKE_WEBMEET_MEDIA=1` enables fake camera/microphone and asserts WebRTC stats increase.
- `npm run test:webmeet-headless` is the automated WebMeet acceptance profile. It runs in headless Chromium with deterministic synthetic camera and microphone sources, requires two distinct configured accounts, proves room create/join and bidirectional chat, exercises settings/privacy and ordinary tagged-research chat, and requires separate growing outbound audio, outbound video, inbound audio, and inbound video RTP stats in both browsers. It forbids headed execution and screen sharing.
- `npm run test:webmeet-screen` remains a separate explicit, headed, opt-in gate for physical-display ScreenShare capture. It is not part of `test:full` or automated headless acceptance. Both distinct accounts must authenticate and exchange real LiveKit screen tracks in both directions. The probe removes TURN servers, and each direction requires active non-relay selected pairs using a globally routable IPv4 and UDP 7882 in both browsers alongside exact ScreenShare publication identities and source-specific RTP packet/frame growth. When Chromium redacts a peer-reflexive remote address or port, every observable field must still be correct and the missing field is replaced only by a proof bound to the exact LiveKit container generation and its real UDP 7882 listener. An observable wrong address, port, protocol, relay candidate, changed generation, or invalid server proof fails. The gate never stubs `getDisplayMedia` or skips a missing secondary account. This local gate does not claim the address equals the configured public IPv4; that stricter assertion belongs to the native external-network matrix below.
- `SMOKE_WEBMEET_REFRESH=1` adds the real join-material lifecycle gate. Both browsers must receive a scheduled material rotation before the original TURN expiry, remain joined with growing RTP after that original expiry, then survive a real Playwright offline/online transition with another broker call, disconnect/recreate/rejoin, and renewed RTP. This gate requires `SMOKE_WEBMEET_MEDIA=1` and a test box started with a short supported credential lifetime (recommended `PLOINKY_TURN_CREDENTIAL_TTL_SECONDS=60`); it fails rather than mocking time or join responses when the original expiry exceeds `SMOKE_WEBMEET_REFRESH_MAX_WAIT_MS` (default 180000).
  Only non-secret SHA-256 fingerprints are attached, and both the participant
  token and credential-bearing RTC configuration must rotate independently.

On macOS, keep the automated headless profile running when physical monitors
are off by holding system-sleep assertions for the lifetime of the command:

```sh
caffeinate -dimsu npm run test:webmeet-headless
```

Run the separate headed screen-share gate against a fresh host-local deployment with:

```sh
SMOKE_DEPLOYMENT_MODE=local SMOKE_BASE_URL=http://127.0.0.1:8080 SMOKE_WEBMEET_MEDIA=1 SMOKE_WEBMEET_SCREEN=1 SMOKE_TEST_TIMEOUT_MS=240000 npm test -- --headed --project=chromium specs/30-webmeet-room-chat.spec.mjs
```

In local mode the wrapper requires exactly one freshly started, managed
`liveKitServerAgent` container using host networking and no container port
publications. It also rejects any concurrently running outer Ploinky Box. The
wrapper runs `ss` inside that exact network namespace to prove the UDP 7882
listener before and after the browser run. The real browser assertions then
prove bidirectional non-relay UDP/7882 traffic.

Run the same gate against a fresh Ploinky Box deployment with:

```sh
SMOKE_DEPLOYMENT_MODE=box SMOKE_BASE_URL=http://127.0.0.1:8080 SMOKE_WEBMEET_MEDIA=1 SMOKE_WEBMEET_SCREEN=1 SMOKE_TEST_TIMEOUT_MS=240000 npm test -- --headed --project=chromium specs/30-webmeet-room-chat.spec.mjs
```

Shared local Box discovery, including the headless acceptance gates, supports
isolated deployments such as Router TCP `28080` and media UDP `27882` alongside
another Box. Exactly one running Box must match the selected loopback Router
port; its only other publication must be
`0.0.0.0:<media-host-port label>:7882/udp`. Both host ports must match the
immutable Box labels, and missing, malformed, mismatched, or additional
publications fail. This does not change the fixed UDP `7882` scanner and ICE
requirements of the screen-share and external-network gates below; those gates
reject an alternate media host port.

For the screen-share gate in Box mode, exactly one outer container must publish
`127.0.0.1:<SMOKE_BASE_URL port>:8080/tcp` and
`0.0.0.0:7882:7882/udp`, carry the exact semantic Box ownership labels, and use a freshly built
image. Those labels include the exact AgentLib selection identity; missing,
extra, malformed, or changed selection labels fail the gate. No additional
outer-container port publication is accepted. By default
the running generation must be at most 30 minutes
old and the image at most four hours old. The wrapper binds the test to that
container ID, start time, image ID/reference, and normalized two-publication
boundary, re-inspects it after Playwright exits, and fails if any value changed.
It also inspects nested Podman through that exact outer container, binds the
nested LiveKit container ID and start time, requires host networking with zero
inner bindings, and proves UDP 7882 with `ss` in the nested LiveKit namespace.
`SMOKE_PLOINKY_BOX_CONTAINER`, `SMOKE_EXPECT_BOX_IMAGE_ID`, and
`SMOKE_EXPECT_BOX_IMAGE_REF` can pin expected values more narrowly. The command
does not accept a pre-authored evidence file or a bypass for this live check.

The native external-network release matrix is separate from the local screen-share gate. Run it once on native Linux amd64 (`SMOKE_EXPECT_ARCH=x64`) and once on native Linux arm64 (`SMOKE_EXPECT_ARCH=arm64`) against a freshly built Box. It requires two dedicated Chromium CDP endpoints on distinct external networks, their independently verified egress IPv4 addresses, a CORS-enabled test echo endpoint, the configured LiveKit public IPv4, two distinct accounts, external TURN test credentials, and lane-specific test topology. The command runs `direct-udp`, `turn-udp`, and `turn-tls` in sequence and hard-fails on missing prerequisites:

```bash
SMOKE_EXPECT_ARCH=x64 \
SMOKE_BASE_URL=https://explorer.test.example \
SMOKE_WEBMEET_PUBLIC_IPV4=203.0.113.10 \
SMOKE_PLOINKY_BOX_CONTAINER=ploinky-box-explorer-0123456789ab \
SMOKE_EXPECT_BOX_IMAGE_REF=docker.io/assistos/ploinky-box:runtime \
SMOKE_EXPECT_BOX_IMAGE_ID=sha256:<exact-64-hex-image-id> \
SMOKE_EXTERNAL_TCP_PROBE_RUN_ID=<fresh-nonce> \
SMOKE_EXTERNAL_SCANNER_A_SSH_TARGET=scanner-a \
SMOKE_EXTERNAL_SCANNER_B_SSH_TARGET=scanner-b \
SMOKE_EXTERNAL_SCANNER_A_HOST_FINGERPRINT_SHA256='SHA256:<pinned-openssh-fingerprint-a>' \
SMOKE_EXTERNAL_SCANNER_B_HOST_FINGERPRINT_SHA256='SHA256:<pinned-openssh-fingerprint-b>' \
SMOKE_EXTERNAL_TURN_UDP_URL='turn:turn-udp.test.example:3478?transport=udp' \
SMOKE_EXTERNAL_TURN_TLS_URL='turns:turn-tls.test.example:5349?transport=tcp' \
SMOKE_BROWSER_A_CDP_URL=wss://browser-a.test/devtools/browser/id-a \
SMOKE_BROWSER_B_CDP_URL=wss://browser-b.test/devtools/browser/id-b \
SMOKE_BROWSER_A_NETWORK_ID=external-net-a \
SMOKE_BROWSER_B_NETWORK_ID=external-net-b \
SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4=198.51.100.21 \
SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4=198.51.100.22 \
SMOKE_NETWORK_ECHO_URL=https://echo.test.example/ip \
SMOKE_USERNAME='<account-a>' SMOKE_PASSWORD='<account-a-password>' \
SMOKE_SECONDARY_USERNAME='<account-b>' SMOKE_SECONDARY_PASSWORD='<account-b-password>' \
npm run test:webmeet-network-matrix
```

Replace the documentation-only IPv4 values above with globally routable
literals; the runner rejects RFC 1918, loopback, link-local, benchmark, and
documentation ranges. The two TURN URLs are non-secret endpoint selectors.
Short-lived usernames and credentials must arrive in each browser's real join
material and are never accepted in these environment variables or artifacts.

For the direct lane, the browser probe removes relay servers and every active
selected pair must use the configured public IPv4 and UDP 7882; UDP 7881 and
private/discovered alternatives fail. The TURN/UDP lane retains only explicit
`turn:` UDP URLs matching the configured external host and port and sets the
real peer connection to relay-only. The TURN/TLS lane retains only the exact
`turns:` TLS-over-TCP endpoint and also sets relay-only. Each browser must show
separate growing outbound audio, outbound video, inbound audio, and inbound
video RTP rows. This forces real transport selection without mocking LiveKit
signaling, peer connections, or media. The remote egress check proves the
browsers are on distinct external networks instead of trusting labels alone.
CDP endpoints and echo/TURN resources must be dedicated test resources. CDP
endpoints must use credential-free, query-free HTTPS or WSS URLs; the echo URL
must likewise be credential-free, query-free HTTPS. The runner redacts complete
CDP URL values from diagnostics as a second defense for opaque endpoint paths.

Before each lane starts, the wrapper connects non-interactively to one dedicated
scanner on each named external browser network and sends the repository-owned
scanner program directly to `python3` over stdin. The two SSH targets must be
distinct aliases (or `user@host` values) with pinned host keys already present
in the runner's `known_hosts`; the expected OpenSSH `SHA256:...` host-key
fingerprints are also required explicitly. `BatchMode=yes`,
`StrictHostKeyChecking=yes`, and a non-multiplexed SSH connection are mandatory,
and the negotiated key must equal the configured fingerprint. No scanner
credential is accepted in an environment variable. Each executed scanner verifies its HTTPS echo egress,
scans the configured public IPv4 across the complete TCP range 1..65535, and
sends an unauthenticated STUN Binding request without MESSAGE-INTEGRITY to UDP
7882. The lane requires `openPorts:[]` and requires that invalid ICE request to
time out or receive a STUN error—never a success response.

The wrapper records schema-version-2 evidence bound to the fresh probe nonce,
exact outer container ID/start/image, target IPv4, scanner source SHA-256,
SSH target SHA-256, negotiated host-key fingerprint, exact returned-byte
SHA-256, unique scan ID, and scan
timestamps. It passes only those non-secret fingerprints to the browser spec,
which independently revalidates them. Both scans must start after the current
box generation and finish no more than 15 minutes before validation. A stale or
partial scan, source/egress/fingerprint mismatch, invalid-ICE success, or any
open TCP port fails before either browser opens.

The matrix wrapper also requires a native rootless Podman server using Netavark. It
captures Podman client/server versions, native server OS/architecture,
Netavark version, and Aardvark DNS version. It also inspects the exact named
running outer container and exact expected image ID/reference, requires the exact
semantic Box labels and an unlabeled image, and normalizes `HostConfig.PortBindings` to exactly loopback Router
TCP plus wildcard UDP 7882. The image creation and container start times must
also satisfy the same bounded fresh-build/fresh-generation contract as the
local screen gate (`SMOKE_BOX_MAX_IMAGE_AGE_MS` and
`SMOKE_BOX_MAX_GENERATION_AGE_MS` may only tighten those hard maximum bounds).
Those records and the bound two-network TCP-negative
scan are attached to each lane's `container-engine-evidence.json`; missing or
mismatched evidence fails before either browser is opened. The wrapper
re-inspects the box after every lane, including a failed browser lane, and
aggregates a lane failure with any post-lane evidence failure. It fails if the
exact container generation changes while that lane runs. The TURN/TLS lane automatically
enables the real credential-expiry/network-transition gate.

On headed Linux without `DISPLAY`, the npm runner starts a deterministic 1920×1080 Xvfb display. It fails with an actionable error if Xvfb is unavailable; it does not downgrade to headless capture.
- `SMOKE_UMAMI=1` enables the real Umami Router gate. It authenticates first at
  Ploinky and then at Umami, proves dashboard HTML, assets, heartbeat API, and
  in-app navigation stay under
  `/base-agent-additional-server/umamiAgent/3000/`. Browser-canceled RSC requests
  require independent proof that the original application reader consumed the
  complete response. Repeated URLs require equal request/consumer counts and
  complete, error-free EOF with the same positive byte count for every member;
  partial or ambiguous siblings fail the gate. Raw browser failures remain in
  the diagnostic ledger.
- `SMOKE_GPT_RESEARCHER=1` enables the real GPTResearcher Router gate for HTML,
  assets, reports API, same-origin redirect rewriting, and a browser WebSocket
  ping/pong under `/base-agent-additional-server/GPTResearcher/8000/`. Root-relative and private-origin
  requests fail the gate.
- `SMOKE_ONLYOFFICE=1` enables the real spec 50 editor gate. It creates an
  encrypted DPU document, types through the pinned OnlyOffice UI, clicks the
  actual `#btn-save`, proves the callback replaced the encrypted blob, then
  prepares authenticated CSRF-bound restart proof before typing a second
  distinct edit without clicking save. It proves DPU state is still unchanged,
  invokes the targeted restart without another authentication request, proves
  drain produced another callback acknowledgement, and reopens both markers.
- `SMOKE_GITHUB=1` enables GitHub plugin authentication checks.

Run the Umami publication gate against a fresh Box Explorer stack:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_UMAMI=1 \
SMOKE_UMAMI_USERNAME=admin \
SMOKE_UMAMI_PASSWORD='<dedicated-test-password>' \
npm test -- --project=chromium specs/33-umami-routing.spec.mjs
```

Run the GPTResearcher publication gate:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_GPT_RESEARCHER=1 \
npm test -- --project=chromium specs/34-gpt-researcher-routing.spec.mjs
```

Run the OnlyOffice DPU/save/drain/reopen gate with paths from the same fresh
workspace used by the box:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_ONLYOFFICE=1 \
SMOKE_WORKSPACE_ROOT='<fresh-workspace>' \
SMOKE_TEST_TIMEOUT_MS=240000 \
npm test -- --project=chromium specs/50-onlyoffice-dpu.spec.mjs
```

These opt-in gates skip only while their flag is off. Once a flag is `1`,
missing credentials, topology, services, browser behavior, or sanitation
evidence is a hard failure.

## GitHub DPU Token Ownership

The GitHub smoke lane verifies the DPU-backed token ownership path used by
`gitAgent`. It stores a synthetic manual GitHub token through the router MCP
surface, confirms the DPU secret is owned by the signed-in user, checks that the
encrypted secret value is not stored in plaintext, verifies the secret appears
under Explorer `/Confidential/Secrets`, and confirms disconnect removes both the
state record and per-secret ACL entry.

Run it against a local deployment with:

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_GITHUB=1 \
npm test -- --grep "GitHub token DPU ownership"
```

The same lane also fabricates a pre-delegation, agent-owned token record and
asserts that a fresh store operation deletes the stale record through the
agent-owned compatibility path, then rewrites it as a user-owned DPU secret with
only the configured `gitAgent` read grant. Existing deployments should seed the
matching DPU `agentPolicies` grant before relying on this upgrade path.

## Useful Commands

Run only the default non-external suite:

```bash
npm run test:quick
```

Run against production:

```bash
SMOKE_BASE_URL=https://skills.axiologic.dev npm test
```

Run long relay and media checks:

```bash
SMOKE_OPEN_INTERPRETER=1 SMOKE_WEBMEET_MEDIA=1 npm test
```

Allow known browser noise temporarily while triaging:

```bash
SMOKE_ALLOW_BROWSER_ERRORS=1 npm test
```

## Maintenance Rules

- Prefer stable IDs and data attributes already present in the UI.
- Add a helper under `lib/` before duplicating a flow across specs.
- Keep secret values out of screenshots, traces, console logs, and test annotations.
  Trace attachment must preserve JSON/NDJSON parseability and pass the dynamic
  credential-residue post-scan; environment-secret replacement alone is not
  sufficient.
- External provider checks must stay opt-in unless the repository owns all required credentials and runtime configuration.
- Tests that create rooms, uploads, users, branches, or files must use `SMOKE_RUN_ID` in names and clean up when the UI exposes cleanup.
