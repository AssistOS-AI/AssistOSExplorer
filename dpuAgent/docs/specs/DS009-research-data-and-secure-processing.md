---
title: DS009-research-data-and-secure-processing
summary: Defines the dpuAgent contract covered by DS009-research-data-and-secure-processing.
---

# DS009-research-data-and-secure-processing

## Introduction

This specification defines the active contract for dpuAgent.

## Core Content

### DS09 — Research Data, Secure Processing and Federated Learning

Storage and API follow a clean-break model: only `dpu-research-v1` state and `dpu-permissions-v2` are accepted. A legacy root is rejected and is never imported, converted, or read through fallback logic.

### Unified model

The private DPU root owns `users`, `secrets`, `confidentialObjects`, `resources`, `sources`, `computeBackends`, `jobs`, `actionProposals`, `provenanceIndex`, and `settings`. Research data is represented by records, not folders. Materialized files live under `materializations/<resource-id>/<revision>` and are projected through `/Confidential/Research Data`.

Resources carry provider identity, exact revision, persistent identifier, licence, citation, FAIR evidence, access conditions, intended use, owner/ACL/expiry, checksums, file manifest, restrictions, jobs and derived results. `executionMode`, `accessState`, and `visibility` are independent; `effectiveState` is the UI projection.

### Authority and confirmation

Invocation authentication is the only actor source. Source records contain `secretRef`, never credentials. dpuAgent authorizes secrets, confidential objects, resources and protected results. External effects require an immutable, expiring `DpuActionProposal` bound to its intended actor.

### Jobs and provenance

Jobs cover discovery, access, acquisition, transfer, remote execution, secure execution and federation. Provider work runs outside the storage lock. Local acquisition uses private per-job staging, streaming downloads, provider SHA-256 verification when available, cancellation checks and atomic publication. A completed EDC transfer becomes local only when the provider returns an authorized HTTP(S) data-plane address and DPU streams that content into staging, computes its SHA-256 checksum, and publishes it atomically; a completed control-plane transfer without deliverable data remains remote. Interrupted local workers are closed and their own staging is removed; EDC and compute operations remain recoverable through bounded polling. File locks record their owner PID and acquisition time and may be recovered only when the owner is no longer alive. Provenance is append-only and separate from audit, correlated by IDs.

### Adapters and surfaces

Adapters declare capabilities and implement connection test, discovery, description, access resolution, acquisition and citation. Hugging Face resolves refs to commit SHA and handles public/private/gated datasets without accepting terms automatically. Its discovery adapter translates recognized language intent into Hub filters, expands the provider candidate pool, and ranks normalized candidates by language, text modality, and declared size category before applying the caller's result limit. A request for a small dataset therefore uses provider size metadata rather than treating `limit=1` as a size filter. EDC maps catalog and ODRL facts and separates negotiation from transfer; a transfer is never projected as local merely because the remote operation was accepted. Manual registration accepts only `local` and `manual` providers and cannot set adapter-owned revision, access, checksum, materialization, locality, or provider facts. MCP uses `dpu_resource_*`, `dpu_source_*`, `dpu_research_*`, `dpu_compute_*`, `dpu_federated_*`, `dpu_secure_*`, `dpu_job_*`, and `dpu_action_*`, with invocation scopes and redacted audit records. Explorer projects Research Data and Jobs and provides administrator Data Sources settings.

Locally materialized files are consumed through `dpu_resource_file_list`, `dpu_resource_file_stat`, and `dpu_resource_file_read`. Every call requires resource `read`, applies the dedicated invocation scope when the router supplies a scope, accepts only manifest-relative paths, rejects traversal and symbolic links, and omits the private materialization path. Reads return at most one MiB per base64 chunk with explicit offsets and end-of-file state.

