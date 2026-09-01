---
title: DS006-ala-task-boundary
id: DS006
status: accepted
owner: RoboTeamAgent
summary: Defines the implemented GUI runtime and reserves autonomous control for a later ALA contract.
---

## Introduction

RoboTeam provisions observable robot workstations; it does not yet execute autonomous tasks.

## Core Content

A robot retains durable identity and files. Browser and desktop containers are disposable runtimes around that state. Specialization is descriptive and grants no skills, credentials, network access, or side-effect authority.

A future controller may prefer Playwright for DOM browser work and use Pelorus for non-DOM surfaces. It must control the same visible session. Human takeover requires explicit pause/resume arbitration and fresh state inspection before continuation.

ALA schemas, scheduling, cancellation, skill repositories, model policy, CDP configuration, Pelorus API exposure, credential mounts, approvals, and artifacts remain unspecified. Current APIs imply none of them.

## Decisions & Questions

1. **Decision:** This revision implements workstation lifecycle only.
2. **Question:** Control and takeover require a separate specification.

## Conclusion

The runtime can host future control without claiming missing automation contracts.
