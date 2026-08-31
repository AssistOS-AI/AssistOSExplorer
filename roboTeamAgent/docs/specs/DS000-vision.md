---
title: DS000-vision
summary: Defines RoboTeam as the manager of persistent specialized virtual employees and establishes the product boundary with Ploinky and AdvancedLanguageAgent.
---

## Introduction

[RoboTeam](../wiki.html#definition-roboteam) manages a team of persistent [virtual employees](../wiki.html#definition-virtual-employee). Each employee has a durable profile, domain specialization, private workspace, authenticated application state, and an interactive Linux desktop that its owner can enter.

## Core Content

RoboTeam must run as exactly one [Ploinky agent](../wiki.html#definition-ploinky-agent). [Robot profiles](../wiki.html#definition-robot-profile) are application-level records managed inside that agent and must not be represented as additional Ploinky agents, aliases, or independently published services.

Each virtual employee must have a stable identity and persistent state independent of any one desktop process or task process. A desktop shutdown must preserve the employee's metadata, home directory, browser state, [profile workspace](../wiki.html#definition-profile-workspace), downloads, and diagnostic logs.

The specialization stored in a profile must describe the employee's domain for people and interfaces. Executable specialization must come from explicitly mounted [task skills](../wiki.html#definition-task-skill) supplied through selected [task repositories](../wiki.html#definition-task-repository); descriptive specialization text must not implicitly grant code, tools, credentials, or network authority.

[AdvancedLanguageAgent](../wiki.html#definition-advancedlanguageagent) is the separate one-shot task runtime in the product architecture. Its scratch workspace must remain ephemeral, and RoboTeam's persistent profile workspace must enter a task only through an explicit mount. The ALA launch schema, task scheduler, skill selection policy, browser-control protocol, approval policy, and task result model are outside the runtime interface defined by this repository and must remain unimplemented until an authoritative specification defines them.

Ploinky owns container hosting, persistent volume attachment, user authentication, browser mutation protection, agent identity, and public routing. RoboTeam owns profile records, profile ownership, desktop process lifecycle, and the application interface. This ownership boundary prevents RoboTeam from modifying or reimplementing Ploinky control-plane behavior.