The Explorer surface is implemented with WebSkel runtime components and the Explorer design system. Resource and job views reuse shared cards, buttons, status badges and action groups; confirmation and permission changes reuse the standard modal components. Data Sources separates Hugging Face and EDC with the shared settings tabs, filters each provider into its own panel, and opens a provider-specific inline form only for add or edit. Its dialog keeps a stable viewport-relative size while tab content scrolls internally and uses Explorer's standard fullscreen icon and `is-fullscreen` convention. Secret selection reuses `custom-select`; source type is fixed by the active provider panel and is never accepted from a user-editable control. Component-local CSS is limited to DPU-specific structure and responsive layout. The standard Explorer Tools menu exposes the initial `DPU Research` WebChat launcher even when Research Data is empty. The resource preview exposes a contextual **Ask about this resource** launcher that supplies only a validated DPU UUID; the CLI retains it as an untrusted selection hint and every resource lookup still passes actor authorization. The WebChat manifest enables the router envelope, borrows Explorer SSO through `webchat.auth: "static"`, and requests a per-user router runtime through `webchat.runtimeScope: "principal"`. The CLI verifies the router request token against the exact `__webchat_message__` envelope, including the signed `runtimeScope: "principal"` field, before deriving the actor, and pins its process to the first verified user principal. One user's WebChat output and history never reach another user, and DPU ACL decisions are the same as on the MCP path. The raw token is never placed in the LLM context. The conversational planner exposes the exact research tools declared by `mcp-config.json`; their handlers and normal MCP dispatch share one authorization, validation, audit and domain execution path. Model input cannot provide an actor identity. The CLI preserves workspace directory, presentation visibility and explicit workspace references as agent context. WebChat mode consumes each newline-delimited envelope as it arrives on the long-lived runtime pipe; it must not wait for end-of-file between turns. The internal `/tasks` discovery command is handled locally with an empty WebChat task list because DPU Research does not expose Achilles background tasks. No slash command is forwarded to the research LLM. If the provider returns empty planner content after a completed search, the CLI returns the already authorized DPU search result deterministically instead of discarding it. Other failures receive a bounded safe error, emit only a redacted diagnostic category, do not terminate the loop, and do not block later requests; failures for invisible control messages remain silent. End-of-file input remains limited to one-shot CLI and MCP execution. The source forms expose only adapter fields supported by the implemented contracts: Hugging Face endpoint and secret reference, or EDC endpoint, counter-party address, provider ID, participant ID and secret reference.

DPU planner tool arguments use a strict nested contract: the planner decision is Markdown, while its `prompt` section contains exactly one fenced `json` block whose content is one JSON object. No raw JSON, prose around the block, untyped fence, array or malformed JSON is dispatched. The decoded object still passes the normal tool input validation and invocation authorization. Provider-specific discovery uses the bounded `providerTypes` selector. A research planner may supply `sourceIds` only as exact DPU source UUIDs obtained from a prior DPU result; provider types, display names and guessed identifiers are never accepted as source IDs.

Planner input rejection is recoverable without weakening validation. A rejected Markdown or argument payload is returned to the planning loop as a structured `recoverable` result, so the next decision receives the validation reason and bounded retry instructions. When `sourceIds` contains a recognized provider label, DPU removes it from the UUID field, converts it to the server-validated `providerTypes` selector, and executes the corrected search once without another model turn. Unknown labels remain recoverable and perform no provider operation. Provider selectors only filter sources that are enabled and authorized by DPU and never become source identity or authorization.

### Compute backends

Compute-backend records use DPU `secretRef` values and remain disabled until an administrator runs a successful connection and identity test. Non-administrative callers see only enabled and connected backends, without secret references or backend-private settings.

The NVFlare adapter uses the pinned NVFlare 2.8.1 FLARE API through a private Python JSON bridge. Its secret supplies the admin identity, startup-kit path, template root, and study. Administrator-controlled template IDs resolve beneath that template root, and job submission uses a DPU job idempotency key. A federated proposal must name at least three accessible resources whose adapter-owned facts require `executionMode=federated`, `localToParticipant=true`, and `rawDataExportAllowed=false`. Secure aggregation and a passing privacy assessment are mandatory. Confirmation submits the job, polling maps terminal state, cancellation reaches NVFlare, and successful completion creates a protected derived model with participant and job provenance. Output release requires its own `release-output` confirmation.

The secure broker accepts decisions only from an installed backend adapter and configured identity, attestation, and provider-policy checks; caller booleans are not authority. `dpu_secure_execution_propose` fails closed and Explorer hides `Run Secure` when no verified secure backend is available. A provider adapter must implement test, submit, status, and cancellation before it can participate in the generic DPU job lifecycle.

### Deployment

Stop dpuAgent, resolve the exact environment storage, archive or remove it by explicit operator decision, and start with an empty root. Recreate source configurations and secret references, then run health and end-to-end tests. No code automatically deletes or migrates storage.

## Conclusion

dpuAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
