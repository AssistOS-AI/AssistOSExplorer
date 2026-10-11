---
title: DS005-admin-and-log-access
summary: Defines administrator authorization, settings validation, Ploinky log operations, rotation, and cleanup.
---

# DS005 Admin And Log Access

## Introduction

[Workspace Monitor](wiki.html#definition-workspace-monitor) exposes operational controls only to a verified administrator.

## Core Content

The tool wrapper must resolve the invocation actor from Ploinky's authenticated metadata before reading input arguments. The administrator check applies equally to current snapshot, settings, history, and log tools and may accept an admin role, the normalized local administrator username or user id, or the normalized local administrator principal id as implemented by assertAdministrator. A client-declared actor or role without verified invocation metadata must not be sufficient.

Settings must default to workspace CPU 80 percent, workspace memory 4 GiB, Router CPU 80 percent, Router memory 512 MiB, and seven days of log retention. CPU settings must be finite values from 0 through 100,000; memory settings must be positive finite values; log retention must be an integer from 1 through 365 days. Settings writes must be atomic.

The log list, get, and search tools must restrict sources to router or policy and delegate data access to Ploinky's private log service. Daily maintenance must pass the configured retention days to Ploinky and retry failures with bounded backoff. The repository does not establish a separate local log rotation implementation.

The log viewer must distinguish an in-flight first load, a successful empty result, populated records, and a fetch failure. Loading or refresh indicators must apply only while a request is pending. A successful empty live read is not evidence of a failed logger or an indefinitely loading stream. Policy Audit must explain that the current live log contains no audit events, that policy changes and errors produce records rather than ordinary read-only browsing, and that older events may be in retained archives after rotation.

The live destination must remain selectable when the list reports `active: false`, but its label must state that no active file was present at the last reload. Empty reads must continue checking for new records at a two-second interval without claiming to follow an active log. Later records must restore the populated live state without requiring a page reload; a successful empty read after rotation must stop presenting the previous live file as current.

Refreshes and Reload of the same selection must preserve useful records while a request is pending or fails. A failed refresh must visibly mark retained records as potentially stale, preserve the last successful check time, and state whether automatic retry or Reload is needed. A later successful response must clear the error. Unchanged content must not be repeatedly replaced or scrolled. Missing or malformed response content must be treated as a failure, not as a successful empty result, and raw internal errors must not be displayed.

Changing the source, archive, or search must invalidate older in-flight results. Leaving the log view or unloading the WebSkel presenter must cancel scheduled polling and ignore late responses. Archive and search views must state that live checking is paused; clearing search returns to the selected log. These presentation safeguards do not change Ploinky's file ownership, rotation, authorization, or event-generation policy.

Authorization and log ownership remain with verified runtime context and Ploinky services, while [Workspace Monitor](wiki.html#definition-workspace-monitor) owns input validation and the administrator-facing tool contract.
