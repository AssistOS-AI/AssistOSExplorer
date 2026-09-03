---
title: DS005-ploinky-security
id: DS005
status: accepted
owner: RoboTeamAgent
summary: Specifies authenticated routing, administrator controls, workspace robot access, nested-container authority, secrets, and experiment limitations.
---

## Introduction

RoboTeam stores credential-bearing GUI state and operates a nested engine, so public access and runtime authority remain explicit.

## Core Content

Canonical identity remains `agent:AchillesCLI/roboTeamAgent`. Port `7000` is reserved for AgentServer/MCP; only the RoboTeam HTTP/WebSocket service on port `3001` has an authenticated browser route. Inner Podman, Selkies loopback ports, bridge port 8100, and Chromium CDP port 9222 are never public.

Browser identity comes only from Router-injected `x-ploinky-auth-info`; mutations require Ploinky proof. AgentServer listens on port `7000`; MCP callbacks use `ROBOTEAM_INTERNAL_TOKEN` and the authenticated user id without logging either.

Robots belong to the workspace rather than individual users and retain separate mounts. Creation and deletion require an authenticated `admin` role; internal Ploinky agents may use the explicitly internal list, task-start, and task-status tools without a delegated user identity. The outer RoboTeam container remains on Ploinky's managed network. Its admitted `nestedPodman` capability adds only `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, `/dev/net/tun`, label disablement, and the fixed nested-Podman seccomp profile.

The inner engine runs as uid 0 inside the outer container's user namespace; it is not physical-host root. `SYS_ADMIN` still makes the outer container a weak security boundary, so this remains a controlled experiment. Inner runs disable Podman's private IPC setup to avoid a nested mqueue mount that the bounded capability intentionally cannot create; GUI runs add only their own `/dev/shm` tmpfs. No host Podman socket or public inner API exists, and cleanup uses exact labels and names. Robot homes and browser sessions are credential-bearing data; operators must protect `/data` and backups.

The current nested runtime cannot mount a private procfs inside the additional user namespace used by ALA's normal Bubblewrap path. ALA must probe that normal path first. When only that nested mount is rejected, ALA may omit the additional user namespace while retaining private PID, IPC, and UTS namespaces, a private procfs, its read-only filesystem boundary, controlled writable mounts, isolated temporary storage, and its filtered environment. The admitted outer `SYS_ADMIN` capability may be used only while Bubblewrap constructs those mounts, and Bubblewrap must apply `--cap-drop ALL` before starting the coding agent. The coding agent must not inherit the capability. Failure of both private-proc paths must stop execution; an unsandboxed fallback is forbidden.

Current npm and GitHub releases are external supply-chain inputs. RoboTeam must stage and probe candidates before activation, record exact resolved versions, verify computer-use-linux bytes against the available upstream digest, mount generations read-only, and fall back only to a stamped valid generation. Cache metadata and logs must not contain robot credentials.

## Decisions & Questions

### Question #1: Which nested-container authority is admitted?

Response: The runtime uses the bounded `nestedPodman` capability and never requests `--privileged` or host networking.

### Question #2: How are reusable robot homes classified?

Response: They are deliberate credential-bearing objects and must be protected with `/data` and its backups.

### Question #3: What trust is placed in current upstream releases?

Response: RoboTeam trusts the current npm metadata and GitHub release channel only after local staging, probing, version recording, and available digest verification. Stronger deployments may add an operator approval or pinning policy later.

### Question #4: Which isolation property is reduced by ALA's nested-runtime fallback?

Response: Only the additional ALA UID/user namespace is omitted. The outer Podman user-namespace boundary remains, and ALA retains its Bubblewrap filesystem, PID, IPC, UTS, temporary-directory, environment, and private-proc boundaries. All outer capabilities are dropped before the coding agent executes.

## Conclusion

Authentication remains strict while nested privileges are an explicit experimental tradeoff.
