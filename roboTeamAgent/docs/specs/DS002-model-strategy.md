---
title: DS002-model-strategy
id: DS002
status: accepted
owner: RoboTeamAgent
summary: Keeps robot persistence and graphical runtime control deterministic while reserving LLM selection for a future task contract.
---

## Introduction

RoboTeam's current robot and container control path does not require an LLM.

## Core Content

Robot creation, listing, browser or desktop start, stop, log retrieval, authorization, persistence, HTTP proxying, and WebSocket proxying work without a model provider.

RoboTeam does not hard-code providers, models, pricing, or tiers. Future LLM calls must use AchillesAgentLib `LLMAgent` with environment-derived configuration and an explicit override path. ALA invocation, retries, budgets, and routing remain unspecified.

## Decisions & Questions

1. **Decision:** No agent loop is included in this runtime revision.
2. **Question:** Model and computer-control selection belongs to a later task contract.

## Conclusion

Graphical workstation availability is independent of model availability.
