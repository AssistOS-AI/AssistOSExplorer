# Headless Browser Regression Cases

This runbook defines the complex browser regression surface for Explorer and its coupled agents. Use it when changing GitHub auth, DPU Confidential files, OnlyOffice document editing, Git sync, account/session behavior, WebMeet rooms, LiveKit media, chat, or screen sharing.

## Baseline Workspace

Run the suite against a fresh workspace unless the change being tested requires a specific fixture:

```bash
mkdir -p ~/work/testExplorerFresh
cd ~/work/testExplorerFresh
ploinky destroy || true
find "$PWD" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
ploinky start explorer
ploinky status
```

Use the router URL reported by Ploinky, normally:

```text
http://127.0.0.1:8080
```

The default local profile provides `admin` / `admin` and `user` / `user`. Tests that create additional users must use generated names such as `e2e-owner-<run-id>` and `e2e-member-<run-id>`, then delete or disable those users during cleanup when the UI exposes that action.

Keep browser traces, videos, screenshots, OAuth storage state, and generated test files outside tracked source. Prefer `.ploinky/test-artifacts/headless-regression/<run-id>/` inside the disposable workspace.

## Browser Harness

The maintainable Playwright suite lives in `tests/smoke/`. Use it for the automated baseline before or after any manual exploration:

```bash
cd tests/smoke
npm ci
npm run install:browsers
SMOKE_BASE_URL=http://127.0.0.1:8080 npm test
```

The suite records traces, videos, screenshots, browser console events, failed requests, and upload/session evidence outside tracked source. See `tests/smoke/README.md` for flags such as `SMOKE_OPEN_INTERPRETER=1`, `SMOKE_WEBMEET_MEDIA=1`, `SMOKE_ONLYOFFICE=1`, and `SMOKE_GITHUB=1`.

### Explorer UI Performance Comparison

Use the repository-owned `tests/smoke` UI benchmark when comparing Explorer
deployments. It runs a fixed, read-only ten-operation scenario in three fresh
Chromium contexts with browser caching disabled:

```bash
cd tests/smoke
UI_BENCHMARK_LABEL=<deployment-label> \
UI_BENCHMARK_BASE_URL=http://127.0.0.1:8080 \
UI_BENCHMARK_PLOINKY_SHA=<deployed-ploinky-sha> \
UI_BENCHMARK_EXPLORER_SHA=<deployed-explorer-sha> \
npm run benchmark:ui
```

Run each side only after the full graph reaches the same admitted state, using
the same host and a clean equivalent workspace. Compare the resulting JSON
files with:

```bash
npm run benchmark:ui:compare -- \
  <baseline-result.json> \
  <candidate-result.json> \
  --output <comparison.json>
```

The scenario fingerprint prevents comparisons when the paths, viewport, cache
policy, or operation sequence differ. Results include visible latency,
network-settled latency, sanitized request waterfalls, Router/Explorer/DPU/Git
route timing, browser long tasks, render/JavaScript CPU counters, and initial
page metrics. They exclude bodies, headers, cookies, credentials, URL queries,
console text, screenshots, and traces. Every step distinguishes a completed
quiet network tail from the fixed 1,500 ms cutoff, and long-task metrics carry
observer support/availability state. Comparisons fail closed when the full
scenario descriptor or recorded browser, headless/cache, viewport, platform,
architecture, OS, Node, target, or iteration controls differ. See
`tests/smoke/README.md` for the complete controls and artifact location.

### Master-Relative Deployment Resource Comparison

The resource benchmark is separate from the browser timing benchmark. Run its
fixed harness on the Linux deployment host first against a reproduced
direct-host `master` graph and then against `ploinky-proxy` on the same host:

