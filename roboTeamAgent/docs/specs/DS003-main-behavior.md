---
title: DS003-main-behavior
id: DS003
status: accepted
owner: RoboTeamAgent
summary: Defines persistent robot creation and observable browser or desktop inner-container runs.
---

## Introduction

An authenticated Ploinky user creates durable robots and starts one observable graphical environment for each robot.

## Core Content

| Main behavior | Observable result |
| --- | --- |
| Persistent robot management | Owner-scoped robots keep home and work files across runs. |
| Browser run | LinuxServer Chromium runs as an inner container with a visible Selkies session. |
| Desktop run | LinuxServer Webtop runs as an inner container with a visible full desktop. |

`robot_create` and `POST /api/robots` assign an opaque id, create persistent directories, and atomically record the authenticated owner. `robot_list` and `GET /api/robots` return only that owner's robots. Existing `roboteam-profile-v1` records under `/data/profiles` migrate once while preserving their files.

`robot_start` and `POST /api/robots/:id/run` accept exactly `browser` or `desktop`. RoboTeam mounts persistent robot directories, publishes Selkies port `3000` to random outer loopback, and returns the Router-relative session URL. Starting the same mode is idempotent; changing mode while running is rejected. The browser dashboard must synchronously reserve the user-requested session window before awaiting container startup, navigate that window when Selkies is ready, and provide a same-tab fallback when popup creation is unavailable. The two stopped-state actions are `Start Browser` and `Start Desktop`; while a run is active, its matching action becomes `Stop Browser` or `Stop Desktop` and the other mode remains disabled.

The authenticated HTTP and WebSocket route proxies that Selkies session. `robot_stop` removes only the selected managed container and preserves robot data. `robot_logs` returns bounded logs. Every operation must match the stored owner.

## Decisions & Questions

### Question #1: How many runs may a robot own?

Response: One active run is permitted per robot, bounded globally by `ROBOTEAM_MAX_ACTIVE_ROBOTS`.

### Question #2: Does the public API delete robots?

Response: No robot deletion endpoint is exposed.

### Question #3: How is human takeover signaled?

Response: Human takeover signaling is deferred with autonomous control.

### Question #4: How does the dashboard represent run lifecycle actions?

Response: It opens the named session window synchronously from the start click, navigates it after startup, falls back to the current tab if popup creation is blocked, and turns the active mode's start action into its stop action until removal completes.

## Conclusion

A robot's browser or desktop can be started, viewed, stopped, and resumed without losing its home.
