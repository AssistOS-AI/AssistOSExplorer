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

The Ploinky-hosted outer container owns a Podman 6 inner engine through Ploinky's bounded `nestedPodman` capability. A robot runs in exactly one of two modes: `browser`, using LinuxServer Chromium, or `desktop`, using LinuxServer Webtop.

Every robot retains metadata, home, workspace, downloads, and logs after its inner container stops. The home mounted at `/config` is the durable installation and application-state boundary for that robot.

Ploinky owns outer-container hosting, volume attachment, authentication, mutation protection, identity, and routing. RoboTeam owns robot records, ownership checks, inner-container lifecycle, and the authenticated Selkies reverse proxy. Task automation, Playwright/CDP control, Pelorus control, and human/agent input arbitration remain outside this implementation.

## Decisions & Questions

1. **Decision:** Podman-in-Podman is mandatory; no host Podman socket is used.
2. **Decision:** Only browser and desktop runs are exposed.
3. **Question:** The future autonomous control protocol remains unspecified.

## Conclusion

RoboTeam provides durable robot identity around disposable, observable graphical containers.