```bash
cd tests/smoke
RESOURCE_BENCHMARK_LABEL=master \
RESOURCE_BENCHMARK_VARIANT=master \
RESOURCE_BENCHMARK_DEPLOYMENT_ID=<master-deployment-id> \
RESOURCE_BENCHMARK_PLOINKY_SHA=<exact-master-sha> \
RESOURCE_BENCHMARK_EXPLORER_SHA=<exact-master-explorer-sha> \
npm run benchmark:resources
```

Repeat with `RESOURCE_BENCHMARK_LABEL` and
`RESOURCE_BENCHMARK_VARIANT` equal to `ploinky-proxy`, then compare the two
`result.json` files with `npm run benchmark:resources:compare`. The harness
requires the same host fingerprint, five-minute warmup, 30-minute
idle-steady sampling window, ten-second interval, and exact stable 16-target
graph. It reports master-relative CPU, memory, swap, load, process, zombie, and
growth-rate deltas. See `tests/smoke/README.md` for the complete protocol.

### Fixed Router/Auth Release Baseline

The Ploinky release harness runs this exact Chromium baseline after the full
graph and topology-aware listener gate succeed. It keeps the graph alive until
the command finishes and runs the command before cleanup or graph destruction,
without retrying, skipping, or weakening the oracle:

```bash
cd tests/smoke
SMOKE_BASE_URL=http://127.0.0.1:18080 npm test -- --project=chromium specs/00-router-auth.spec.mjs
```

The listener gate requires `required-loopback`, requires exactly one listener
for each eligible `required-assigned-managed-gateway`, and requires no listener
for an `inactive-unassigned-managed-gateway`. An inactive gateway remains
fail-closed and is not evidence of managed-bridge activation. Missing or stale
assignment evidence, cross-interface assignment, missing or extra listeners,
wildcard listeners, and unrelated binds fail the gate.

The baseline proves the active Router root landing, Explorer shell, and routed WebChat shell
through Router. It is distinct from the WebMeet two-account ScreenShare gate
and the external-network direct UDP, relay UDP, and relay TLS matrix; none of
those gates substitutes for another.

Use Playwright Chromium or the Codex browser automation surface with an isolated browser context per Explorer account. For media tests, launch Chromium with fake media devices:

```js
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-http-screen-capture',
    '--auto-select-desktop-capture-source=Entire screen'
  ]
});
```

Grant camera and microphone permissions for the router origin in each context. Record console errors, failed network requests, screenshots, and traces for every failed step.

Screen sharing is browser-environment sensitive. If headless Chromium rejects `navigator.mediaDevices.getDisplayMedia` before the application code runs, rerun that WebMeet case in headed Chromium or under a virtual display. Treat it as an environment skip only when room creation, two-user join, camera, and chat pass and the failure is clearly a browser capture limitation rather than an application error.

## Shared Login And Account Steps

1. Select the intended routed surface: `/` for the Router landing case, the admitted Explorer route `/explorer/index.html`, or the case's WebChat/service route. Do not open Explorer as a temporary authentication page before another surface.
2. Check the Router session first. If authentication is needed, open `/auth/login` with the intended surface as `returnTo` and submit the configured username and password only on that Router page.
3. Assert the Router landing or Explorer shell loads without direct-agent URLs.
4. For account-creation coverage, log in as `admin`, open the Explorer account/admin menu, create `e2e-owner-<run-id>` and `e2e-member-<run-id>`, then verify both accounts can log in through separate browser contexts.
5. If the account creation UI is unavailable in the active profile, record that as a product gap for this regression. Do not silently replace it with a direct database or container mutation.

## Case 1: GitHub OAuth For Git Agent

Purpose: verify that GitHub authentication works through the Git plugin and that OAuth credentials remain secret-owned.

Preconditions:

- `gitAgent` is running as part of `ploinky start explorer`.
- The test is allowed to use a GitHub test account.
- For fully automated completion, provide a Playwright storage state for the GitHub test account outside the repository. Without that, this case may be run as a human-assisted device-flow test.

Steps:

