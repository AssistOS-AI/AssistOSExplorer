---
title: DS000-vision
summary: Defines Workspace Monitor as an administrator-only view of Ploinky workspace resources, history, and logs.
---

# DS000 Vision

## Introduction

[Workspace Monitor](wiki.html#definition-workspace-monitor) must give an administrator a reliable view of workspace and runtime resource use while preserving Ploinky ownership of live metrics and logs.

## Core Content

The agent must collect CPU and memory observations from Ploinky, persist bounded history, and expose the results through its configured MCP tools. Explorer may provide the administrative entry point, but the agent remains responsible for authorization, settings, persistence, and operational results.

[Workspace Monitor](wiki.html#definition-workspace-monitor) must remain administrator-only. The repository does not establish a public browser API or direct agent-port contract for monitoring data.

[Workspace Monitor](wiki.html#definition-workspace-monitor) is an operational companion to Ploinky, not an independent source of runtime authority.
