---
title: DS003-main-behavior
summary: Defines the essential user outcomes and hidden safeguards that make Explorer the integrated AchillesIDE workspace.
---

# DS003 Main Behavior

## Introduction

AchillesIDE enables a workspace user to work with files and agent-owned resources through one authenticated Explorer application.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Workspace navigation and editing | Users browse workspace or virtual resources, select a compatible preview, and edit only through the owning storage contract. |
| Agent-owned workflows | Users reach domain workflows through runtime plugins while the owning agent preserves authorization and state. |
| Protected runtime access | Ploinky and Explorer preserve router-authenticated access and workspace confinement for every essential path. |

### Workspace navigation and editing

The affected user is a workspace operator who needs to inspect and change files without leaving the Explorer shell. A directory selection or URL route triggers `file-exp`, which resolves the selected filesystem or virtual DPU path, lists it, and selects a preview or editor appropriate to the resource. The observable result is a coherent file, document, media, or Confidential workflow. Explorer must preserve the distinction between normal workspace paths and agent-backed virtual resources; it must not write a virtual resource through the ordinary filesystem tools.

### Agent-owned workflows

The affected user is a workspace operator who needs Git, DPU, task, SOPLang, media, meeting, or other enabled domain actions in the same application. Runtime plugin discovery starts from enabled `IDE-plugins/*/config.json` bundles and the Explorer `applicationPlugins` policy controls which application plugins can mount. The observable result is a contextual control or settings surface that calls the owning agent. For research data, this includes verified file consumption and confirmed federated jobs whose raw participant data remains local. Explorer must preserve the boundary that domain authorization, state, and mutation remain with the owning agent; DPU remains responsible for every file-read ACL check, backend capability decision, confirmation, job transition, protected result, and provenance event.

### Protected runtime access

The affected user is any authenticated workspace participant. Starting Explorer through Ploinky creates the router-mediated application path; Explorer obtains allowed roots from its server-side configuration and guards browser restoration against an unauthenticated session. The observable result is that normal workspace functionality remains available only through the configured runtime boundary. Administrators can enable and disable optional capabilities through Marketplace on the local control origin or a configured public application origin. Ploinky validates the selected application's administrator session and exact-origin mutation proof before changing agent state. The hidden safeguard is server-side path and invocation validation, which prevents a browser selection or client payload from expanding filesystem or identity authority.

## Conclusion

The product succeeds when users can complete workspace work through Explorer while each domain agent remains the authority for its own protected operations.