1. Log in to Explorer as `e2e-owner-<run-id>` or `admin`.
2. Open the Explorer UI and press the Git toolbar button.
3. Open the GitHub authentication action in the Git modal.
4. Start the GitHub OAuth/device flow.
5. Assert the UI displays a GitHub verification URI and a device code.
6. Complete the device flow in a separate context using the pre-authenticated GitHub storage state, or have a tester enter the device code manually.
7. Poll from the Git modal until it reports a connected GitHub identity.
8. Refresh the Git modal and assert the connected state persists for the same Explorer user.
9. Inspect browser storage, console output, and captured network payloads for this run. The GitHub access token must not appear in localStorage, sessionStorage, URLs, visible UI text, screenshots, or non-debug logs.
10. Disconnect the GitHub test account for this Explorer user if the UI exposes that action.

Pass criteria:

- GitHub auth starts and completes through the routed Git plugin UI.
- The connected identity survives a page refresh.
- The access token stays in the DPU-backed secret store or equivalent secret boundary, not in browser-visible state.

Skip criteria:

- GitHub blocks automation with CAPTCHA, 2FA, or device-flow risk controls. Record the device-flow start, the blocking reason, and whether a human-assisted run completed.

## Case 2: Confidential `.doc` Creation Through DPU And OnlyOffice

Purpose: verify that creating and editing an Office document in `/Confidential` exercises both the DPU Confidential store and the OnlyOffice editor path.

Steps:

1. Log in as `e2e-owner-<run-id>` or `admin`.
2. Open Explorer and navigate to `/Confidential/My Space`.
3. Use the New action to create `e2e-confidential-<run-id>.doc`.
4. Assert the new file appears under `/Confidential/My Space` without a normal host filesystem path being exposed in the UI.
5. Select the `.doc` file.
6. Assert the preview/editor pane requests OnlyOffice through the Ploinky router and loads the OnlyOffice API script successfully.
7. Fail immediately on any visible or console error containing:
   - `OnlyOffice active editor locator is unavailable`
   - `Failed to load OnlyOffice API script`
   - `OnlyOffice editor mount failed`
   - HTTP 401/403/404/5xx for the OnlyOffice API script, document download route, or callback route
8. Wait for the OnlyOffice editor frame or ready state.
9. Type a unique marker such as `confidential-doc-e2e-<run-id>` into the document.
10. Wait for OnlyOffice to report saved state or for the callback route to complete successfully.
11. Reload Explorer, reopen the file, and assert the marker persists.
12. Log in as `e2e-member-<run-id>` in a separate browser context and verify the Confidential object is not visible unless it was explicitly shared.

Pass criteria:

- `.doc` creation produces a document that OnlyOffice can open, not an empty or invalid legacy document.
- OnlyOffice uses profile defaults from `ploinky start explorer`; no manual `ploinky var` setup is required for local default/dev profiles.
- DPU ACL behavior is preserved across browser contexts.

## Case 3: `.ploinky` Repository Document Change And Git Sync

Purpose: verify that Explorer can edit a documentation file in a repo under `.ploinky/repos`, the Git plugin detects the change, and Sync pushes through the authenticated Git path.

Preconditions:

- GitHub OAuth from Case 1 is connected for the test user.
- The target repo is disposable or uses a disposable test branch.
- To validate Ploinky core specifically, ensure `.ploinky/repos/ploinky` exists in the fresh workspace. If the Ploinky repo is not enabled, fail this Ploinky-specific case as missing setup instead of substituting a different repo silently.

Steps:

