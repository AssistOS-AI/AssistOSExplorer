---
title: DS004-robot-container-runtime
summary: Defines persistent robot storage, runtime-only GUI images, current-version tool caching, and bounded nested Podman lifecycle.
---

## Introduction

RoboTeam combines durable robot state with disposable browser or desktop containers. Operating-system runtimes and automation executables have separate lifecycle and supply-chain boundaries.

## Core Content

Robot metadata uses schema `roboteam-robot-v1`. `/data/robots/` contains each robot's persistent home, workspace, downloads, logs, and runtime files. Writes must be atomic and identifiers must be validated before filesystem access.

The outer `docker.io/assistos/roboteam-agent:runtime` image must satisfy `roboteam-runtime-v4`. It provides Podman 6, Node.js, npm, Bubblewrap, fuse-overlayfs, pasta, curl, Git, and nested storage configuration. The image must not bake in Codex, computer-use-linux, Supergateway, or Playwright MCP.

The sibling image-definition repository must provide a local development installer with `agent`, `desktop`, `browser`, and `all` targets. It must build in the exact owned Ploinky Box, stream GUI images into the single running managed RoboTeam container's nested engine without a registry or host engine socket, reject ambiguous container ownership, and reinstall RoboTeam after activation. This path is native-architecture development tooling; multiarchitecture output remains a publication responsibility.

The manifest must retain `containerSecurity.nestedPodman: true`, MCP port 7000, authenticated service port 3001, `/data` persistence, and the current runtime-only desktop and browser image defaults. Every inner Podman run must use `--ipc=none` because creating a nested mqueue mount is not admitted by Ploinky's bounded capability. GUI containers must restore their required shared memory with a private `/dev/shm` tmpfs, use Podman's `k8s-file` log driver so `podman logs` works without a systemd journal in the outer container, and expose Selkies port 3000 and MCP bridge port 8100 only through random outer-loopback mappings. No host container-engine socket may be mounted.

`ToolCache` must resolve current upstream versions on first use and after the bounded refresh interval. Codex, Supergateway, and Playwright MCP resolve through npm; computer-use-linux resolves from its current GitHub release for the active architecture. Host npm and cached-tool probes must not inherit Ploinky's `NODE_OPTIONS` symlink-preservation flags. Candidates must be installed in unique staging directories, probed before activation, recorded with exact resolved versions, and activated by replacing `current.json` atomically. The downloaded computer-use-linux bytes must have a recorded SHA-256 digest and must match an upstream asset digest when one is available.

Prepared generations live under `/data/tool-cache`. Concurrent preparation for the same tool family must coalesce in one process. A failed lookup, download, installation, or validation may use only the last stamped valid generation. If no valid generation exists, the operation must fail clearly. Exact generations must remain available while live containers can still mount them.

Desktop containers mount the active desktop tool generation read-only at `/opt/roboteam-tools`. They also mount the active Codex generation read-only at `/opt/roboteam-codex`, prepend its binary directory to `PATH`, retain LinuxServer's `/lsiopy/bin` runtime directory in that PATH, and set `CODEX_HOME=/config/.codex`. RoboTeam must create that persistent directory before starting either the desktop or ALA, because Codex rejects a `CODEX_HOME` path that does not exist. Manual desktop configuration and later ALA execution therefore use the same robot home without disabling the Selkies backend. Browser containers mount the active browser tools at `/opt/roboteam-tools`. ALA runs separately in the outer runtime with the requested cwd and robot-specific `--home`.

RoboTeam must run in Ploinky global mode and invoke the real `/workspace/AdvancedLanguageAgent/bin/ala.mjs` workspace entrypoint rather than an npm `.bin` symlink. The global mount makes the current local ALA contract available during development. Ploinky's required Node.js symlink-preservation options would otherwise make the symlink path the module base and resolve ALA's relative imports outside its package. When ALA exits unsuccessfully, RoboTeam must preserve its bounded output tail and include that diagnostic in the internal task error.

Only active sessions and task queues are retained in memory. A robot may retain at most one GUI session. That session is reusable only for the same mode and resolved cwd. A queued request with another mode or cwd must wait for the active ALA task, remove the idle retained container by its exact managed name, and create its replacement with the new `/workspace` mount. A Simple task must leave a retained GUI session unchanged. A GUI session becomes `running` only after Selkies accepts its published connection and the MCP endpoint returns an HTTP response; the outer Pasta listener alone is not readiness evidence. Initialization may remove stale containers only when RoboTeam's managed label proves ownership. Failure and stop must remove the exact owned container. Restart does not automatically resume interrupted work or queued requests whose native Ploinky task was interrupted.
