---
title: DS009-email-pool
summary: Defines the shared list of robot email addresses, sticky per-robot assignment, the instructions Browser and Desktop tasks receive with the address, and the administrator Emails tab.
---

## Introduction

A robot often needs a mailbox of its own for its work. RoboTeam keeps one shared list of email addresses, gives each robot one of them, and tells the robot its address. RoboTeam stores only addresses: a person signs each mailbox in to the robot's Chromium, and no password, recovery code or other credential is stored, shown or given to a robot.

## Core Content

### Pool and assignment

The list is stored in SQLite at `email-pool/email-pool.sqlite` under the RoboTeam data directory, mode `0600`, in one table `emails` holding each address, the robot that holds it and when it was assigned. Addresses are unique regardless of case and must be plain `local@domain` addresses of at most 254 characters, without spaces, quotes or angle brackets, so they can be placed in a robot's instructions unchanged.

A robot receives an address the first time it starts a Browser or Desktop task or opens a Browser or Desktop workstation. A robot without an address receives a free one chosen at random; a robot that already holds one keeps it. The assignment lasts until an administrator releases it, or the robot is deleted. An address held by a robot cannot be deleted until it is released. When no address is free, the robot works without one; unlike the proxy pool, an empty list never stops a workstation or a task.

### Instructions

Every Browser or Desktop task, including those of RoboFlow workflows, receives its robot's address in its system instructions, before the caller's own instructions. Terminal tasks work outside Chromium, where the mailbox is signed in, and neither receive an address nor assign one; neither does opening the robot's Terminal. The instructions tell the robot to use the address when its work needs one and to read or send mail through the webmail signed in to its Chromium. They forbid it to sign in, recover, verify, reset or change the password or security settings of the mailbox, and to use it to create accounts on other services unless its task explicitly asks for it. When the mailbox is signed out or asks for verification, the robot stops and asks a person. Browser and Desktop share the robot's Chromium profile, so a mailbox signed in once in either mode stays signed in for both. The workspace copilot only dispatches workflows and does not receive an address; the Browser and Desktop tasks it launches do.

### Administration

Every `/api/email-pool*` route requires an administrator after the normal signed entitlement gate: `GET /api/email-pool` returns the addresses with their robot and assignment time and the number of free addresses; `POST /api/email-pool/emails` adds up to 1,000 addresses from `{ addresses: [...] }` and reports how many were added, how many were already present and which were invalid; `DELETE /api/email-pool/emails/<id>` deletes a free address; `DELETE /api/email-pool/assignments/<robot id>` releases a robot's address, and answers 409 while the robot's workstation is running or it has unfinished tasks, because those were already told the address. The dashboard's **Emails** tab presents the same operations. **Import CSV** reads a file and **Add emails** takes pasted text; both keep only the column whose header is `email` or `e-mail`, or the first column when there is no such header, so passwords or other columns in an export are dropped in the browser and never sent to the service.
