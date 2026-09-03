---
title: DS004-robot-container-runtime
id: DS004
status: accepted
owner: RoboTeamAgent
summary: Defines persistent robot storage, runtime-only GUI images, current-version tool caching, and bounded nested Podman lifecycle.
---

## Introduction

RoboTeam combines durable robot state with disposable browser or desktop containers. Operating-system runtimes and automation executables have separate lifecycle and supply-chain boundaries.

## Core Content

Robot metadata uses schema `roboteam-robot-v1`. `/data/robots/` contains each robot's persistent home, workspace, downloads, logs, and runtime files. Writes must be atomic and identifiers must be validated before filesystem access.

The outer `docker.io/assistos/roboteam-agent:runtime` image must satisfy `roboteam-runtime-v4`. It provides Podman 6, Node.js, npm, Bubblewrap, fuse-overlayfs, pasta, curl, Git, and nested storage configuration. The image must not bake in Codex, computer-use-linux, Supergateway, or Playwright MCP.

The manifest must retain `containerSecurity.nestedPodman: true`, MCP port 7000, authenticated service port 3001, `/data` persistence, and the current runtime-only desktop and browser image defaults. Inner GUI containers must expose Selkies port 3000 and MCP bridge port 8100 only through random outer-loopback mappings. No host container-engine socket may be mounted.

`ToolCache` must resolve current upstream versions on first use and after the bounded refresh interval. Codex, Supergateway, and Playwright MCP resolve through npm; computer-use-linux resolves from its current GitHub release for the active architecture. Candidates must be installed in unique staging directories, probed before activation, recorded with exact resolved versions, and activated by replacing `current.json` atomically. The downloaded computer-use-linux bytes must have a recorded SHA-256 digest and must match an upstream asset digest when one is available.

Prepared generations live under `/data/tool-cache`. Concurrent preparation for the same tool family must coalesce in one process. A failed lookup, download, installation, or validation may use only the last stamped valid generation. If no valid generation exists, the operation must fail clearly. Exact generations must remain available while live containers can still mount them.

Desktop containers mount the active desktop tool generation read-only at `/opt/roboteam-tools`. They also mount the active Codex generation read-only at `/opt/roboteam-codex`, prepend its binary directory to `PATH`, and set `CODEX_HOME=/config/.codex`, so manual desktop configuration and later ALA execution use the same robot home. Browser containers mount the active browser tools at `/opt/roboteam-tools`. ALA runs separately in the outer runtime with the requested cwd and robot-specific `--home`.

Only active sessions are retained in memory. Initialization may remove stale containers only when RoboTeam's managed label proves ownership. Failure and stop must remove the exact owned container. Restart does not automatically resume interrupted work.

## Decisions & Questions

### Question #1: Why are runtime tools excluded from the images?

Response: The images provide stable system dependencies, while RoboTeam resolves current automation packages at runtime and retains validated generations in persistent cache.

### Question #2: Why are cache generations immutable after activation?

Response: Live GUI containers and ALA processes may still mount an exact generation. New releases therefore create a new generation and atomically move only the active descriptor.

### Question #3: What happens when upstream services are unavailable?

Response: RoboTeam uses the last valid stamped generation when one exists. A cold start without a valid cache fails instead of running an unvalidated or incomplete toolset.

### Question #4: Why is Codex configuration not stored in the shared tool cache?

Response: The cache stores shared executable bytes. Authentication and agent configuration remain in each robot's persistent home and are selected through ALA `--home` or the desktop's `/config` mount.

## Conclusion

The runtime keeps durable robot identity, replaceable GUI containers, and current automation tools independent while preserving one visible human-and-agent session.
