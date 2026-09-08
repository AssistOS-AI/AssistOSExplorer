# liveKitServerAgent

Pinned runtime-v5 media infrastructure for WebMeet, deployed as
`AchillesIDE/liveKitServerAgent` from this repository.

See the [agent documentation](docs/index.html) and
[specification matrix](docs/specs/matrix.md) for the runtime contract.

The agent supervises Redis, LiveKit Server, LiveKit Egress, and private health.
After Router authority attestation, startup generates configuration from the
current unversioned Ploinky topology snapshot mounted at
`/run/ploinky-edge-topology/current.json`. An injected
`PLOINKY_EDGE_TOPOLOGY_FILE` may override that standard container path:
LiveKit signaling/API bind to `127.0.0.1:7880`. When topology declares media,
the advertised node address is its configured literal globally routable
unicast public IPv4 and local overrides are ignored. When topology omits media,
the manifest-declared optional `PLOINKY_MEDIA_PUBLIC_IP` selects a reachable
host or LAN address for bounded local deployment; absent that, the
manifest-resolved `PLOINKY_HOST_REACHABLE_IPV4`, normally supplied by
deployment-time detection, is preferred; otherwise startup discovers a usable
non-loopback container address. Operator configuration may replace that
detected hint through normal optional manifest env resolution. Local mode does
not satisfy cross-network release gates. LiveKit alone owns UDP `7882`. Egress uses
loopback template/service `7980` and loopback semantic health `7981`.

Public WebSocket signaling reaches loopback LiveKit through
`/base-agent-additional-server/liveKitServerAgent/7880/`. Administrative Twirp
uses the more-specific
`/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.RoomService/`
route and is reachable only through private Router with current policy and
caller assertion. Public policy admits the LiveKit GET/WebSocket signaling flow
and rejects a crafted public Twirp `POST` before target selection or dial.
Neither route creates an outer publication.

External TURN is required for relay fallback. Ploinky brokers short-lived
credentials to allowed consumers; no long-term relay secret enters this agent.

The supervisor verifies exact Egress ownership, rejects wildcard copies of
either Egress listener, and semantically distinguishes health JSON from the
template application. Upstream Egress v1.9.1 is rejected because it binds
`7981` to wildcard; activation requires the separately published, source-pinned
loopback patch image and its resulting multi-architecture digest. Detailed
supervisor health is available only on
`/run/ploinky/livekit-supervisor.sock`.

Workspace-persisted state is owned by `liveKitServerAgent`: generated
configuration uses `.data/liveKitServerAgent/generated`, Redis uses
`.data/liveKitServerAgent/redis`, and recordings use
`.data/liveKitServerAgent/recordings`. These host paths remain mounted at
`/working-data/generated`, `/data/redis`, and `/data/recordings` inside the
container.

Validation:

```bash
node --check scripts/generate-config.mjs
sh -n scripts/start-livekit-server-agent.sh
sh -n scripts/health/livekit-server-agent-health.sh
node --check scripts/health/supervisor-health.mjs
node --test tests/*.test.mjs
```
