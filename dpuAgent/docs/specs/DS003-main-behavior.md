---
title: DS003-main-behavior
summary: Defines confidential objects, scoped secrets, and controlled research processing for authenticated users and agents.
---

# DS003-main-behavior

## Introduction

[DPU](wiki.html#definition-dpuagent) lets authenticated workspace users and agents work with confidential files, secrets, and protected research data while [DPU](wiki.html#definition-dpuagent) applies the access policy for each operation.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Confidential workspace objects | Users browse and edit confidential files through Explorer without exposing a normal filesystem tree. |
| Scoped secret access | Users and authorized agents retrieve credentials through ACL-aware tools without copying secret storage into Explorer. |
| Controlled research processing | Research users consume authorized files and confirm processing jobs while participant data remains protected. |

### Confidential workspace objects

An authenticated user opens `/Confidential` or invokes `dpu_confidential_list`, `dpu_confidential_get`, or a mutation tool. [DPU](wiki.html#definition-dpuagent) resolves My Space, Shared, or the selected folder, checks the actor's access control list, and returns only visible records and permitted content. File bodies remain encrypted outside the ordinary workspace tree. Explorer must use [DPU](wiki.html#definition-dpuagent)'s returned capabilities and must not write these records through filesystem tools. [DS010-confidential-objects](specsLoader.html?spec=DS010-confidential-objects.md) defines the object and root constraints.

### Scoped secret access

A `dpu_secret_*` call must use verified invocation identity and the applicable scope and role policy. [DPU](wiki.html#definition-dpuagent) stores secret values separately from metadata and encrypts them at rest. A caller receives a value only when the secret access policy permits it; denied access must not expose that value. [DS004-secrets-model](specsLoader.html?spec=DS004-secrets-model.md) and [DS006-secrets-product-model](specsLoader.html?spec=DS006-secrets-product-model.md) govern the secret contract.

### Controlled research processing

The research [MCP](wiki.html#definition-mcp) tools validate the caller, file access, backend capability, and required confirmation before processing. [DPU](wiki.html#definition-dpuagent) owns job transitions, protected results, and provenance; Explorer presents the workflow and does not become an alternative authorization authority. [DS009-research-data-and-secure-processing](specsLoader.html?spec=DS009-research-data-and-secure-processing.md) defines the supported processing and evidence boundaries.
