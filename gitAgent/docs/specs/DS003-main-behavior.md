---
title: DS003-main-behavior
summary: Defines repository work in Explorer and authenticated Git operations within validated workspace paths.
---

# DS003-main-behavior

## Introduction

The [Git agent](wiki.html#definition-gitagent) lets workspace users inspect repository changes and perform Git operations from Explorer. It owns repository semantics, subprocess execution, and credential access.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Repository work through Explorer | Users inspect changes, stage files, commit, synchronize, and resolve conflicts from the workspace shell. |
| Authenticated repository operations | Users perform repository operations with server-side credentials and validated target paths. |

### Repository work through Explorer

Opening the Git toolbar or a Git menu action supplies the current Explorer directory to the agent. The plugin loads repository state and calls the declared `git_*` [MCP](wiki.html#definition-mcp) tools; after an operation, Explorer refreshes the affected view. Adding or cloning inside an existing worktree must use explicit submodule mode, which stages `.gitmodules` and the gitlink without an automatic commit or push. [DS009-git-explorer-plugin](specsLoader.html?spec=DS009-git-explorer-plugin.md) defines plugin ownership and detailed interaction rules.

Commit and Commit & Push preserve the user's selected files and draft while awaiting complete repository status, then stage, commit and push in order. A remote check with no incoming commits does not pull or stash. No-op and failed commits retain the user's input, and the panel reports success only for operations that completed. These safeguards make the selected Git workflow reliable even while the repository tree loads independently; the detailed selection and completion rules belong to [DS009-git-explorer-plugin](specsLoader.html?spec=DS009-git-explorer-plugin.md).

### Authenticated repository operations

Each invocation enters through `tools/git_tool.sh` and `tools/git_tool.mjs`, validates arguments and workspace roots, then dispatches the selected Git operation. Remote operations use verified authentication context or authorized stored credentials; token persistence remains server-side in DPU Secrets. The browser must not own Git execution or persistent token state. [DS004-mcp-tool-contracts](specsLoader.html?spec=DS004-mcp-tool-contracts.md) and [DS006-security-and-auth](specsLoader.html?spec=DS006-security-and-auth.md) define the operation and authorization boundaries.
