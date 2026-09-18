---
title: DS004-mcp-tool-contracts
summary: Defines the gitAgent contract covered by DS004-mcp-tool-contracts.
---

# DS004-mcp-tool-contracts

## Introduction

This specification defines the active contract for gitAgent.

## Core Content

### DS03 - MCP Tool Contracts and Invocation Lifecycle

### Role of This Document

This document defines contract guarantees for Model Context Protocol (MCP) tool behavior and invocation lifecycle rules.

### Contract Surface

Tool names declared in `mcp-config.json` are public agent contracts. Contracts cover repository creation, repository inspection, branch operations, staging and restore flows, conflict handling, stash and commit flows, remote operations, identity management, and GitHub auth lifecycle operations.

`git_submodule_add` is the explicit nested-repository contract. It requires `path`, `name`, and `remoteUrl`, resolves the nearest enclosing parent repository, adds the remote at the child path, and returns canonical parent, child, and repository-relative submodule paths. GitHub HTTPS credentials may be supplied through invocation-backed auth enrichment and must never be persisted in `.gitmodules`.

Each contract shall define input schema expectations and tool identity mapping through `TOOL_NAME` semantics and dispatcher resolution.

### Invocation Lifecycle Rules

Lifecycle Rule L1: each invocation begins by reading Model Context Protocol (MCP) envelope input from stdin.

Lifecycle Rule L2: payload normalization shall handle expected MCP envelope shapes and extract effective input arguments.

Lifecycle Rule L3: argument normalization shall enforce tool-specific requirements before operation dispatch.

Lifecycle Rule L4: path arguments shall be resolved and validated against allowed roots before Git operation execution.

Lifecycle Rule L4.1: repository-executing tools shall resolve the repository deterministically from the provided path or from a path contained inside that repository.

Lifecycle Rule L4.2: repository-executing tools are not allowed to discover a substitute repository by scanning sibling directories, descendants, or workspace roots when the provided path is not inside a Git work tree.

Lifecycle Rule L4.3: repository init, clone, and GitHub-create contracts shall reject a parent path inside an existing Git worktree before creating local or remote state. Nested repositories must use `git_submodule_add`.

Lifecycle Rule L4.4: repository init and clone contracts shall reject a canonical remote already configured by another repository under the allowed workspace roots. The read-only workspace scan is permitted only as pre-mutation uniqueness validation, shall treat equivalent GitHub HTTPS and SSH URLs as one identity, and shall finish before creating the target directory.

Lifecycle Rule L5: successful operation results shall be serialized to stdout as contract output.

Lifecycle Rule L6: failures shall return explicit JSON error payloads with `ok: false`.

### Failure Semantics

Failure Rule F1: unsupported tools fail explicitly.

Failure Rule F2: missing required arguments fail explicitly.

Failure Rule F3: Git subprocess failures remain attributable with normalized error messages.

Failure Rule F4: timeout failures remain explicit and cannot degrade into silent partial success.

Failure Rule F5: submodule addition shall reject occupied targets, paths outside the resolved parent worktree, and remotes without a checkoutable commit. Failed clone targets must not remain in the worktree.

### Constraints

Constraint M1: contracts cannot depend on undocumented input payload fields.

Constraint M2: tools cannot execute operations outside validated repository paths.

Constraint M2.1: repository discovery by recursive scan is allowed only for overview and listing contracts such as `git_repos_overview`; it is forbidden for mutating or remote-executing contracts such as branch checkout, branch create, branch merge, pull, push, commit, stash, restore, and identity writes.

Constraint M2.2: `git_repos_overview` returns repository identity, branch state, aggregate change counts, and bounded samples. It does not embed complete file-change trees. Clients obtain the complete status of an expanded or selected repository through `git_status`.

Constraint M2.3: a failed quick-status operation in `git_repos_overview` marks that repository's status as unavailable. It cannot report the repository as authoritatively clean, and clients must be able to retry through `git_status`.

Constraint M2.4: the compact overview status has a 5-second subprocess deadline per repository. The detailed `git_status` operation has a separate 120-second deadline because it enumerates all untracked and matching ignored paths. The generic 20-second subprocess default does not apply to detailed status.

Constraint M3: mixed output formats for the same contract are forbidden unless explicitly declared.

### Invariants

Invariant T1: tool contract identity remains explicit through declared name and dispatch mapping.

Invariant T2: lifecycle stages remain ordered as parse, validate, dispatch, execute, respond.

Invariant T3: remote auth helpers may enrich payloads but do not redefine contract names.

Invariant T4: a failed repository resolution remains a hard failure for execution contracts and cannot degrade into a best-effort operation on another repository.

Invariant T5: loading the complete status of one repository cannot cause another repository to disappear from the workspace overview.

### Validation Criteria

Validation is satisfied when MCP clients can call declared tools with schema-compliant inputs, receive deterministic success or explicit error payloads, observe consistent lifecycle behavior across invocations, and confirm that invalid repository paths never execute against a different discovered repository.

## Conclusion

gitAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
