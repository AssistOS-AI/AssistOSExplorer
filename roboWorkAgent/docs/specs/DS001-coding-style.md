---
title: DS001-coding-style
summary: Defines Node modules, bounded inputs and focused checks for RoboWork.
---

## Introduction

RoboWork follows the repository coding and runtime contracts.

## Core Content

Use Node.js 20 or later, ES modules in `.mjs`, `node:` built-ins, async/await and four-space indentation. Resolve resources from the agent root, configured data directory or workspace root. Prefer built-ins and local modules; dependency exceptions follow the repository dependency policy and require a recorded purpose, immutable version, license and update procedure. Never install a private AgentLib copy.

Tests use `node:test` and `node:assert/strict`, live beside the owning implementation, and distinguish generation checks from live namespace behavior. E2E probes exit non-zero on a missing prerequisite, missing positive control or detected isolation hole. Keep credentials and raw provider errors out of logs and artifacts. Documentation uses English, unwrapped paragraphs and declarative contracts. Update HTML and specifications together.
