---
title: DS000-vision
id: DS000
status: accepted
owner: RoboTeamAgent
summary: Defines RoboTeam as one Ploinky-hosted nested-container manager for persistent robots with browser and desktop runs.
---

## Introduction

[RoboTeam](../wiki.html#definition-roboteam) manages persistent [robots](../wiki.html#definition-robot). Each robot keeps a durable home and work area while its graphical runtime is an on-demand inner Podman container.

## Core Content

RoboTeam remains exactly one [Ploinky agent](../wiki.html#definition-ploinky-agent). Robots are records and directories inside that agent, not additional Ploinky agents or public services.

The Ploinky-hosted outer container owns a Podman 6 inner engine through Ploinky's bounded `nestedPodman` capability. A robot may run a visible `browser` or `desktop` task, or a non-GUI simple ALA task. One execution slot exists per robot.

Every robot retains metadata, home, workspace, downloads, and logs after its inner container stops. The home mounted at `/config` is the durable installation and application-state boundary for that robot.

Ploinky owns outer-container hosting, volume attachment, authentication, mutation protection, identity, and routing. RoboTeam owns robot records, ownership checks, asynchronous ALA lifecycle, inner-container lifecycle, loopback MCP bridges, the authenticated Selkies proxy, current-version tool caching, and human takeover/resume arbitration. Desktop automation uses computer-use-linux; browser automation uses Playwright MCP connected to the same visible Chromium session.

## Decisions & Questions

### Question #1: Where do graphical robot runtimes execute?

Response: Podman-in-Podman is mandatory; no host Podman socket is used.

### Question #2: How are autonomous and human actions kept visible?

Response: The MCP controller and the user operate the same Selkies desktop or Chromium session, and Take Control stops only ALA.

### Question #3: Where do automation executables live?

Response: Current releases are shared through validated persistent cache generations rather than copied into each robot or baked into GUI images.

## Conclusion

RoboTeam provides durable robot identity around disposable, observable graphical containers.
