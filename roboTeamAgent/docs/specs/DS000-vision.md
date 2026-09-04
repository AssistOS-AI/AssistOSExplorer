---
title: DS000-vision
summary: Defines RoboTeam as one Ploinky-hosted nested-container manager for persistent robots with browser and desktop runs.
---

## Introduction

[RoboTeam](../wiki.html#definition-roboteam) manages persistent [robots](../wiki.html#definition-robot). Each robot keeps a durable home and work area while its graphical runtime is an on-demand inner Podman container.

## Core Content

RoboTeam remains exactly one [Ploinky agent](../wiki.html#definition-ploinky-agent). Robots are records and directories inside that agent, not additional Ploinky agents or public services.

The Ploinky-hosted outer container owns a Podman 6 inner engine through Ploinky's bounded `nestedPodman` capability. A robot may run visible `browser` or `desktop` tasks and non-GUI simple ALA tasks. One ALA process runs per robot, and additional requests wait in that robot's FIFO queue. A robot retains at most one GUI container independently from the ALA process lifetime.

Every robot retains metadata, home, workspace, downloads, and logs after its inner container stops. The home mounted at `/config` is the durable installation and application-state boundary for that robot.

Ploinky owns outer-container hosting, volume attachment, authentication, mutation protection, identity, and routing. RoboTeam owns workspace robot records, administrator-only creation and deletion, asynchronous ALA lifecycle, inner-container lifecycle, loopback MCP bridges, the authenticated Selkies proxy, current-version tool caching, and human takeover/resume arbitration. Desktop automation uses computer-use-linux; browser automation uses Playwright MCP connected to the same visible Chromium session.

The HTML Overview must begin with the product vision and explain the durable robot, visible-workstation, and disposable-container model. The documentation must not split that introduction into a separate Product Vision page.
