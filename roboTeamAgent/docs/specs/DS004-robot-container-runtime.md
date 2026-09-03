---
title: DS004-robot-container-runtime
id: DS004
status: accepted
owner: RoboTeamAgent
summary: Specifies robot storage, inner Podman configuration, image selection, Selkies routing, and lifecycle behavior.
---

## Introduction

The runtime combines a durable robot directory with an on-demand inner Podman container.

## Core Content

Metadata uses schema `roboteam-robot-v1`. `/data/robots/<id>` contains `home`, `workspace`, `downloads`, `logs`, and `runtime`; writes are atomic and identifiers are validated before access.

The custom outer image derives from an immutable official Podman 6 upstream index and includes Node.js, curl, Git, `fuse-overlayfs`, and `pasta`. Contract `roboteam-runtime-v3` verifies Podman major version 6 and configures inner overlay storage at `/data/podman/storage`, with `fuse-overlayfs` and `ignore_chown_errors` for nested storage compatibility.

The manifest declares `containerSecurity.nestedPodman: true` and Box-local `openPorts: ["7000:7000", "3001:3001"]`; it does not select host networking. Ploinky translates the admitted capability to `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, `/dev/net/tun`, label disablement, and a fixed nested-Podman seccomp profile. AgentServer/MCP uses port 7000 and the authenticated RoboTeam HTTP/WebSocket service uses port 3001. No host engine socket is mounted.

Browser defaults to `lscr.io/linuxserver/chromium:latest`; desktop defaults to `lscr.io/linuxserver/webtop:ubuntu-xfce`. Runs use private IPC with 1 GiB shared memory and `pasta`, publish port `3000` only to random outer loopback, set the Router path as `SUBFOLDER`, disable nested Docker startup and IPv6, enable Pelorus, and mount `home` at `/config`, workspace at `/config/workspace`, and downloads at `/config/Downloads`.

Only active sessions exist in memory. Initialization removes stale containers only with RoboTeam's label. Failure and stop remove an exact container. Restart does not auto-resume. The manifest pins `docker.io/assistos/roboteam-agent@sha256:e8282f4ccd23ac4520421daecf46f208225b45b34bb9e40a9937e2c40821215d`, the multi-architecture v3 image published from image-definition commit `b0490170a976b67504d3bfb0bdbe09e3df7dcdde` by [publication run 33726137599](https://github.com/AssistOS-AI/container-image-builds/actions/runs/33726137599). Its amd64 and arm64 members declare `roboteam-runtime-v3`. The install hook continues to reject any image that does not satisfy the offline runtime contract.

## Decisions & Questions

1. **Decision:** Inner Podman runs through Ploinky's bounded `nestedPodman` capability rather than a privileged outer container.
2. **Decision:** GUI images remain configurable OCI components.
3. **Question:** Immutable Chromium and Webtop digests should replace mutable defaults after experimentation.
4. **Decision:** The outer image uses a verified immutable index so changes to the `runtime` channel cannot select an incompatible contract. Updating the pin requires a published image that preserves the agent's required runtime contract on both architectures.

## Conclusion

The outer job boundary owns independently replaceable browser and desktop inner containers.
