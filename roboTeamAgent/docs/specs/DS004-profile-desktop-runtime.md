---
title: DS004-profile-desktop-runtime
summary: Specifies profile data, ownership, desktop processes, temporary port allocation, browser access, and lifecycle failure behavior.
---

## Introduction

The profile and desktop runtime turns a persistent [robot profile](../wiki.html#definition-robot-profile) into an on-demand interactive Linux environment while keeping storage independent of process lifetime.

## Core Content

Each profile metadata file must use schema `roboteam-profile-v1` and contain the profile id, name, specialization, owner user id, numeric UID, system username, and creation and update timestamps. Profile identifiers must match the bounded lowercase slug-and-suffix grammar enforced by the service and must be validated before filesystem access.

The profile root must contain `home`, `workspace`, `browser`, `downloads`, `logs`, and `runtime`. These directories must use restrictive modes and must be owned by the profile UID when the service has root authority. The metadata write must use a temporary file followed by atomic rename. Profile creation must use an exclusive lock so concurrent requests cannot allocate the same UID.

The [desktop session](../wiki.html#definition-desktop-session) state machine is `stopped`, `starting`, `running`, and `stopping`. Only active sessions exist in memory. A service restart must treat every persisted profile as stopped and must not automatically restore a graphical session.

Desktop startup must allocate one bounded slot. The slot determines temporary X11 display, RFB, and websockify port numbers. These values must not be persisted as profile identity and must not be published directly outside the agent container.

Xvfb must disable TCP display listening. Openbox, xterm, Chromium, x11vnc, and websockify must receive the selected profile's UID, GID, HOME, XDG paths, DISPLAY, and workspace working directory. Chromium must use the profile `browser` directory as its user-data directory. x11vnc must bind to loopback and websockify must forward only to the corresponding loopback RFB port.

The HTTP service must serve noVNC assets from an installed, confined root and must validate every asset path. A desktop WebSocket must resolve to an owned profile with an active session before the service connects to its websockify port. WebSocket headers must be allowlisted when the service constructs the upstream handshake.

The manifest must pin the purpose-built RoboTeam runtime by immutable multi-platform image digest. That image owns Chromium, X11, Openbox, xterm, x11vnc, websockify, noVNC, and Linux account-management prerequisites. The profile install hook must remain a fast, offline, idempotent verification of the `roboteam-runtime-v1` image contract; it must not install packages or perform network access while the agent readiness clock is running.

Ploinky readiness must continue to probe MCP and must declare a 45-second overall startup budget. The broader no-wait startup default may remain longer, while targeted restart must honor at least this manifest budget. Once launched, the container entrypoint must supervise both the RoboTeam service and AgentServer: exit of either child terminates the peer and fails the container.

RoboTeam must provide an AchillesIDE Explorer application plugin in the `file-exp:toolbar` slot, ordered immediately after WebMeet. The plugin is a navigation entry point only: it must open the existing Router-authenticated RoboTeam dashboard, adapt its label, tooltip, and icon to Explorer host metadata, and leave profile creation, ownership checks, desktop startup, and browser mutation protection inside the RoboTeam service. Explorer may relocate the same action into its Tools menu on narrow screens.

Startup must wait for the X11 socket, RFB listener, and websockify listener. Timeout, missing command, or process error must clean up all processes launched for the session and leave the profile stopped. Exit of Xvfb, x11vnc, or websockify during a running session must trigger session cleanup.

Desktop shutdown must send termination to every tracked child, use bounded forced termination for processes that remain alive, close the log descriptor, and preserve the profile directories. Profile deletion is outside the public contract and must not be inferred from desktop stop.
