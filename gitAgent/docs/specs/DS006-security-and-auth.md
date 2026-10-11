---
title: DS006-security-and-auth
summary: Defines the gitAgent contract covered by DS006-security-and-auth.
---

# DS006-security-and-auth

## Introduction

This specification defines the active contract for [gitAgent](wiki.html#definition-gitagent).

## Core Content

### DS05 - Security, Auth, and Operational Validation

### Role of This Document

This document defines mandatory operational safeguards for path policy, auth behavior, and validation routines.

### Security and Auth Scope

[`gitAgent`](wiki.html#definition-gitagent) enforces repository path safety and auth-aware remote behavior. The agent accepts tool inputs from [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) clients, validates path scope, and handles GitHub auth state via device flow and secret-backed token storage.

### Operational Requirements

Requirement O1: allowed filesystem roots shall be derived from `ASSISTOS_FS_ROOT`, `WORKSPACE_ROOT`, and `PLOINKY_WORKSPACE_ROOT` when available.

Requirement O2: repository path arguments shall be rejected when they escape allowed roots.

Requirement O3: remote Git operations shall support token propagation from auth metadata and stored token state.

Requirement O4: GitHub device flow state shall persist only under user-scoped files in `.data/gitAgent/github-auth/`, retaining the user/account filename variants, and token material shall remain in dedicated secret storage.

Requirement O4a: `gitAgent/manifest.json` shall not declare an `identity` block or DPU-specific `capabilities` or `permissions.secrets.allowedRoles`. [Ploinky](wiki.html#definition-ploinky) derives the agent principal as `agent:<repo>/<agent>`, and DPU owns the agent's secret-role ceiling via `agentPolicies` in `permissions.manifest.json`.

Requirement O4b: when [`gitAgent`](wiki.html#definition-gitagent) stores the GitHub token in DPU secret storage, it shall use a router-minted `dpuGitSecrets` user delegation, call authenticated DPU `dpu_secret_*` tools through a signed Agent Assertion, preserve user ownership on a per-routed-user secret key, and request only the concrete `read` grant needed for remote Git operations. DPU validates that requested role against the DPU-owned agent policy; if no policy exists for the caller's principal, DPU rejects the grant. Guests and out-of-band calls shall not write or delete GitHub token secrets.

Requirement O4c: authentication persistence is a hard-cut contract. [`gitAgent`](wiki.html#definition-gitagent) shall not read, migrate, delete, or alias records from an earlier state location, and DPU failures must remain fail-loud.

Requirement O4d: before every local auth-state read, temporary-file write, or rename, [`gitAgent`](wiki.html#definition-gitagent) shall revalidate the full `.data/gitAgent/github-auth` chain from the canonical workspace root. Directories, state files, and temporary files must not be symbolic links. A violation rejects with `PLOINKY_AGENT_DATA_POLICY_VIOLATION` without following or replacing the invalid path or touching retired state. File opens must not follow a last-component symbolic link.

Requirement O5: configuration and documentation shall remain aligned with `manifest.json` and `mcp-config.json`.

Requirement O6: repository validation shall run through the [Git agent](wiki.html#definition-gitagent) test suite under `gitAgent/tests`.

Requirement O7: when the manifest starts under a host sandbox runtime, startup shall fail explicitly if no Git executable is available on the host and shall tell the operator to install Git or set `ASSISTOS_GIT_BINARY`.

### Constraints

Constraint R1: introducing implicit auth dependencies outside declared environment and secret channels is forbidden.

Constraint R2: changing declared tool names is allowed only when contracts, documentation, specifications, and tests are updated together.

Constraint R3: weakening path validation behavior for convenience is forbidden.

### Invariants

Invariant G1: path-policy checks remain mandatory before Git execution.

Invariant G2: auth helpers may enrich remote execution, but they do not bypass contract-level validation.

Invariant G3: operational diagnostics remain explicit for [MCP](wiki.html#definition-mcp) consumers.

### Validation Criteria

Validation is satisfied when path escape attempts fail safely, auth workflows remain functional for configured environments, declared tools remain consistent with configuration, and the [Git agent](wiki.html#definition-gitagent) tests pass for code changes.

[gitAgent](wiki.html#definition-gitagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
