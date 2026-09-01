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

Only active sessions exist in memory. Initialization removes stale containers only with RoboTeam's label. Failure and stop remove an exact container. Restart does not auto-resume. The manifest follows the operator-managed `docker.io/assistos/roboteam-agent:runtime` channel, and the install hook rejects an image that does not satisfy the offline runtime contract.

## Decisions & Questions

1. **Decision:** Inner Podman runs through Ploinky's bounded `nestedPodman` capability rather than a privileged outer container.
2. **Decision:** GUI images remain configurable OCI components.
3. **Question:** Immutable Chromium and Webtop digests should replace mutable defaults after experimentation.
4. **Decision:** The outer image uses the mutable, unversioned `runtime` channel because AssistOS controls its publication.

## Conclusion

The outer job boundary owns independently replaceable browser and desktop inner containers.
