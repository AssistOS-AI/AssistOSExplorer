# AchillesIDE/liveKitServerAgent Agent Guide

## Scope

Single Ploinky agent that supervises Redis, LiveKit Server, LiveKit Egress, and
private health inside a pinned image. It contains no local relay, public TLS
proxy, certificate process, tunnel connector, or publication planner.

## Mandatory Reading Order

1. Read the nearest parent `AGENTS.md` for workspace-wide rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
4. Read `docs/specs/DS003-ploinky-runtime-invariants.md` before touching auth, routing, guest access, MCP, HTTP services, files, logs, or runtime configuration.
5. Read `docs/specs/DS002-livekit-server-agent.md` for the agent contract and the responsibilities of each supervised service.
6. Read `docs/specs/DS001-coding-style.md` for coding style, module structure, and test-organization rules.

## Current Skill Catalog

- No local skill catalog is declared for this agent.

## Repository Rules

- The DS specifications are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation and the DS specifications.
- Keep DS numbering gap-free within any newly initialized GAMP spec set. Preserve existing local numbering conventions unless a migration updates all links in the same change.
- All documentation, specifications, and code comments must be written in English.
- Do not add imported-skill DS files or skill pages to a downstream host project's docs tree.
- Keep Ploinky runtime invariants in local context: router-mediated entry, secure-wire invocation JWTs, scoped guest mode, manifest-declared HTTP services, workspace-confined paths, and redacted logs.
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- Update `AGENTS.md` and `CLAUDE.md` together so coding agents receive the same local context.

## Runtime Defaults

The manifest sets `start: "sh /code/scripts/start-livekit-server-agent.sh"` and
uses the managed `health.readiness.script` entrypoint `healthcheck.sh`. The summary probe passes only after Redis, LiveKit
Server, LiveKit Egress, Egress semantic health, and expected socket ownership
are ready. Detailed health is served only on the unmounted Unix socket
`/run/ploinky/livekit-supervisor.sock`.

The startup generator consumes the immutable topology only after Router
authority attestation. It defaults to Ploinky's standard
`/run/ploinky-edge-topology/current.json` mount and accepts
`PLOINKY_EDGE_TOPOLOGY_FILE` as an override. It generates LiveKit with loopback
HTTP/Twirp on `7880`,
a literal configured public IPv4,
`use_external_ip: false`, one UDP mux on `7882`, and TCP media disabled. Public
topology is authoritative and ignores `PLOINKY_MEDIA_PUBLIC_IP`. When valid
topology omits media, that optional manifest-declared variable selects a
reachable host or LAN IPv4 for bounded local deployment; absent that, the
manifest-resolved `PLOINKY_HOST_REACHABLE_IPV4`, normally supplied by
deployment-time detection, is preferred; otherwise startup discovers a usable
non-loopback container address. Operator configuration may replace that
detected hint through normal optional manifest env resolution. Local mode is
not cross-network release evidence. Public signaling and private Twirp use
their declared Router services. External TURN
credentials are brokered to authorized consumers; no long-term relay secret
enters this agent.

The supervisor must not try to launch sibling Ploinky agents: Ploinky resolves
manifest `enable` edges before this agent's container exists, and an in-process
`ploinky` call from inside the container has no view of the host's runtime
state. Every required service must therefore be installed in the image and
supervised by the script directly.

Generated config under `.data/liveKitServerAgent/generated/` is rebuilt on
every attested container start and must not contain secrets that leak outside
the workspace. Pre-attestation host hooks must not receive Router locator or
topology environment.
Durable Redis and recording state lives under
`.data/liveKitServerAgent/{redis,recordings}/`.

## Key Paths

- `manifest.json`
- `scripts/start-livekit-server-agent.sh`
- `scripts/generate-config.mjs`
- `scripts/health/livekit-server-agent-health.sh`
- `scripts/health/supervisor-health.mjs`
- `docs/specs/DS002-livekit-server-agent.md`
- `docs/specs/DS003-ploinky-runtime-invariants.md`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `sh -n scripts/start-livekit-server-agent.sh`
- `node --check scripts/generate-config.mjs`
- `sh -n scripts/health/livekit-server-agent-health.sh`
- `node --check scripts/health/supervisor-health.mjs`
- `find .. -name '*.json' -not -path '*/.git/*' -print0 | xargs -0 -n1 python3 -m json.tool >/dev/null`
- `ploinky start AchillesIDE/webmeetAgent`
- `ploinky status`
