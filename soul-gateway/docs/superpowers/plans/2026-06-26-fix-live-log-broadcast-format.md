# Fix Live-Log Broadcast Wire Format Implementation Plan (rev. 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note:** rev. 2 incorporates an adversarial review. The review confirmed the core fix (root cause real; `decodeFrame` valid on unmasked server frames; `event: message` reaches `onmessage`; no row-shape blocker — `audit-log-writer` publishes DAO rows and `/management/logs` returns DAO rows, both normalized by `normalizeAuditLog`). All 5 findings were verified against the code and addressed — see "Findings addressed".

**Goal:** Make `BroadcastHub.publish()` emit live-log messages in the envelope the dashboard client actually consumes, so the management Logs page updates in real time instead of only on manual refresh.

**Architecture:** Single server-side fix. The dashboard client (`app.mjs`) consumes stream messages only via `_handleLogMessage`, which requires a `{type:'log', data:<row>}` JSON envelope delivered on the default channel (`ws.onmessage` / `sse.onmessage`). Today `publish()` sends a **bare row** over WS (no `type`) and uses a **named `event: log`** over SSE (which `EventSource.onmessage` never receives) — so the client silently drops every live log. The fix wraps both payloads as `{type:'log', data}` and sends SSE on the default `message` event. No client code change; redaction and filtering are unchanged.

**Tech Stack:** Node.js ESM, `node:test` (incl. a `vm`-based dashboard VM harness). Files: `src/observability/broadcast-hub.mjs`, `src/test/unit/observability.test.mjs`, `src/test/unit/dashboard-logs-page.test.mjs`.

## Findings addressed (from review)

| # | Finding | Resolution |
| --- | --- | --- |
| 1 [major] | Live rows ignore active column filters / time range / sort (handler only gates on selected key + `unshift`, app.mjs:1341-1346) | **Documented** as a known pre-existing limitation + optional follow-up (Known Limitations §1). Out of scope for the wire-format fix. |
| 2 [major] | Soul-specific `/soul/:soulId` streams also re-wrapped | **Documented** (Known Limitations §2): no in-repo consumer (dashboard uses the non-soul streams); change keeps both stream types consistent. |
| 3 [minor] | E2E "row appears" gates on the selected key (app.mjs:1341) | **Refined** Task 2 Step 3: select the matching key first, or assert the live sidebar `request_count` bump (which is key-agnostic). |
| 4 [major] | No test drives the client `{type:'log',data}` → render path | **Added** a dashboard VM client-contract test (Task 1 Steps 7-8) driving `window.app()._handleLogMessage(...)` → `selectedLogs`. |
| 5 [nit] | Plan said "four" existing tests fail; `filters by model` only asserts `.length` so it won't | **Corrected** wording: **three** field-asserting tests fail; `filters by model` is unwrapped for consistency only. |

## Global Constraints

- ES modules with `import`/`export`; four-space indentation (soul-gateway conventions).
- **Server-side only.** Do NOT modify `src/dashboard/js/app.mjs` — the fix makes the server match the existing client contract (`_handleLogMessage` requires `msg.type === 'log'` and reads `msg.data`; both `onmessage` handlers route through it; there is no `addEventListener('log')`).
- Preserve existing **redaction** (`redactLogEntry`) and **filter** (`matchesFilters`) behavior exactly — only the envelope and the SSE event name change.
- Commits human-authored; no `Co-Authored-By` / AI attribution.
- This change only takes effect in the running deployment after the **soul-gateway agent is restarted** (Node loads `broadcast-hub.mjs` at process start) AND the already-deployed transport fixes (router WS-proxy, RFC GUID) are active.

---

## File Structure

| File | Change |
| --- | --- |
| `src/observability/broadcast-hub.mjs` | Rewrite `publish()` to send `{type:'log', data}` on the default channel |
| `src/test/unit/observability.test.mjs` | Add 2 server wire-format tests; unwrap `.data` in the existing BroadcastHub tests |
| `src/test/unit/dashboard-logs-page.test.mjs` | Add 1 client-contract test (server format → render) |

