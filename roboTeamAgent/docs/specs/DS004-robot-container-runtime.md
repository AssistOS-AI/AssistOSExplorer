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

The sibling image-definition repository must provide a local development installer with `agent`, `desktop`, `browser`, and `all` targets. It must build in the exact owned Ploinky Box, stream GUI images into the single running managed RoboTeam container's nested engine without a registry or host engine socket, reject ambiguous container ownership, and reinstall RoboTeam after activation. This path is native-architecture development tooling; multiarchitecture output remains a publication responsibility.

The manifest must retain `containerSecurity.nestedPodman: true`, MCP port 7000, authenticated service port 3001, `/data` persistence, and the current runtime-only desktop and browser image defaults. Every inner Podman run must use `--ipc=none` because creating a nested mqueue mount is not admitted by Ploinky's bounded capability. GUI containers must restore their required shared memory with a private `/dev/shm` tmpfs, and expose Selkies port 3000 and MCP bridge port 8100 only through random outer-loopback mappings. No host container-engine socket may be mounted.

`ToolCache` must resolve current upstream versions on first use and after the bounded refresh interval. Codex, Supergateway, and Playwright MCP resolve through npm; computer-use-linux resolves from its current GitHub release for the active architecture. Host npm and cached-tool probes must not inherit Ploinky's `NODE_OPTIONS` symlink-preservation flags. Candidates must be installed in unique staging directories, probed before activation, recorded with exact resolved versions, and activated by replacing `current.json` atomically. The downloaded computer-use-linux bytes must have a recorded SHA-256 digest and must match an upstream asset digest when one is available.

Prepared generations live under `/data/tool-cache`. Concurrent preparation for the same tool family must coalesce in one process. A failed lookup, download, installation, or validation may use only the last stamped valid generation. If no valid generation exists, the operation must fail clearly. Exact generations must remain available while live containers can still mount them.

Desktop containers mount the active desktop tool generation read-only at `/opt/roboteam-tools`. They also mount the active Codex generation read-only at `/opt/roboteam-codex`, prepend its binary directory to `PATH`, retain LinuxServer's `/lsiopy/bin` runtime directory in that PATH, and set `CODEX_HOME=/config/.codex`. RoboTeam must create that persistent directory before starting either the desktop or ALA, because Codex rejects a `CODEX_HOME` path that does not exist. Manual desktop configuration and later ALA execution therefore use the same robot home without disabling the Selkies backend. Browser containers mount the active browser tools at `/opt/roboteam-tools`. ALA runs separately in the outer runtime with the requested cwd and robot-specific `--home`.

RoboTeam must run in Ploinky global mode and invoke the real `/workspace/AdvancedLanguageAgent/bin/ala.mjs` workspace entrypoint rather than an npm `.bin` symlink. The global mount makes the current local ALA contract available during development. Ploinky's required Node.js symlink-preservation options would otherwise make the symlink path the module base and resolve ALA's relative imports outside its package. When ALA exits unsuccessfully, RoboTeam must preserve its bounded output tail and include that diagnostic in the internal task error.

Only active sessions are retained in memory. A retained GUI session is reusable only for the same mode and resolved cwd. A same-mode request with another cwd must remove the idle retained container by its exact managed name and create its replacement with the new `/workspace` mount; it must not remount beneath an active older task. A GUI session becomes `running` only after Selkies accepts its published connection and the MCP endpoint returns an HTTP response; the outer Pasta listener alone is not readiness evidence. Initialization may remove stale containers only when RoboTeam's managed label proves ownership. Failure and stop must remove the exact owned container. Restart does not automatically resume interrupted work.

## Decisions & Questions

### Question #1: Why are runtime tools excluded from the images?

Response: The images provide stable system dependencies, while RoboTeam resolves current automation packages at runtime and retains validated generations in persistent cache.

### Question #2: Why are cache generations immutable after activation?

Response: Live GUI containers and ALA processes may still mount an exact generation. New releases therefore create a new generation and atomically move only the active descriptor.

### Question #3: What happens when upstream services are unavailable?

Response: RoboTeam uses the last valid stamped generation when one exists. A cold start without a valid cache fails instead of running an unvalidated or incomplete toolset.

### Question #4: Why is Codex configuration not stored in the shared tool cache?

Response: The cache stores shared executable bytes. Authentication and agent configuration remain in each robot's persistent home and are selected through ALA `--home` or the desktop's `/config` mount.

### Question #5: Why do nested containers use `--ipc=none` and a separate `/dev/shm`?

Response: Podman's normal private IPC setup attempts to mount mqueue again and is rejected inside the bounded outer container. Disabling that setup avoids requiring broader privileges; a private tmpfs supplies the shared memory Chromium and the desktop still need.

### Question #6: How are local images tested without waiting for publication?

Response: The development installer builds the outer image directly in the owned Box storage and streams GUI images into RoboTeam's nested storage. Exact managed-runtime selection and a final reinstall preserve the same runtime boundaries as published images without using the registry.

### Question #7: Why does the GUI container PATH retain `/lsiopy/bin`?

Response: LinuxServer installs the Selkies executable in that virtual-environment directory. Adding the cached Codex binary must extend the base runtime search path rather than make the page-serving nginx process outlive an unavailable streaming backend.

### Question #8: Why does RoboTeam use the global workspace ALA entrypoint?

Response: RoboTeam and ALA are developed as coordinated workspace repositories, so global mode exposes current local ALA changes without waiting for a remote Git dependency refresh. Invoking its real entrypoint also keeps relative ESM imports anchored inside `AdvancedLanguageAgent` when Ploinky preserves symlink identities.

## Conclusion

The runtime keeps durable robot identity, replaceable GUI containers, and current automation tools independent while preserving one visible human-and-agent session.