1. Log in as the GitHub-connected test user.
2. Open Explorer at `/.ploinky/repos/ploinky/docs/` and select a small Markdown or HTML documentation file.
3. Create or switch to a branch named `e2e/headless-<run-id>` from the Git UI.
4. Make a minimal reversible edit, for example add `<!-- e2e sync <run-id> -->` to the selected document.
5. Save the file from Explorer.
6. Open the Git modal and select the `ploinky` repo.
7. Assert the changed file appears in the repo tree and the diff contains the unique marker.
8. Run Sync from the Git modal.
9. Assert Sync completes without credential prompts, rejected pushes, stale-body-hash errors, or raw MCP errors.
10. Verify the remote branch contains the marker with `git ls-remote` plus a fetch or through the GitHub UI/API for the test repository.
11. Clean up by reverting the marker or deleting the disposable branch.

Pass criteria:

- Explorer edits a file below `.ploinky/repos/ploinky`.
- Git diff detection and Sync operate on the intended repo.
- Sync uses the GitHub-authenticated path and does not expose credentials in the browser.

## Case 4: WebMeet Two-Account Room, Camera, Screen Share, And Chat

Purpose: verify that WebMeet works end to end with two Explorer accounts, routed WebMeet HTTP services, LiveKit media, and chat.

Preconditions:

- `webmeetAgent` and `liveKitServerAgent` services are running from `ploinky start explorer`.
- Two Explorer accounts exist from the shared account steps.
- Browser contexts are launched with fake camera and microphone devices.

Instrumentation:

Install a small init script before each page loads so the test can inspect WebRTC state without changing application code:

```js
await context.addInitScript(() => {
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  window.__e2ePeerConnections = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new NativeRTCPeerConnection(...args);
    window.__e2ePeerConnections.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
});
```

Steps:

1. Create two browser contexts: context A for `e2e-owner-<run-id>` and context B for `e2e-member-<run-id>`.
2. Log both users in through the admitted Explorer route `/explorer/index.html`.
3. In context A, open Explorer and press the WebMeet toolbar button.
4. Before joining, open the Settings button from the WebMeet dashboard modal header and verify the panel exposes separate `Audio & video` and `Background & privacy` sections.
5. In context A, select `Blur background`, apply settings, then reopen Settings and verify the choice persisted before room join.
6. Create a room named `e2e-room-<run-id>`.
7. Join the room as user A.
8. In context B, open the same WebMeet surface and join `e2e-room-<run-id>`.
9. Assert both pages show the same room name and at least two participants.
10. Enable microphone and camera for both users.
11. Assert each page has an active local video element and at least one remote video element with `readyState >= 2`, `videoWidth > 0`, and `videoHeight > 0`.
12. Collect WebRTC stats from `window.__e2ePeerConnections` in both pages and assert outbound and inbound RTP packet counters increase over two consecutive samples.
13. Send chat message `chat-from-owner-<run-id>` from context A and assert it appears in context B.
14. Send chat message `chat-from-member-<run-id>` from context B and assert it appears in context A.
15. As an admin, attach the LiveKit assistant agent (`assistant_on_mention` / `on_mention`) and assert the response includes a real LiveKit participant with `kind=AGENT` and WebMeet attributes for meeting id, agent type, and mode.
16. Send an `@WebMeetAgent` chat mention and record whether the worker responds; a missing response is a provider/configuration failure, not proof of successful dispatch.
17. As an admin, attach the LiveKit scribe agent (`scribe` / `post_event`) while at least one microphone is publishing a speech-like test audio file.
18. Poll `webmeet_transcript_list` until at least one scribe-sourced transcript segment is persisted for the meeting.
19. Start screen sharing from context A.
20. Assert context A shows a local screen-share state and context B receives a new remote screen-share track or a second remote video stream with increasing inbound video frames.
21. Stop screen sharing, leave the room from both contexts, and delete the test room if the UI exposes room deletion.

Pass criteria:

- Room creation and join happen through the WebMeet UI, not direct service ports.
- User-scoped settings are reachable from the dashboard header before join, and background privacy choices persist across panel reopen.
- Two different authenticated Explorer accounts can join the same room.
- Camera media flows both directions.
- Chat delivery is visible in both contexts.
- Assistant and scribe attachments create real LiveKit `AGENT` participants, not store-only simulated presence.
- The scribe attachment produces persisted transcript segments from microphone audio.
- Screen sharing either succeeds and produces a remote track, or is explicitly skipped because the browser capture environment does not support headless display capture.