---

## Task 1: Fix the broadcast wire format + tests

**Files:**
- Modify: `src/observability/broadcast-hub.mjs:117-137` (`publish`)
- Modify/Test: `src/test/unit/observability.test.mjs` (BroadcastHub describe block)
- Test: `src/test/unit/dashboard-logs-page.test.mjs` (add one client-contract test)

**Interfaces:**
- Consumes: `redactLogEntry(row)→object`, `sendTextFrame(socket, string)`, `matchesFilters(...)`, `decodeFrame(buf)→{payload:Buffer}` (from `../../core/websocket-frame-codec.mjs`).
- Produces: `BroadcastHub.publish(logRow)` sends, to every matching subscriber, the JSON string `{"type":"log","data":<row>}` — over the SSE **default `message`** event and as a WS text frame.

- [ ] **Step 1: Add the failing server wire-format tests**

In `src/test/unit/observability.test.mjs`, add near the top imports:
```js
import { decodeFrame } from '../../core/websocket-frame-codec.mjs';
```
Add these two tests inside `describe('BroadcastHub', …)` (e.g. after `tracks subscriber count`):
```js
    it('publishes SSE logs on the default "message" event wrapped as {type:"log", data}', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const events = [];
        const mockStream = {
            onClose() {},
            send(event, data) { events.push({ event, msg: JSON.parse(data) }); },
            comment() {},
            close() {},
        };
        hub.addSseSubscriber(mockStream, {});

        hub.publish({ soul_id: 'u1', requested_model: 'gpt-4', status: 'succeeded' });

        assert.equal(events.length, 1);
        // EventSource.onmessage only fires for the default 'message' event.
        assert.equal(events[0].event, 'message');
        assert.equal(events[0].msg.type, 'log');
        assert.equal(events[0].msg.data.requested_model, 'gpt-4');
    });

    it('publishes WS logs as a {type:"log", data} text frame', () => {
        const hub = new BroadcastHub(createMockAppCtx());
        const written = [];
        const mockSocket = { on() {}, write(buf) { written.push(buf); return true; }, destroy() {} };
        hub.addWsSubscriber(mockSocket, {});

        hub.publish({ soul_id: 'u1', requested_model: 'gpt-4', status: 'succeeded' });

        const frame = decodeFrame(Buffer.concat(written));
        assert.ok(frame, 'a WS text frame should be written');
        const msg = JSON.parse(frame.payload.toString());
        assert.equal(msg.type, 'log');
        assert.equal(msg.data.requested_model, 'gpt-4');
    });
```

- [ ] **Step 2: Run the new tests — verify they FAIL**

```bash
node --test src/test/unit/observability.test.mjs
```
Expected: both new tests FAIL — SSE event is `'log'` (not `'message'`) and `msg.type` is `undefined`; WS frame parses to a bare row with `msg.type` undefined.

- [ ] **Step 3: Fix `publish()` in `broadcast-hub.mjs`**

Replace `publish(logRow)` (`src/observability/broadcast-hub.mjs:117-137`) with:
```js
    publish(logRow) {
        const redacted = redactLogEntry(logRow);
        const redactedMsg = JSON.stringify({ type: 'log', data: redacted });
        const fullMsg = JSON.stringify({ type: 'log', data: logRow });

        for (const [, client] of this.sseClients) {
            if (!matchesFilters(logRow, client.filters, client.soulSpecific))
                continue;
            const payload = client.soulSpecific ? fullMsg : redactedMsg;
            // Default 'message' event so the dashboard's EventSource.onmessage fires.
            client.stream.send('message', payload);
        }

        for (const [, client] of this.wsClients) {
            if (!matchesFilters(logRow, client.filters, client.soulSpecific))
                continue;
            const payload = client.soulSpecific ? fullMsg : redactedMsg;
            try {
                sendTextFrame(client.socket, payload);
            } catch {}
        }
    }
```

