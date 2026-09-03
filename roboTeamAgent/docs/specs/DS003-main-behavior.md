---
title: DS003-main-behavior
id: DS003
status: accepted
owner: RoboTeamAgent
summary: Defines persistent robot management, visible sessions, and asynchronous ALA task execution.
---

## Introduction

An authenticated Ploinky user manages durable robots and starts observable desktop, browser, or non-GUI ALA work by unique robot name.

## Core Content

`robot_create`, `robot_list`, and `robot_delete` manage owner-scoped records. Names are unique per owner. Each record owns a persistent home used both as `/config` in its GUI and as ALA `--home`, plus workspace, runtime, log, and download directories. No legacy record migration occurs.

`openDesktopForRobot` and the dashboard can start a desktop without ALA so the user can configure coding-agent accounts in the persistent home. `getSessionUrlForRobotDesktop` and `getSessionUrlForRobotBrowser` return the authenticated Router-relative URL for a ready matching container.

The start task tools validate `robotName`, an absolute workspace-contained `cwd`, and `task`, allocate a UUID `taskId`, and return immediately. `getTaskStatusForRobot` reports queued, starting, running, completed, failed, or stopped execution together with bounded output. The three execution types are desktop, browser, and simple ALA.

Desktop and browser task startup prepares the required current tool-cache generation, creates or reuses exactly one matching GUI container, mounts the requested cwd at `/workspace`, waits for Selkies and MCP readiness, then starts ALA as a separate outer process. Simple ALA starts no GUI container. The robot home becomes ALA `--home`; task selection, model hint, coding agent, and bridge URL become explicit ALA arguments. Codex execution uses the shared cached binary with configuration from that robot home.

Take Control stops only ALA and preserves the GUI. Resume creates a new task from the original request and instructs the coding agent to observe current visible state before continuing. Desktop and browser containers have separate stop operations; stopping an ALA task never removes them.

## Decisions & Questions

### Question #1: How many execution modes may a robot own?

Response: One execution slot exists per robot. A retained GUI container continues to occupy it until explicitly stopped.

### Question #2: What identifies a robot in task tools?

Response: The exact owner-local unique `robotName`; opaque ids remain an internal HTTP and storage detail.

### Question #3: Is task execution synchronous?

Response: No. Start and stop task operations return a `taskId`; callers poll `getTaskStatusForRobot`.

### Question #4: Which state is shared with ALA?

Response: The persistent robot home supplies coding-agent configuration, the caller-selected cwd is the writable work tree shared with the GUI, and shared tool-cache generations supply executable bytes.

## Conclusion

RoboTeam combines durable agent identity, observable work, human takeover, and asynchronous ALA execution without duplicating the active robot environment.
