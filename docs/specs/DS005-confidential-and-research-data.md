---
title: DS005-confidential-and-research-data
summary: Defines the DPU-backed Confidential, Secrets, Research Data, Jobs, authorization, and provenance boundary in Explorer.
---

# DS005 Confidential and Research Data

## Introduction

[Explorer](wiki.html#definition-explorer) projects protected [DPU](wiki.html#definition-dpu) resources into the workspace while dpuAgent remains the authority for storage, authorization, audit, provenance, and external data operations.

## Core Content

[Explorer](wiki.html#definition-explorer) must expose [DPU](wiki.html#definition-dpu) virtual roots below `/Confidential`, including My Space, Shared, Secrets, Research Data, Jobs, and Audit when the [DPU](wiki.html#definition-dpu) authorizes audit visibility. These paths are not ordinary filesystem paths and must be resolved through [DPU](wiki.html#definition-dpu) tools.

Secrets must use dedicated [DPU](wiki.html#definition-dpu) secret operations and must not be treated as normal text files or sent to OnlyOffice. [Explorer](wiki.html#definition-explorer) must not expose credential values in a source configuration, resource preview, job view, log, or error. [DPU](wiki.html#definition-dpu) source configurations must retain only a secret reference.

Research Data records must preserve provider identity, exact revision, access state, intended use, permissions, provenance, and derived job outcomes. [Explorer](wiki.html#definition-explorer) may display an effective state and contextual actions, but [DPU](wiki.html#definition-dpu) alone must evaluate ACLs and perform registration, access resolution, acquisition, sharing, cancellation, and provenance retrieval.

[Explorer](wiki.html#definition-explorer) must present authorized resource provenance inline in a collapsed, expandable section of the resource preview. Expanding provenance must not replace the resource preview or require a separate navigation action.

Writable research-resource previews must expose one **Manage access** action for reviewing, granting, updating, and revoking resource [ACL](wiki.html#definition-acl) entries. [Explorer](wiki.html#definition-explorer) must not present a duplicate sharing control for the same permissions modal.

The resource-preview WebChat action must be labeled **Ask about this resource** and launch dpuAgent with only the selected [DPU](wiki.html#definition-dpu) resource identifier as contextual selection. It must not place resource metadata, file content, [ACL](wiki.html#definition-acl) data, secrets, or physical storage paths in the launch URL. dpuAgent must treat the identifier as an untrusted hint and resolve it through actor-authorized [DPU](wiki.html#definition-dpu) tools before using it.

[Explorer](wiki.html#definition-explorer) must retain the selected research resource and job identifiers in its bounded preview state until selection or directory context changes. Acquisition and access-request controls must enter a disabled busy state immediately, report that the [DPU](wiki.html#definition-dpu) operation started, and refresh the authorized resource view after the tool or confirmation flow completes. A missing selection must produce a visible bounded error rather than a silent no-op.

An acquired local resource must be consumable only through [DPU](wiki.html#definition-dpu) file-list, file-stat, and bounded file-read operations. [DPU](wiki.html#definition-dpu) must verify the invocation scope and resource [ACL](wiki.html#definition-acl) on every call, accept only paths present in the verified manifest, reject traversal and symbolic links, and omit the physical materialization path from every response.

[Explorer](wiki.html#definition-explorer) must expose a **Verify read** action for each file shown in an acquired resource's Verified Files section. The action must invoke a bounded [DPU](wiki.html#definition-dpu) file read using the selected resource and manifest-relative file path, show an immediate busy state, and report the byte count, continuation offset or end-of-file state without exposing the returned file content or private materialization path.

Federated execution controls may be displayed only when [DPU](wiki.html#definition-dpu) reports an enabled and identity-verified NVFlare backend. A proposal must resolve at least three participant resources approved for local-only federation, require secure aggregation and the [DPU](wiki.html#definition-dpu) privacy assessment, and create a protected derived output when the external job succeeds. Secure execution controls must remain hidden until a concrete backend passes its connection, identity, attestation, and policy checks.

External access, transfer, protected execution, or publication must require a [DPU](wiki.html#definition-dpu) action proposal and confirmation by its intended authenticated actor. [Explorer](wiki.html#definition-explorer) must represent pending, blocked, and failed outcomes without bypassing provider conditions. Secure and federated execution controls must remain unavailable unless [DPU](wiki.html#definition-dpu) reports an active backend capability.

Confidential and research-data features remain integrated in [Explorer](wiki.html#definition-explorer) while sensitive authority and irreversible effects stay in dpuAgent.
