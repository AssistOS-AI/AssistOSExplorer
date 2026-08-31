---
title: DS003-main-behavior
summary: Defines the central user-visible behaviors for virtual employee profiles, interactive desktops, and persistent owner isolation.
---

## Introduction

[RoboTeam](../wiki.html#definition-roboteam) lets an authenticated Ploinky user create specialized virtual employees, enter their Linux desktops, and preserve each employee's private working state across desktop sessions.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Virtual employee profile management | An authenticated user creates and lists durable virtual employee identities with a name, specialization, private storage, and stable Linux UID. |
| Interactive profile desktop | A profile owner starts, views, controls, and stops a Linux desktop through the authenticated RoboTeam browser route while preserving its application state. |
| Owner isolation and persistent continuity | RoboTeam restricts each profile to its owner, runs desktop processes under the profile UID, and keeps profile files after graphical processes stop. |

### Virtual employee profile management

An authenticated Ploinky user creates a [robot profile](../wiki.html#definition-robot-profile) through the RoboTeam dashboard or `robot_profile_create`. RoboTeam accepts a required name and optional specialization, assigns an opaque identifier and unique numeric UID, creates the profile directory tree, records the authenticated user as [profile owner](../wiki.html#definition-profile-owner), and returns the profile with its desktop URL. `robot_profile_list` and `GET /api/profiles` return only that user's profiles.

The observable result is a durable virtual employee identity that survives process and container restarts through the Ploinky-mounted data volume. Profile creation must serialize UID allocation and publish metadata atomically. The specialization is descriptive and must not grant runtime skills or authority.

### Interactive profile desktop

The profile owner selects **Open desktop** or calls `robot_desktop_start` with a profile id. RoboTeam starts one [desktop session](../wiki.html#definition-desktop-session) containing Xvfb, Openbox, Chromium, xterm, x11vnc, and websockify, then returns `desktop.html?profile=<profile-id>`. The noVNC client connects through the authenticated [agent-port route](../wiki.html#definition-agent-port-route) and gives the owner visible keyboard and pointer control of the Linux desktop.

Selecting **Stop desktop**, calling `robot_desktop_stop`, losing a critical display transport process, or stopping the RoboTeam service terminates the session. The profile's persistent files and browser state remain. RoboTeam must enforce its configured concurrent desktop limit and must fail startup when a required executable or transport does not become ready.

### Owner isolation and persistent continuity

The authenticated user initiating a profile API, MCP tool, desktop page, or desktop WebSocket must match the stored owner id. Requests for another user's profile must not disclose or operate that profile. Browser mutations must pass Ploinky's browser mutation proof, and MCP-to-service calls must pass the generated loopback internal token plus AgentServer's authenticated user id.

Desktop processes must run with the profile's stable numeric UID and profile-specific HOME, browser, workspace, download, log, and runtime directories. Directory ownership and restrictive permissions must prevent an ordinary desktop process from reading another profile's private state. The trusted RoboTeam control service remains able to manage every profile, and this Unix permission boundary is not equivalent to a virtual machine.
