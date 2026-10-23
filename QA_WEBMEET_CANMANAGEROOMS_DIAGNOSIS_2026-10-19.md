# QA WebMeet `canManageRooms=false` diagnosis (2026-10-19)

Read-only static trace. Revisions: ploinky `181d5836` (via `git show`), webmeet `0e2be67`, Explorer `4b5e38ac`. Nothing was run on QA.

## 1. Request path (Observed)

The browser calls the Router directly, without Explorer delegation. `dashboard-data-methods.js:86` calls `runWebMeetTool`, which calls `webSkel.appServices.getClient('webmeetAgent').callTool(...)`. `appServices` is `assistosSDK` (`explorer/main.js:276`). `assistosSDK.js:519-521`:

```js
if (!this.clients.has(agentId)) {
    const baseUrl = `/${encodeURIComponent(agentId)}/mcp`;
    this.clients.set(agentId, createAgentClient(baseUrl));
```

The result is a cookie `POST /webmeetAgent/mcp` `tools/call`. `MCPBrowserClient.js` sends no `Authorization` header (grep finds only `credentials: 'include'` and a CSRF header). Without that header the call cannot take the delegated branch (`mcp-proxy/index.js:856-858`):

```js
} = {}) {
    const method = (req.method || 'GET').toUpperCase();
    const isDelegatedAgentRequest = Boolean(readAuthorizationBearer(req));
```

The webmeet manifest declares `"guest": true` and `"enableModes": ["global"]`, so isolated mode is not an option. For a guest route, `authContext.js:1084-1090` admits the `ploinky_sso` cookie through `admitSsoRequest` → `authService.validateSession` and sets `req.user = ssoSession.user`. `/auth/token` (`authRoutes.js:123-145`) calls the same `validateSession` and returns `user: session.user`. `authRoutes.js:608-609` says:

```js
// Fresh SSO admission already performs provider refresh. Identity,
// token metadata and proofs must all use that one accepted snapshot.
```

`actor.roles` therefore comes from the same refreshed session snapshot that `/auth/token` returns. Unknown: I did not open `validateSession`'s refresh internals.

## 2. Grant construction (Observed)

`mcp-proxy/index.js:446-457` runs for each request from `buildRequestHeadersForToolCall` (`:717-724`):

```js
} else {
    const targetAgentId = resolveProviderPrincipal({ providerAgentRef: agentName, snapshot });
    const user = extractDelegatedUser(req);
    sub = user?.id ? `user:${user.id}` : '';
    actor = {
        kind: actorKindForRequestUser(req.user),
        id: sub,
        roles: user?.roles || [],
```

`RouterRequestTokenService._payload` adds `usr` and `delegation` only when they are supplied, and this branch supplies neither. AgentServer sets `context.invocation = invocationResult.payload` (`AgentServer.mjs:1063-1074`) and writes `{tool, input, metadata: context}` to the tool's stdin (`:1351`, `:639`). webmeet has no `toolWorkers`. `invocation-auth.mjs:40,53` derives identity from the user actor:

```js
const principalId = /^user:/i.test(raw) ? raw : `user:${raw}`;
...
if (actorKind === 'user' && actorId) {
    return normalizeUserPrincipal(actorId);
```

It sets `subject` from `grant.sub` and sets `delegation` to `null` when it is absent. webmeet's predicate (`accessPolicy.mjs:46-48`):

```js
if (!/^user:.+/.test(actorId) || !actorId.slice(5).trim()) return null;
if (invocation.subject !== actorId || authInfo.principalId !== actorId) return null;
if (invocation.delegation !== null) return null;
```

Inference: USER.8 yields `actor.id = subject = principalId = "user:USER.8"`, `delegation = null` and `roles = ["admin"]`, so every check passes. The id format is `user:USER.8`. Neither global mode nor this call path adds a delegation.

## 3. Verdict

| Cause | Status |
|---|---|
| (a) Ploinky regression | **Ruled out by code (Observed).** The commit range `7d8c04d0..181d5836` on those paths contains only `dc446468` (`authPages.js`, `static/index.js`, tests) and `181d5836` (`static/index.js`, 5 deletions). `invocation-auth.mjs` was last changed in `d4bbdb95`, which is an ancestor of `7d8c04d0`. |
| (b) webmeet mismatch | **Not supported (Inferred).** The Router's direct-user shape matches the predicate. webmeet's `verified-grant-fixture.mjs` `directUserAuth` mints the same shape but skips the AgentServer stdin hop. |
| (c) Environment, deployed revision, or session | **Most likely, but unproven (Unknown).** |

The dashboard defaults `canManageRooms: false` (`webmeet-dashboard.js:122`) and `loadInitialDashboardData` catches errors, so all three rows below render the same UI:

| Row | `webmeet_room_list` result | Meaning |
|---|---|---|
| R1 | error, 4xx/503, or `Access denied…` | The call failed. The flag was never set. |
| R2 | `{rooms:[],canManageRooms:false}`, `sub` = `agent:…` | A delegated actor. Code at these revisions rules this out for browser calls, so it fits only if QA runs different Explorer, plugin or Ploinky code. |
| R3 | same, `sub` = `user:USER.8` | The signed roles lacked `admin`, or the deployed webmeet or `/Agent` code differs. |

## 4. Decisive checks (proposed)

| # | Check | Settles |
|---|---|---|
| 1 | **Read-only.** In the QA tab signed in as USER.8, run `await fetch('/auth/token').then(r=>r.json())` and then `await webSkel.appServices.callTool('webmeetAgent','webmeet_room_list')` (`assistosSDK.js:526`, returns `{json}`). One tab removes any stale-storage-state doubt. | R1 vs R2/R3 |
| 2 | **Read-only.** On the host, get the webmeet checkout's `git rev-parse HEAD`. In the container, run `grep -n actor /Agent/lib/invocation-auth.mjs` and `grep -n isVerifiedAdminAuthInfo /code/tools/webmeet_tool.mjs`. | Whether the deployed code matches |
| 3 | The smoke trace (`redacted-trace.mjs` redacts headers, JWTs and form values) may hold the response body. Whether it keeps response bodies is unverified. | R1 vs R2/R3 |
| 4 | **Not read-only.** No existing log shows the actor. `[AgentServer/MCP] … context:` prints only with `PLOINKY_AGENT_TOOL_DEBUG_LOGS=1` (`AgentServer.mjs:1346`), which needs a restart, and `sanitizeInvocationForLog` (`:1010-1022`) keeps `sub` but drops `actor` and `delegation`. | R2 vs R3 by `sub` |

If check 1 shows admin in `/auth/token` but `canManageRooms:false`, and check 2 shows matching code, then this static model is wrong at an unverified hop: the `validateSession` refresh or the AgentServer verify path. Escalate.

## Minimal fix by row (proposed)

| Row | Fix |
|---|---|
| R1 | Fix the specific error, for example agent readiness or a missing invocation-auth module. No code change. |
| R2 (only if check 2 shows different code) | Deploy the intended revisions. If delegation is intended, accepting verified delegated `usr.roles` in `accessPolicy.mjs` is a policy decision. |
| R3 | Sign in with a fresh session, fix the role source in `validateSession`, or redeploy the intended webmeet revision. |

Separate hardening: log `actor.kind`, `actor.id`, `actor.roles` and `delegation` in `sanitizeInvocationForLog`.