- [ ] **Step 4: Run the server tests — new PASS, three existing FAIL**

```bash
node --test src/test/unit/observability.test.mjs
```
Expected: the 2 new tests PASS. **Three** existing tests now FAIL because they read row fields directly off the envelope: `filters by soul_id` (`received[0].soul_id`), `redacts payloads in normal stream` (`received[0].request_payload`), `sends full payload on soul-specific stream` (`received[0].request_payload`). (`filters by model` asserts only `received.length`, so it still passes; `tracks subscriber count` uses a no-op `send`.)

- [ ] **Step 5: Unwrap the envelope in the existing BroadcastHub tests**

In `src/test/unit/observability.test.mjs`, in each test whose mock stream does `received.push(JSON.parse(data))` — `filters by soul_id`, `filters by model`, `redacts payloads in normal stream`, `sends full payload on soul-specific stream` — change that line to:
```js
                received.push(JSON.parse(data).data);
```
This unwraps `{type:'log', data}` so the existing field assertions keep working. (`filters by model` does not strictly need it but stays consistent.) Do NOT change the assertions.

- [ ] **Step 6: Run the observability suite — verify PASS**

```bash
node --test src/test/unit/observability.test.mjs
```
Expected: all BroadcastHub tests pass (2 new + 4 unwrapped + subscriber-count + the `redactLogEntry` block).

- [ ] **Step 7: Add the dashboard client-contract test (server format → render)**

In `src/test/unit/dashboard-logs-page.test.mjs`, add this test inside `describe('dashboard logs page', …)` (it reuses the existing `loadDashboard` helper; `window.app` and `window.logsPage` both resolve in the vm harness):
```js
    it('renders a {type:"log", data} stream message into the logs list', async () => {
        const { window } = await loadDashboard(async (path) => {
            const p = String(path);
            if (p.startsWith('/management/logs/keys?')) {
                return { status: 200, async json() {
                    return { data: [{ api_key_id: 'key-1', key_label: 'daniel', key_hint: 'sk-...', request_count: 4 }] };
                } };
            }
            if (p.startsWith('/management/logs?')) {
                return { status: 200, async json() {
                    return { data: [{ request_id: 'chatcmpl-test', api_key_id: 'key-1', requested_model: 'plan', status: 'succeeded', http_status: 200 }], total: 4, limit: 50, offset: 0 };
                } };
            }
            throw new Error(`unexpected dashboard fetch: ${p}`);
        });

        const page = window.logsPage();
        await page.init();                       // selectedKey.list_id === 'key-1'; registers the 'soul-log' listener
        assert.equal(page.selectedKey.list_id, 'key-1');
        const before = page.selectedLogs.length;

        // Drive the EXACT server wire format through the client's handler.
        const raw = JSON.stringify({
            type: 'log',
            data: { request_id: 'live-1', api_key_id: 'key-1', requested_model: 'fast', status: 'succeeded', http_status: 200 },
        });
        window.app()._handleLogMessage(raw);     // parses envelope → dispatches 'soul-log' → logsPage inserts

        assert.equal(page.selectedLogs.length, before + 1);
        assert.equal(page.selectedLogs[0].request_id, 'live-1');
    });
```

- [ ] **Step 8: Run the dashboard test — verify PASS**

```bash
node --test src/test/unit/dashboard-logs-page.test.mjs
```
Expected: PASS — the new client-contract test proves the dashboard renders a message in the new `{type:'log', data}` format (the existing test still passes).

- [ ] **Step 9: Run the whole unit suite — no regressions**

```bash
npm run test:unit
```
Expected: green — baseline this session was 1015 pass / 0 fail; this adds 3 tests → expect **1018 pass / 0 fail**.

- [ ] **Step 10: Commit**

```bash
git add src/observability/broadcast-hub.mjs src/test/unit/observability.test.mjs src/test/unit/dashboard-logs-page.test.mjs
git commit -m "Send live log stream messages as {type:'log', data} on the default channel"
```

---

## Task 2: End-to-end verification in the running deployment

