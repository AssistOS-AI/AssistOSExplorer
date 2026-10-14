---
title: DS003-main-behavior
summary: Defines the essential user outcomes and hidden safeguards that make Explorer the integrated AchillesIDE workspace.
---

# DS003 Main Behavior

## Introduction

AchillesIDE enables a workspace user to work with files and agent-owned resources through one authenticated [Explorer](wiki.html#definition-explorer) application.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Workspace navigation and editing | Users browse workspace or virtual resources, select a compatible preview, and edit only through the owning storage contract. |
| Agent-owned workflows | Users reach domain workflows through runtime plugins while the owning agent preserves authorization and state. |
| Persistent terminal management | Administrators reattach to shells after closing a view or signing in again, watch other owners' shells and confirm Kill while Ploinky enforces ownership and lifetime. |
| Protected runtime access | [Ploinky](wiki.html#definition-ploinky) and [Explorer](wiki.html#definition-explorer) preserve router-authenticated access and workspace confinement for every essential path. |

### Workspace navigation and editing

The affected user is a workspace operator who needs to inspect and change files without leaving the [Explorer](wiki.html#definition-explorer) shell. A directory selection or URL route triggers `file-exp`, which resolves the selected filesystem or virtual [DPU](wiki.html#definition-dpu) path, lists it, and selects a preview or editor appropriate to the resource. The observable result is a coherent file, document, media, or Confidential workflow. [Explorer](wiki.html#definition-explorer) must preserve the distinction between normal workspace paths and agent-backed virtual resources; it must not write a virtual resource through the ordinary filesystem tools. As a hidden safeguard, a history navigation (hash change, Back, Forward) that arrives while [Explorer](wiki.html#definition-explorer) is still mounting the same page joins that mount instead of mounting a second copy, so the loading indicator never outlives the page change; a `file-exp` page that a newer navigation replaced during bootstrap stays inert and leaves the newer location in the address bar. Bootstrap also re-reads the address when the page root is set, so a navigation made while [Explorer](wiki.html#definition-explorer) was still loading opens the page the user navigated to last instead of being lost. Such a navigation is adopted only if it names a configured component; a runtime-plugin page or an unknown hash keeps the startup route.

Ordinary workspace file management also allows users to download a file unchanged or save a folder as a ZIP without leaving the current shell state. [Workspace operations](specsLoader.html?spec=DS010-workspace-operations.md) defines the protected transfer and private-data exclusions. This extends workspace file handling, not the authority of agent-backed virtual resources.

### Agent-owned workflows

The affected user is a workspace operator who needs Git, [DPU](wiki.html#definition-dpu), task, [SOPLang](wiki.html#definition-soplang), media, meeting, or other enabled domain actions in the same application. [Runtime plugin](wiki.html#definition-runtime-plugin) discovery starts from enabled `IDE-plugins/*/config.json` bundles and the [Explorer](wiki.html#definition-explorer) `applicationPlugins` policy controls which application plugins can mount. The observable result is a contextual control or settings surface that calls the owning agent. For research data, this includes verified file consumption and confirmed federated jobs whose raw participant data remains local. [Explorer](wiki.html#definition-explorer) must preserve the boundary that domain authorization, state, and mutation remain with the owning agent; [DPU](wiki.html#definition-dpu) remains responsible for every file-read [ACL](wiki.html#definition-acl) check, backend capability decision, confirmation, job transition, protected result, and provenance event.

### Persistent terminal management

An administrator starts a shell through Open Terminal Here and manages existing shells through [Live Sessions](wiki.html#definition-live-sessions) in the toolbar. Closing a terminal tab, closing the embedded view or ending a login only detaches viewers, so the owner can sign in again and reattach from another tab or device. The tool lists shells, embeds a view, opens an isolated pop-out tab and confirms Kill. It never creates a shell. Other administrators can watch and Kill; only the owner can type or resize. [Ploinky](wiki.html#definition-ploinky) enforces these permissions, a 24-hour idle timeout and a seven-day absolute lifetime. A decided owner demotion ends their shells at their next authenticated browser request, and Router restart ends all shells. Fresh single-use attach tokens remain in component-built URL fragments, never query strings, browser storage or resumable modal descriptors. The observable result is a workspace shell the owner can revisit without keeping a browser view open, within Ploinky's process lifetime.

### Protected runtime access

The affected user is any authenticated workspace participant. Starting [Explorer](wiki.html#definition-explorer) through [Ploinky](wiki.html#definition-ploinky) creates the router-mediated application path; [Explorer](wiki.html#definition-explorer) obtains allowed roots from its server-side configuration and guards browser restoration against an unauthenticated session. The observable result is that normal workspace functionality remains available only through the configured runtime boundary. Administrators can enable and disable optional capabilities through Marketplace on the local control origin or a configured public application origin. [Ploinky](wiki.html#definition-ploinky) validates the selected application's administrator session and exact-origin mutation proof before changing agent state. The hidden safeguard is server-side path and invocation validation, which prevents a browser selection or client payload from expanding filesystem or identity authority.

The product succeeds when users can complete workspace work through [Explorer](wiki.html#definition-explorer) while each domain agent remains the authority for its own protected operations.
