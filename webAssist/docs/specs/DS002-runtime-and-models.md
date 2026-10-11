---
title: DS002-runtime-and-models
summary: Defines WebAssist runtime loading, update sessions, and model routing boundary.
---

# DS002 Runtime And Models

## Introduction

[WebAssist](wiki.html#definition-webassist) loads skills and conversation context through the configured [Ploinky](wiki.html#definition-ploinky) runtime.

## Core Content

The runtime must keep loading, update-session, visitor, and Web CLI paths within the configured workspace and must preserve the session identity and access checks proved by the existing implementation. Model calls must use the runtime-configured LLMAgent class and the selected model tier; provider credentials remain outside browser state.

The runtime and model boundary is authoritative for [WebAssist](wiki.html#definition-webassist) session behavior.