## Case 5: WebChat And WebMeet Provider-Looking Tags

Purpose: verify that WebChat and WebMeet keep workspace/file `@` references usable while treating provider-looking tokens such as `@open-interpreter` as ordinary chat text. Provider dispatch belongs to Copilot semantic routing, not inline chat tags.

Preconditions:

- `AchillesCLI/roboTeamAgent` and `webmeetAgent` are enabled in the workspace.
- Create uploads, rooms, and chat text with `SMOKE_RUN_ID` names so repeated smoke runs do not collide.
- Run Copilot semantic routing checks separately with `SMOKE_OPEN_INTERPRETER=1` when the external provider runtime is configured.

Copilot WebChat steps:

1. Create a unique empty project directory with a run-scoped name through Explorer's authenticated filesystem tools. Open the routed WebChat URL for RoboTeam’s default robot with that exact workspace-relative directory:

   ```text
   /webchat?agent=roboTeamAgent&robot=default&forward-envelope=1&workspace-dir=<run-scoped-project>
   ```

2. Upload a file and a nested folder through the browser UI.
3. Assert each response's exact relative path, selected-project workspace path, and encoded download URL. Type the uploaded path prefix with `@` and assert the suggestion menu includes a `Files and folders` group.
4. Open a sibling browser context at the same project directory and assert the first context's upload is suggested there. Direct-workspace uploads belong to the selected project, not a hidden session directory.
5. Type `@op` and assert the menu does not expose an `Agents` group or `@open-interpreter` suggestion.
6. Leave the composer text unchanged as `@op`; selecting a provider tag must not be possible from the normal WebChat autocomplete.
7. Clean up the exact project directory through Explorer's filesystem tools. Do not raise upload quotas or broaden reserved-path exclusions to accommodate unrelated source checkouts at the workspace root.

WebMeet chat steps:

1. Open the WebMeet dashboard route through Explorer authentication.
2. Create and join `e2e-room-<run-id>`.
3. Type `@op` into `#webmeetChatInput`.
4. Assert the menu does not expose an `Agents` group or `@open-interpreter` suggestion.
5. Send `@open-interpreter ordinary-chat-<run-id>` through the UI.
6. Assert the chat list contains the sent text and does not render `@open-interpreter` as a highlighted provider mention.

Pass criteria:

- WebChat exposes selected-project `Files and folders` suggestions for uploaded paths, including sibling sessions at the same directory.
- WebChat and WebMeet do not expose an `Agents` group or provider suggestion for `@open-interpreter`.
- WebMeet persists provider-looking text as ordinary meeting chat.
- `SMOKE_OPEN_INTERPRETER=1` opt-in Copilot checks cover semantic provider dispatch when external runtime is configured.
- Browser logs, screenshots, network payloads, and artifacts do not contain Soul Gateway keys, DockerHub tokens, local auth passwords, invocation JWTs, prompt bodies beyond the explicit test messages, or other provider credentials.

## Reporting

Every run should record:

- Workspace path and router URL.
- Git commit SHAs for `AssistOSExplorer`, `ploinky`, and any enabled agent repos under `.ploinky/repos`.
- Browser, OS, and headless/headed mode.
- Test account names, excluding passwords.
- Which cases ran, passed, failed, or were skipped.
- Screenshots and traces for failures.
- Relevant Ploinky status and recent service logs with secrets redacted.

Failures that require manual `ploinky var` setup for default/dev profiles are regressions unless the value is a real external credential such as a GitHub account credential. Workspace-owned URLs, ports, LiveKit, TURN, OnlyOffice, DPU, recording, webhook, and generated encryption secrets must be supplied by profile defaults or derived secret entries.
