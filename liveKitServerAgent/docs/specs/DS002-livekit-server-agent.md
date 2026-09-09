---
title: liveKitServerAgent
summary: Supervises the pinned v5 Redis, LiveKit, Egress, and private health runtime with one fixed UDP mux.
---

# DS002 - liveKitServerAgent

## Introduction

`liveKitServerAgent` owns the fixed runtime-v5 LiveKit, Egress, Redis, and
private-health process boundary. It consumes immutable box topology. An
authoritative media stanza never permits discovery or substitution; a
topology without media explicitly selects the bounded local deployment mode.

## Core Content

### Image and process model

The manifest uses a pinned multi-architecture image digest for every profile.
One supervisor starts Redis, LiveKit Server, LiveKit Egress, and a compact
health process. It traps termination, shuts children down, and fails if a
required process or expected socket owner disappears.

The supervisor also restores the upstream Egress process contract that the
combined image cannot inherit automatically: it starts PulseAudio in the
foreground as the image's unprivileged `egress` user, runs Egress as that same
user, supervises both processes, and gives that user access only to an
ephemeral `0400` Egress configuration copy and the mounted recordings
directory. A live Egress listener without this audio runtime is not recording
readiness.

PulseAudio's runtime directory is the fixed tmpfs path
`/dev/shm/livekit-egress-xdgr`, and the native socket the readiness probe and
Egress connect to is `${EGRESS_XDG_RUNTIME_DIR}/pulse/native`. The directory
must be on a tmpfs: on the container's fuse-overlayfs root PulseAudio cannot
apply the ownership and mode it wants to that socket, which is left owned by
`root` with mode `0755`, so the unprivileged `egress` client is refused and the
readiness probe never succeeds even though the daemon reports a complete
startup. `/dev/shm` is the tmpfs available in this image and already holds
PulseAudio's shared-memory segments, so the socket and pid file add no
meaningful space pressure. The path is deliberately not configurable: startup
removes it recursively as root, so an operator-supplied value would become a
deletion path for whatever it named, including the durable `/data` mounts.
Because that tmpfs is world-writable, startup removes the directory itself
before recreating it, so a pre-created symlink cannot receive the `egress`
ownership change.

Detailed health is available only on the unmounted Unix socket
`/run/ploinky/livekit-supervisor.sock`. A loopback summary listener exists for
the managed readiness probe and exposes no administration surface.

### Generated configuration

After Ploinky completes Router authority attestation and injects the verified
runtime descriptor environment, the container startup generator reads the
mounted unversioned topology. When that topology declares media, it requires:

- a canonical literal globally routable unicast `media.publicIPv4`;
- media UDP port `7882`; and
- `direct` or `nat-forward` address mode.

It generates LiveKit with HTTP/signaling on `127.0.0.1:7880`,
`rtc.node_ip` equal to the validated globally routable unicast IPv4,
`use_external_ip: false`, one
UDP mux on `7882`, and TCP media disabled. Redis binds `127.0.0.1:6379`.
Egress template/service binds loopback `7980` and semantic health binds
loopback `7981`; readiness proves both roles independently by requiring the
exact supervisor-recorded PID to remain live and both kernel sockets to carry
the unprivileged `egress` UID, rejecting any non-loopback duplicate, validating
the health JSON `CpuLoad`, and validating the pinned LiveKit Egress HTML
template. The supervisor verifies the image's pinned Egress binary digest
before invoking that exact binary. This avoids relying on `/proc` PID views or
optional `ss` process metadata, both of which may be unavailable or remapped in
nested rootless runtimes, while retaining fail-closed process and socket
ownership checks.
The generated Egress configuration preserves the pinned source's existing
Chrome feature exclusions and additionally disables
`WebRtcHideLocalIpsWithMdns` for the trusted recorder process. That scoped
override lets the co-located Egress browser present its in-namespace host
candidate to LiveKit while external participants continue to use the exact
topology-provided public `7882/udp` candidate. It does not enable LiveKit's
global mDNS resolver, add a media port, or broaden Router authorization.
The upstream v1.9.1 binary binds health to wildcard, so the runtime accepts only
the separate commit-pinned rebuild whose narrow source patch changes that bind
to `127.0.0.1`. Startup fails closed with the upstream binary.