Confirms the fix restores live updates (the transport fixes from earlier are already live). Requires restarting the soul-gateway agent so its Node process loads the new `broadcast-hub.mjs`.

**Files:** none (verification only).

- [ ] **Step 1: Restart the soul-gateway agent**

Restart the `proxies/soul-gateway` agent in the `~/work/testExplorerFresh` deployment (e.g. `ploinky restart soul-gateway` or the deployment's agent-restart path) so the new `broadcast-hub.mjs` loads. Do NOT SSH-deploy to production. Confirm it restarted after the commit: `podman inspect -f '{{.State.StartedAt}}' ploinky_proxies_soul-gateway_testExplorerFresh_<hash>`.

- [ ] **Step 2: Load a fresh dashboard + confirm the stream connects**

Open the management dashboard, hard-reload (Cmd+Shift+R), and in Web Inspector → Network confirm `…/management/ws/logs` returns **`101 Switching Protocols`** (or the SSE `…/logs/stream/sse` stays open at 200).

- [ ] **Step 3: Generate a log and confirm it streams live (key-aware)**

The live-insert handler updates the matching sidebar key's `request_count` regardless of selection, but only inserts a **row** when that key is the selected one (app.mjs:1341). So: in the Logs sidebar **select the key for the agent that will make the call** (the soul-gateway agent), then run:
```bash
KEY=$(podman exec ploinky_proxies_soul-gateway_testExplorerFresh_<hash> printenv PLOINKY_AGENT_API_KEY)
curl -s -X POST http://127.0.0.1:13613/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"reply with pong"}],"max_tokens":16}'
```
Expected (no manual refresh): the matching sidebar key's request count increments **and**, with that key selected, a new `fast / proxies/default-local-llm` row appears at the top of the Logs list within ~1s. That is the definition of done.

(Optional automated browser proof: drive a headless browser to the authenticated dashboard, select the key, fire the curl, assert the new row renders. The Task 1 tests already pin both the server wire format and the client render path; this is extra confidence.)

---

## Known limitations / optional follow-ups (from review)

1. **Live rows do not honor active column filters / time range / sort.** The `soul-log` handler (`app.mjs:1325-1346`) only gates on the selected key and always `unshift`-prepends; it does NOT re-apply `filters.agent_name` / `filters.session_id` / `keyword` / the time range / the sort order that the fetch path (`app.mjs:1446-1460`) uses. This is **pre-existing** client behavior, surfaced now that live streaming works. With no active filter (the common case) it is correct; with an active filter a non-matching live row can appear at the top. Out of scope for this wire-format fix. Follow-up option: make the handler apply the same predicate + ordering as the fetch path, or debounce-refetch on new logs.
2. **Soul-specific streams adopt the same envelope.** `publish()`'s `fullMsg` path also wraps logs for the soul-specific streams (`/management/logs/stream/soul/:soulId`, `/management/ws/logs/soul/:soulId`). The dashboard does **not** consume these (it uses the non-soul streams), and no in-repo consumer was found, so there is no in-repo breakage; the change keeps both stream types on the same `{type:'log', data}` contract. If an external consumer of the soul-specific streams exists, it must adopt the envelope.

## Self-Review

- **Spec coverage:** root cause fixed (Task 1 Step 3) and pinned by 2 server tests (Step 1) + 1 client-render test (Step 7); existing tests preserved (Step 5); each review finding maps to a row in "Findings addressed".
- **Placeholder scan:** all code is concrete (full `publish()`, full test bodies incl. the reused `loadDashboard` mock). The only environment-specific tokens are the container name/hash and restart command in Task 2, explicitly flagged.
- **Type consistency:** the envelope `{type:'log', data:<row>}` is identical across the WS frame, the SSE `message` payload, both new tests, and the client (`_handleLogMessage` `msg.type`/`msg.data`). Helper names (`decodeFrame`, `redactLogEntry`, `sendTextFrame`, `matchesFilters`, `window.app`, `window.logsPage`) match their definitions as verified.
