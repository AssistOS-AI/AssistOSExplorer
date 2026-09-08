---
title: Ploinky Runtime Invariants
summary: Captures the Ploinky routing, authentication, guest, secure-wire, sandbox, and documentation invariants that must remain in local context when changing this agent.
---

# DS003 - Ploinky Runtime Invariants

## Introduction

This specification makes the Ploinky runtime and security invariants local to `liveKitServerAgent`. Future work from inside this agent directory must not rely on external memory of Ploinky core behavior; the local specs must carry the same high-level constraints that Ploinky defines in its routing and security model.

The authoritative upstream contracts are Ploinky `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/specs/DS011-security-model.md`. This file restates only the invariants that affect this agent's implementation and documentation.

## Core Content

`liveKitServerAgent` must treat the Ploinky routers as the trust boundary. Public
LiveKit WebSocket signaling enters through the public Router listener; Twirp
administration enters only through the private Router listener. Direct agent
ports are implementation details even when they bind to loopback.

Executable MCP operations must be authorized by router-minted invocation JWTs. The
agent runtime must never receive or require `PLOINKY_MASTER_KEY` or the removed
`PLOINKY_DERIVED_MASTER_KEY`. Code must not invent alternate bearer-token,
client-secret, or caller-header authorization paths around the router's
secure-wire model.

Ploinky resolves declared generated secrets before agent code runs. The LiveKit
runtime receives only the resolved API key and API secret that it needs to
operate; it never receives a master derivation key. External TURN infrastructure
is operator-configured. Its long-term credential stays in Ploinky core, which
brokers short-lived credentials to exact current-instance/current-enable-
generation consumers. The LiveKit image contains no Coturn, local relay range,
public TLS terminator, Certbot state, or standalone publication controller.

Router locator, descriptor, and topology environment are injected only after
Router authority attestation. A host lifecycle hook must not consume or spoof
those values. `liveKitServerAgent` therefore generates topology-dependent
configuration inside its already-attested container before starting any
service. It uses the standard `/run/ploinky-edge-topology/current.json` mount
when no locator environment is present and fails closed if that runtime input
is absent or invalid. If the valid topology omits media, the manifest-declared
optional `PLOINKY_MEDIA_PUBLIC_IP` may select the reachable host or LAN address
for bounded local deployment; absent that, the manifest-resolved
`PLOINKY_HOST_REACHABLE_IPV4`, normally supplied by deployment-time detection,
is preferred over container-interface discovery. Operator configuration may
replace that detected hint through normal optional manifest env resolution.
Both variables are ignored when topology media exists and cannot relax
authoritative global-unicast, port, or address-mode checks.

The compact `x-ploinky-auth-info` header is not a secure grant by itself.
Caller-supplied identity, forwarding, assertion, and invocation headers must be
discarded at the Router trust boundary. Public LiveKit signaling follows the
explicit convention-route policy; private Twirp requires effective authenticated
policy admission and the exact current-generation assertion in addition to
LiveKit's own API authorization.

Agent code must enforce its own domain authorization. Ploinky route authentication identifies the caller and signs the invocation, but it does not grant every domain operation. Sensitive actions must check the verified user, roles, scopes, target resource, workspace path, and agent-local policy before reading or mutating state.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must be resolved relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must not assume host-specific absolute paths, follow symlink escapes, or place secrets in static roots, plugin assets, HTML documentation, logs, transcripts, screenshots, or test fixtures.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, API keys, raw prompts, hidden policy text, or internal payloads. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Agent-local contract:

- Manifest: `AchillesIDE/liveKitServerAgent/manifest.json`
- Role: Single Ploinky agent that supervises the WebMeet media runtime.
- Authentication: The agent runs as a dependency of `webmeetAgent` / `webmeetLivekitAiAgent` and must not expose application guest or admin policy by itself.
- Router routes: `/base-agent-additional-server/liveKitServerAgent/7880/*` admits public LiveKit signaling, while the more-specific `/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.RoomService/*` requires authentication. Neither route creates a physical-host publication. Private Twirp also requires an exact current-instance/current-enable-generation caller assertion.
- Media sockets: LiveKit HTTP is process-local on `127.0.0.1:7880`; its only media socket is UDP `7882` with `use_external_ip: false`, TCP fallback disabled, and no UDP range. Authoritative topology supplies a literal globally routable unicast public IPv4. Only when valid topology omits media may local deployment use the manifest-declared reachable host or LAN IPv4, or a discovered non-loopback container address. One exact generation-capability runtime may own the box UDP socket, and local mode is not cross-network release evidence.
- Egress sockets: the Egress template listener is `127.0.0.1:7980` and semantic health is `127.0.0.1:7981`; both are private and neither is an outer publication.
- Persistent state: Generated LiveKit, Egress, and Redis config plus the in-container supervisor are runtime resources controlled by the manifest. Durable recordings belong under `.data/liveKitServerAgent/recordings`, durable Redis state under `.data/liveKitServerAgent/redis`, and generated config under the workspace-confined `.data/liveKitServerAgent/generated/` mount. The generated mount may be empty during host staging and is populated only by already-attested container startup. No local relay or TLS state exists.
- Documentation: `docs/index.html`
- Validation: syntax/config checks precede a fresh runtime-v5 stack. Release verification requires two-account browser signaling through Router, native Linux direct UDP on amd64 and arm64, and external TURN/UDP and TURN/TLS fallback lanes.
- Supervisor scope: `scripts/start-livekit-server-agent.sh` may only manage processes installed inside this image. It must not invoke `ploinky` or otherwise try to start sibling agents, because Ploinky resolves `enable` edges before the container is created.

### Decisions & Questions

#### Question #1: Why duplicate Ploinky invariants inside every agent spec set?

Response:
Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants in the local specification set prevents agents from accidentally treating router auth, guest mode, direct ports, or invocation headers as agent-specific implementation details that can be bypassed.

#### Question #2: Why is route authentication not enough for domain authorization?

Response:
Ploinky establishes who the caller is and signs the invocation path, but domain ownership remains inside the agent. The agent knows which files, records, rooms, leads, secrets, repositories, media objects, or infrastructure controls are safe for that caller. Each agent must therefore enforce its own resource policy after reading verified auth context.

#### Question #3: Why is TURN no longer supervised by this agent?

Response:
The v5 edge contract makes relay infrastructure an external operator-owned
service. Keeping Coturn or relay ranges inside the LiveKit image would create an
undeclared publication surface and duplicate long-lived credentials in a
consumer. Ploinky instead retains the external TURN secret and mints bounded
credentials only for exact authorized runtime generations.

## Conclusion

`liveKitServerAgent` remains compatible with Ploinky only while it preserves
router-mediated signaling and Twirp, exact-generation private admission,
single-port UDP media, external TURN, explicit convention-route policy,
workspace-confined storage, and redacted logging. Any source change that affects
these contracts must update this specification, the local docs, and the local
guide files in the same change set.
