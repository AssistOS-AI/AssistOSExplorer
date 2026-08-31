---
title: DS002-model-strategy
summary: Defines the delegated model-selection strategy and the conditions that govern LLM interaction inside RoboTeam.
---

## Introduction

RoboTeam's profile and desktop control path is deterministic and does not require an LLM. Model selection belongs to the separate task-execution boundary rather than the profile manager.

## Core Content

Profile creation, profile listing, desktop start, desktop stop, authorization, persistence, and WebSocket forwarding must execute without an LLM. A model outage or provider configuration failure must not prevent an owner from opening or stopping a profile desktop.

RoboTeam must delegate task-model selection and model tiers to [AdvancedLanguageAgent](../wiki.html#definition-advancedlanguageagent) runtime configuration. RoboTeam must not hard-code provider names, model names, pricing assumptions, or a duplicated tier catalog in profile metadata, the Ploinky manifest, the desktop service, or task skills.

Any LLM interaction introduced inside RoboTeam must use AchillesAgentLib `LLMAgent`. The caller must supply runtime configuration with an explicit manual override path in addition to environment-derived defaults. The selected model tier and task metadata must be observable through non-secret run metadata, while credentials and raw provider tokens must remain outside logs and persisted task artifacts.

Model routing must carry metadata tags for the relevant work class, including documentation, specification work, orchestration, bootstrap, and testing. Domain specialization must be represented through mounted [task skills](../wiki.html#definition-task-skill) and task context, not by silently changing the model or provider.

The concrete ALA invocation schema, available model tiers, provider mappings, retry policy, budgets, and fallback behavior are unspecified at this repository boundary. RoboTeam must not implement or imply those behaviors until the ALA integration contract supplies them.
