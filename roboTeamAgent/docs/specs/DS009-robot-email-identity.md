---
title: DS009-robot-email-identity
summary: Defines robots named by an email address, their creation from a CSV of addresses in the Robots tab, and the identity instructions their Browser and Desktop tasks receive.
---

## Introduction

A robot often needs a mailbox of its own for its work. In RoboTeam a robot owns a mailbox when its name is that mailbox's address: an administrator imports a CSV of addresses in the Robots tab, RoboTeam creates one robot per address named exactly by it, and the robot's Browser and Desktop tasks are told that this address is theirs. RoboTeam stores only the address, as the robot's name; a person signs each mailbox in to the robot's Chromium, and no password, recovery code or other credential is stored, shown or given to a robot.

## Core Content

### Email robots

A robot's email address is its name when the whole name is a plain `local@domain` address of at most 80 characters, the robot name limit, without spaces, quotes or angle brackets, so it can be placed in instructions unchanged. `server/robot-email.mjs` decides this with `robotEmailAddress(robot)`; any other name means the robot has no mailbox. Robots cannot be renamed, so a robot keeps its address for its whole life, and deleting the robot ends it. A robot created with Create robot under an address as its name is an email robot as well.

### Import

The Robots tab's **Import CSV** button, enabled for administrators, reads a file in the browser and keeps only the column whose header is `email`, `e-mail` or `email address` (case-insensitive), or the first column when there is no such header. Comma, semicolon and tab separators are recognized, surrounding quotes are removed, and repeated addresses are sent once. Passwords or other columns in an export are dropped in the browser and never sent to the service.

`POST /api/robots/import-emails` with `{ addresses: [...] }` requires an administrator after the normal signed entitlement gate and accepts 1 to 200 addresses; anything else answers 400. For each address in order, RoboTeam skips it as invalid when it is not a plain address of at most 80 characters, skips it as existing when a robot already has that name compared without case, and otherwise creates a robot named exactly by the address with the default coding agents, or the `codingAgents` given in the request, and prepares it as Create robot does. The answer is `{ ok, created: [{ id, name }], existing, invalid }`, where `invalid` lists at most 20 rejected values of at most 80 characters each. Importing the same file twice therefore creates no duplicate robots. RoboFlow coverage is refreshed once after the import when any robot was created.

### Instructions

Every Browser or Desktop task of an email robot, including those of RoboFlow workflows, receives an identity statement in its system instructions, before the caller's own instructions: it is the robot with that address and the address is its own. The instructions tell the robot to use the address when its work needs one and to read or send mail through the webmail signed in to its Chromium, where a person signs the mailbox in. They forbid it to sign in, recover, verify, reset or change the password or security settings of the mailbox, and tell it to stop and ask a person when the mailbox is signed out or asks for a password, a code or another verification.

Terminal tasks work outside Chromium, where the mailbox is signed in, and do not receive the statement; neither does opening the robot's Terminal or its WebChat conversation. Browser and Desktop share the robot's Chromium profile, so a mailbox signed in once in either mode stays signed in for both. A robot without an address receives no email instructions and works as before.
