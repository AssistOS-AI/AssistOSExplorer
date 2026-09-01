---
title: DS005-ploinky-security
id: DS005
status: accepted
owner: RoboTeamAgent
summary: Specifies authenticated routing, owner separation, nested-container authority, secrets, and experiment limitations.
---

## Introduction

RoboTeam stores credential-bearing GUI state and operates a nested engine, so public access and runtime authority remain explicit.

## Core Content

Canonical identity remains `agent:AchillesCLI/roboTeamAgent`. Port `7000` is reserved for AgentServer/MCP; only the RoboTeam HTTP/WebSocket service on port `3001` has an authenticated browser route. Inner Podman, Selkies loopback ports, Chromium debugging, and Pelorus control ports are never public.

Browser identity comes only from Router-injected `x-ploinky-auth-info`; mutations require Ploinky proof. AgentServer listens on port `7000`; MCP callbacks use `ROBOTEAM_INTERNAL_TOKEN` and the authenticated user id without logging either.

Each robot has one owner and separate mounts. The outer RoboTeam container remains on Ploinky's managed network. Its admitted `nestedPodman` capability adds only `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, `/dev/net/tun`, label disablement, and the fixed nested-Podman seccomp profile.

The inner engine runs as uid 0 inside the outer container's user namespace; it is not physical-host root. `SYS_ADMIN` still makes the outer container a weak security boundary, so this remains a controlled experiment. No host Podman socket or public inner API exists, and cleanup uses exact labels and names. Robot homes and browser sessions are credential-bearing data; operators must protect `/data` and backups.

## Decisions & Questions

1. **Decision:** The first experiment uses the bounded `nestedPodman` capability and never requests `--privileged` or host networking.
2. **Decision:** reusable robot homes are deliberate credential-bearing objects.
3. **Question:** Stronger deployments may require rootless refinements or a microVM outer boundary.

## Conclusion

Authentication remains strict while nested privileges are an explicit experimental tradeoff.
