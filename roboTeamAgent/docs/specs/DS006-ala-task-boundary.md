---
title: DS006-ala-task-boundary
summary: Defines the stable virtual-employee specialization model and the separate contract boundary for ALA tasks, task repositories, and desktop automation.
---

## Introduction

The RoboTeam product direction assigns one-shot work to specialized virtual employees through [AdvancedLanguageAgent](../wiki.html#definition-advancedlanguageagent). This specification prevents profile and desktop code from guessing the task contract before that integration is defined.

## Core Content

A [virtual employee](../wiki.html#definition-virtual-employee) must retain durable identity and work files in RoboTeam while ALA retains ownership of ephemeral task sandbox creation and destruction. The [profile workspace](../wiki.html#definition-profile-workspace) must be the durable filesystem boundary shared with a task, and ALA scratch state must not become the user's desktop workspace.

[Task repositories](../wiki.html#definition-task-repository) must be selected explicitly for a task. Their mounted [task skills](../wiki.html#definition-task-skill) provide executable domain specialization. The profile specialization field remains descriptive metadata and must not automatically select repositories, grant network access, or authorize side effects.

An ALA task must mount only the selected profile's approved persistent directories and task repositories. It must not receive the RoboTeam data root or another profile's directories. Authentication directories, browser-control endpoints, and task capabilities require individual allowlisting rather than a broad profile-root mount.

The task request schema, lifecycle states, queueing, cancellation, logging, result persistence, skill-repository resolution, ALA command arguments, environment allowlist, authentication-directory mounts, and concurrency policy are unspecified. RoboTeam must not expose a task-start interface until those contracts are defined and verified against ALA.

The interactive desktop and task sandbox are separate runtimes. Browser reuse, Chrome DevTools Protocol access, Playwright integration, screenshot-based Computer Use, human takeover, input locking, side-effect confirmation, and publication authority are unspecified. The profile desktop must remain human-controlled until a separate specification defines and secures those behaviors.

Any LLM interaction introduced for task management must comply with `DS002-model-strategy.md` and use AchillesAgentLib `LLMAgent` through runtime configuration with manual override support. The profile and desktop control paths must remain deterministic and available without an LLM.