When the attested topology omits `media`, the generator enters local deployment
mode. The optional manifest-declared `PLOINKY_MEDIA_PUBLIC_IP` supplies a
literal usable host or LAN IPv4; when it is unset, the generator prefers the
manifest-resolved `PLOINKY_HOST_REACHABLE_IPV4`. Ploinky normally detects that
host address at start time, while normal optional manifest env resolution lets
operator configuration replace the detected hint. When neither variable is
set, the generator selects a usable non-loopback container interface.
Surrounding whitespace is trimmed before validation; malformed or
non-canonical IPv4 syntax after trimming, plus loopback, link-local,
unspecified, limited-broadcast, multicast, and reserved addresses, is rejected
for both variables. Both are ignored whenever topology media exists, so they
cannot weaken the global-unicast, fixed-port, or address-mode checks. Local mode
exists for a same-host or reachable-LAN browser deployment and cannot count as
native-Linux, cross-network, direct-UDP, NAT, or relay release evidence.

The manifest deliberately has no topology-dependent preinstall hook. Its
generated-config volume is non-required at host staging so a fresh workspace
can be mounted empty; startup populates it before any service reads config or
opens a listener. Missing attested topology, derived credentials, or valid
media configuration terminates startup. The generator reads Ploinky's standard
`/run/ploinky-edge-topology/current.json` container mount unless the runtime
injects an explicit `PLOINKY_EDGE_TOPOLOGY_FILE`. This preserves the rule that
Router locator and topology environment do not cross the pre-attestation
host-hook boundary.

The manifest keeps all workspace-persisted state under the unique agent owner
root `.data/liveKitServerAgent/`. Generated configuration, Redis state, and
recordings use the `generated`, `redis`, and `recordings` children respectively.
Their in-container paths remain `/working-data/generated`, `/data/redis`, and
`/data/recordings`.

No local relay, UDP range, public TLS proxy, or certificate process is part of
this image. Startup rejects unexpected wildcard/control listeners and verifies
that LiveKit owns UDP `7882`.

### Manifest and Router

Every profile resolves to exact host mode under Ploinky's current-generation
capability. The manifest declares public policy for
`/base-agent-additional-server/liveKitServerAgent/7880/*` and a narrower
authenticated policy for RoomService Twirp calls on the same loopback port. It
declares no physical publications. Public signaling uses Router `8080`; Twirp
uses the private Router listener and requires both authenticated policy and an
exact caller assertion.

The outer box always reserves UDP `7882`, independent of whether this agent is
enabled. Only one granted current generation may bind it. A conflict or wrong
socket owner is an actionable startup failure.

### External relay

TURN is an external service described by non-secret topology. Ploinky core
brokers short-lived credentials to exact authorized consumers; this agent does
not receive the long-term relay secret and does not supervise a relay process.

### Decisions & Questions

#### Question #1: Why reject syntactically valid non-global IPv4 addresses?

Response:
LiveKit advertises `rtc.node_ip` directly to remote peers, so private,
loopback, link-local, CGNAT, documentation, benchmark, multicast, reserved, and
other special-purpose ranges cannot satisfy the cross-network direct-UDP
contract. Configuration generation therefore accepts only canonical literal
global-unicast IPv4 input and fails closed without address discovery or a
fallback candidate.

#### Question #2: Why allow a private address only when topology media is absent?

Response:
The absence of topology media is the explicit local deployment contract. A
browser on the same host or reachable LAN must receive the host-facing address,
not the nested Box address discovered inside the container. Declaring the
optional override in the manifest makes that address available after
attestation without changing production topology validation. As soon as media
exists in topology, it remains authoritative and the override is ignored.

### Verification

Unit and integration checks validate topology parsing, fixed config, socket
ownership, service/readiness semantics, and forbidden listeners. Release gates
run direct UDP on native Linux x64 and arm64 with two browsers on distinct
external networks, plus external relay UDP and TLS fallback lanes.

The local end-to-end gate must also start a room-composite Egress, stop it,
observe `EGRESS_COMPLETE`, and verify that the mounted recordings directory
contains a non-empty media file. The room must contain a connected publisher
with a real media track so the gate proves the recorder's private ICE path,
PulseAudio path, and encoder path. Listener and template health alone do not
substitute for this recording proof.

Publication of the patched multi-architecture Egress image and repinning the
liveKitServerAgent base to its returned manifest digest are mandatory release
prerequisites; a local architecture build is not a substitute for that digest.

## Conclusion

The agent is valid only when immutable topology either supplies a canonical
literal globally routable unicast IPv4 or explicitly omits media for bounded
local deployment mode, LiveKit alone owns UDP `7882`, and all signaling,
administration, Egress, health, and relay boundaries remain private or
Router-mediated as specified above. Only the topology-backed global address
qualifies for cross-network release evidence.
