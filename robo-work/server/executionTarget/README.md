# robo-work execution target (generic T1, source only)

Internal, inert worker-side library for the existing-agent terminal contract: the T0 freeze plus amendments A1 to A8. It holds strict validators, refusal logic, a reservation controller over the existing S1 resource-blocker API and a deterministic journal oracle. Nothing here is imported by production code, registers a route, listener or minter, launches a process, or activates a target backend. Every production target is unavailable (`backend_not_activated`), and the default runtime (`runtimeUnavailable.mjs`) is unchanged.

## Modules

| File | Exports | Purpose |
| --- | --- | --- |
| `contract.mjs` | `canonicalTargetJson`, `targetDigest`, `parseCanonicalTargetJson`, `validateTargetBinding`, `validateQualificationRecord`, `validateInputManifest`, `validateChannelManifest`, `validateDescriptorManifest`, `validateTargetReceipt`, `validateStartOutcome`, `validateSourceProtectionRecord`, `validateSourceSelection`, `validateSourceClosure`, `validateWritableReservation`, `validateSourceOperation`, `CONTRACT_ERROR_CODES` | Canonical encoding, strict wire parsing and every document schema. Also exports small shared helpers (`asResult`, `failure`, `success`, `deepFreeze`, `canonicalText`, `digestOf`, `sha256Hex`, the `is*` primitive predicates, `utf8Bytes`, `CHANNEL_KINDS`, `RESOURCE_KINDS`, `RECEIPT_BYTES`) used only by the sibling modules |
| `limits.mjs` | `TARGET_LIMITS_V1`, `TARGET_POLICY_V1`, `INTERLOCK_LIMITS_V1`, `validateTargetLimits`, `combineTargetLimits`, `LIMITS_ERROR_CODES` | Frozen v1 ceilings in the three A1.4 scopes (A2.3 removed `retiredWorkerGenerations`), relationships checked after combination (A2.4: `3 * renewIntervalMs <= leaseTtlMs`, `dataBytesPerFrame <= bufferedBytesPerConnection`, `frameBytes >= 589824`) |
| `availability.mjs` | `requireExecutionTarget`, `projectExecutionTargets`, `AVAILABILITY_ERROR_CODES` | Pure eligibility decisions in the A1.7 precedence order, exclusion of RoboTeam and the owning worker by canonical principal, alias, stale spelling and runtime identity |
| `sourceReservations.mjs` | `createWritableReservationController`, `checkWritableSourceConflict`, `RESERVATION_ERROR_CODES` | Worker reservation sequencing over `reserveResource`, `commitResource`, `settleResource`, `listUnsettledResources`, `getResource` and `getWorkerStatus`, with an injected remote interlock |
| `journalModel.mjs` | `createTargetJournalModel`, `JOURNAL_ERROR_CODES` | Deterministic target-operation journal (the semantic oracle for a later journal implementation) plus the worker start/stop side |
| `receipts.mjs` | `reconcileTargetReceipt`, `classifyTargetStartOutcome`, `RECEIPT_ERROR_CODES` | Exact receipt reconciliation and the three start outcomes |
| `transportContract.mjs` | `validateHelperTicketClaims`, `validateTargetFrame`, `validateDescriptorTransfer`, `evaluateServiceConnect`, `TRANSPORT_ERROR_CODES` | Ticket, frame, descriptor and service-connect barrier decisions. No socket transport |

Every validator is pure and returns exactly `{ok: true, value}` (a deeply frozen copy) or `{ok: false, error: {code}}` with a code from its module's frozen enumeration. Results never carry input text, paths, tokens, exception text or descriptor handles.

## Encoding rules (shared with the Ploinky twin)

The common vector file `tests/executionTarget/fixtures/contracts-v1.json` is authored here; Ploinky keeps a byte-identical copy and runs its own implementation against it. The rules the vectors pin:

| Rule | Code |
| --- | --- |
| Encoder: a non-JSON value, accessor, non-enumerable or symbol key, class instance, sparse array, a number that is not a safe integer, `-0`, nesting deeper than 16 containers (the root is depth 1) | `invalid_request` |
| Encoder: a string with a lone surrogate, an object key that is not ASCII | `noncanonical_encoding` |
| Encoder/parser: canonical bytes over the bound (64 KiB default; closures 64 MiB; receipts and start outcomes 256 KiB, see below) | `capacity_exceeded` |
| Parser: BOM, invalid UTF-8, lone surrogate (raw or escaped), syntax error, duplicate key (detected while parsing), or text that differs from the canonical encoding of the parsed value (whitespace, key order, escapes such as `\u0041`, `\/`, `\u001F`, `\u00e9`) | `noncanonical_encoding` |
| Parser: a number with a fraction or exponent (also `1.0`), `-0`, an integer outside the safe range, nesting deeper than 16 | `invalid_request` |
| Document check order | encoding, size, then per object top-down: plain object, `version` (missing or not exactly `1`: `unsupported_version`), exact key set (`invalid_request`), then fields in declared order |
| Arrays | over the count bound `capacity_exceeded`, under the minimum `invalid_request`, unsorted or duplicate `invalid_request`; `RelativePath` over 4096 bytes, a component over 255 bytes or more than 128 components `capacity_exceeded` |
| Request digests | `requestDigest` = `targetDigest(request)`; `resourcesDigest` = `targetDigest(resources)`; a native-config `projectionDigest` = `targetDigest(entries)`; `limitsDigest` = `targetDigest({version: 1, limits, policy})` |

`validateSourceOperation(kind, value)` accepts the explicit types `reserveRequest`, `reserveResult`, `transitionRequest`, `transitionResult`, `releaseRequest`, `releaseResult`, `acknowledgeRequest`, `acknowledgeResult`, `advanceRequest`, `advanceResult`, or an operation name (`reserve`, `transition`, `release`, `acknowledge`, `advance`) whose request form is selected by its marker key (`expectedEpoch`, `expectedEpoch`, `reservationRequestDigest`, `settlementAttestationDigest`, `nextGeneration`).

`RECEIPT_BYTES` (256 KiB) is an explicitly bounded larger size under base §2 ("64 KiB unless a larger explicitly bounded manifest/frame/store size is stated"). A TargetReceipt may carry `resourcesPerOperation` = 512 resource entries (about 260 bytes each in canonical form) and `connectionsPerExecution` = 64 input cursors (about 110 bytes each), roughly 140 KiB before the fixed fields, so it cannot fit 64 KiB; a start outcome embeds one receipt. 256 KiB covers the worst case with margin and stays below `frameBytes` (576 KiB), so a receipt always fits one `receipt` or `lookup-result` frame. This choice needs recorded T0 acceptance (open item of the independent review).

A5.3: a `secretReferences` `(rootId, path)` that also appears as a closure entry is `invalid_request` (local vector SRC-09-b; the shared fixture is unchanged).

## Shapes this slice fixed where the freeze is silent

| Item | Decision |
| --- | --- |
| Transition and release results | Carry a top-level `sourceStoreIdentity` (A1.3); a transition result's must equal its record's, its record is `protected` and its epoch is `previousEpoch + 1` |
| Reserve result after release | Either the WritableReservation or the A1.5 compact tombstone `{version, reservationId, operationId, requestDigest, workerPrincipal, workerGeneration, state: "released", releaseEvidenceDigest, sourceStoreIdentity}`, discriminated by the presence of `resources` |
| `acknowledgeResult.state` | The store state after the acknowledgement: `awaiting-holder-ack` or `ready` |
| `advanceResult` | `{version, operationId, workerPrincipal, priorGeneration, currentGeneration, requestDigest}` (A2.3 names no result shape) |
| `acknowledgeRequest.priorStoreIdentities` | Sorted, unique, at most 64, never containing `sourceStoreIdentity` |
| `SourceProtectionRecord` with `protectionStatus: "unavailable"` | `enforcementDigest` and `aliasCoverageDigest` may be null |
| Closure roots | `repositoryIdentity` and `revision` may be null (image and dependency-store roots); root identities are directories |
| Descriptor manifest | The ordered descriptor entries of one frame header (an array, at most 8) |
| Channel manifest | Disabled entries carry `handler: null` and `policyDigest: null` as well |
| Release receipt operator identity (A1.2) | Not modelled: the worker controller only releases as the owning principal |
| Projection | Excluded identities are omitted, not listed |
| Admitted-binding revalidation | `requireExecutionTarget` with `admittedBinding` also takes trusted `current = {worker: {principal, runtimeInstanceId, enableGeneration, generation}, limitsDigest, journalStoreIdentity}` and source `repositoryIdentity`/`revision`, and compares every binding identity and digest: scope (`binding_mismatch`), worker identity (`binding_mismatch`), source epoch (`stale_source_epoch`), the other source fields (`source_binding_mismatch`), journal store (`binding_mismatch`), HOME compatibility (`home_incompatible`), then the qualification record digest, image, helper, contract, inventory, profile and effective-security digests and the admitted limits (`binding_mismatch`). The remaining binding fields (robot, execution, attempt, configuration revision and the grant, input, skill-view, native-config and channel manifest digests) are execution-specific and are compared with their admitted records at dispatch |

## Reservation controller

`createWritableReservationController({workerState, interlock, managementContext, identity, generationChain})`.

| Input | Meaning |
| --- | --- |
| `workerState` | An S1 `WorkerState` handle; its generation is the worker generation |
| `interlock` | Remote private operations: `describeStore`, `advanceWorkerGeneration`, `acknowledgeSourceStore`, `reserveWritableResources`, `releaseWritableReservation`, each returning the common result. A throw, a malformed answer or an unknown code is `outcome_unknown` |
| `managementContext` | The opaque verified management context, passed through unchanged |
| `identity` | `{workspaceId, boxIdentity, boxGeneration, workerPrincipal, workerRuntimeInstanceId, workerEnableGeneration}` |
| `generationChain` | A trusted read of every S1 generation row as `{id, priorId}`. The S1 public API has no `prior_id` read; a later focused delta may add one (deferred wiring point `workerState.mjs:L1420-L1558`) |

Methods: `syncStore`, `registerGeneration({operationId})`, `acknowledgeStore({operationId})`, `readiness()`, `reserve(intent)`, `recoverIntents()`, `release({operationId, reservation, evidence})`, `settleOrphanedReservation({resourceId, evidence})`, `listIntents()`.

| Rule | Behavior |
| --- | --- |
| Operation retirement (A7.2, A8.1) | Before anything else, a separate S1 blocker of kind `source-reservation-op` with locator `{operationId, sourceStoreIdentity}` is reserved. S1 never reuses a (kind, locator) pair whatever the state of the earlier blocker, so this retires the operation permanently for that store, independent of body, generation, settlement or interlock compaction. It is settled `released` as soon as the intent exists (in the same synchronous step, no await in between), so it never holds back generation recovery. A reserve whose operation is retired and has no unsettled intent refuses `operation_retired`, with no body built and no interlock call. Meaning: this operation ID can have no further effect; any reservation it produced is already released or was never created. The caller must allocate a new operation ID and must not read `operation_retired` as a reservation or as proof that one existed. Accepted liveness cost (A8.1): a failed intent write (for example the size bound) or a crash after the marker and before the first remote call retires the operation; a marker left without an intent is settled by the next retry (which refuses `operation_retired`) or by `recoverIntents` |
| Crash windows | Window A (marker durable, no intent): every retry, before or after `recoverIntents`, is `operation_retired` with zero remote reserves. Window B (marker and intent durable, marker unsettled, then a generation roll): the unsettled intent keeps A6.3, so the first retry before recovery resends the recorded body once (nothing is created; the stale intent is settled and the retry refuses `stale_generation`), and every later retry is `operation_retired`; after `recoverIntents` (outcome `settled` / `stale_generation`) every retry is `operation_retired` with no further remote reserve. Without a generation roll the window-B intent is current and the resend can legitimately complete the reservation |
| Intent (A6.1) | The S1 blocker of kind `source-reservation` with locator `{operationId, sourceStoreIdentity, markerId, request}`, where `request` is the complete canonical reserve body without `reservationId` (which is the blocker's own resource ID): generation, epoch, robot, execution, consumer and the sorted resources. It is written before the remote call. A retry or a recovery after a restart finds it through `listUnsettledResources` and resends exactly that body, never one rebuilt from the current generation or epoch. A retry whose caller fields differ from the recorded body is a local `operation_conflict` with no remote call. The S1 `requestBytes` limit must hold the largest body (64 resources, about 22 KiB); a larger body makes S1 refuse the intent, reported as `capacity_exceeded`; its marker is settled at once and the operation is retired (later retries `operation_retired`) |
| Exposure | `reserve` succeeds only with an exposable reservation: current generation, remote record and S1 commit (identity: request digest, store identity, epoch, worker generation) durable. A tombstone answer settles S1 and refuses `reservation_released`; a recorded reservation of a prior generation refuses `stale_generation` and is recovered with `recoverIntents` |
| Reconciliation (A6.3, A8.2) | `recoverIntents` first settles every unsettled operation marker locally, without the interlock and also while the store is unavailable (an unlinked one is reported `retired`), so a crashed marker never keeps the generation `recovery_pending`. It then resends every unsettled same-store intent body; while the store is unavailable intents are reported `kept` / `source_unavailable`. Recorded reservation: commit S1 when the intent is of the current generation, otherwise return it unexposed for an owner-rule release (S1 cannot commit a prior-generation blocker). Tombstone: settle `released`. `stale_generation` for a non-current intent generation, or `stale_source_epoch`: never recorded, settle `released`. `operation_conflict` on a recorded intent: keep the blocker, readiness `operation_conflict`. Transport errors and other refusals: keep and retry the same body. For a blocker created in the same call (its reservation ID never sent before), every definitive refusal, `operation_conflict` included, settles it: nothing can have been recorded under that ID (A7.1). A failure of one intent is reported as outcome `error` with its code, and the other intents are still reconciled |
| Refusals | A retry whose fields differ from the unsettled recorded body is a local `operation_conflict`; a tombstone answer for an unsettled intent is `reservation_released`; a retired operation with no unsettled intent is `operation_retired` (A8.1) |
| Release | Fresh, complete, sealed evidence with no open handle and every resource recorded in the intent body `absent`; quarantine is `resource_quarantined` and changes nothing. The reservation must match the recorded body (request digest and resources). The owning generation is the reservation's (A1.2); a superseded S1 writer is `stale_generation` before any remote call |
| Orphans (A6.4) | `settleOrphanedReservation` requires evidence for exactly the resources recorded in the intent body; unrelated, partial or extra evidence is `release_unverified` |
| Generation (A2.3, A3.1, A4) | `registerGeneration` walks the complete S1 `prior_id` chain to the registered pointer and advances with that ancestor as prior; a missing or cyclic chain is `state_corrupt` (sticky, readiness withdrawn); a pointer that is not an ancestor is `stale_generation` |
| Store identity (A1.3, A2.2) | An unsettled intent under another store identity withdraws readiness (`source_store_changed`), blocks reserve and acknowledgement, and is settled only through local verified absence; quarantine keeps it unsettled |
| Holder refusal (A3.2) | A remote `forbidden` withdraws readiness without retries until an explicit `syncStore` |
| Readiness order | `state_corrupt`, `operation_conflict` (a recorded intent whose body the interlock does not recognise), `stale_generation` (superseded S1 writer), `forbidden`, `source_unavailable`, `source_store_changed`, `generation_unregistered`, `store_unacknowledged` |

## Journal oracle

`createTargetJournalModel({journalStoreIdentity, helperIncarnation, now, limits})` is synchronous. The key is `{workspaceId, workerGeneration, executionId, attemptId, operationId}`. `effects()` lists every gated create, gate release, stop and resource release. One-shot faults: `lost-reply`, `crash-before-durable`, `crash-after-persist`, `crash-after-intent`. The worker side (`startExecution`, `requestStop`, `reconcileStart`, `workerEntry`) classifies start outcomes with `receipts.mjs`: only journal absence evidence is `refused-before-create`; an unknown start keeps a stop pending until a same-key lookup returns a receipt (the stop is then sent) or authenticated absence. A retried start whose prepare reports a released gate, or that has a pending stop, classifies the recorded receipt and delivers the pending stop; a stopped start never releases the gate. A refusal is classified `refused-before-create` only after the same-key lookup passes `reconcileTargetReceipt` (key, binding and journal store). Records are keyed only by the operation key, so `recreateHelper` never makes an old key new. It has no equivalent of the local endpoint's "nothing was started" branch.

## Confinement

Confinement of a robot process is done in Node with `/usr/bin/bwrap`; the modules live in `server/sandbox/` (`bwrapArgs`, `sandboxLauncher`, `sandboxPrep`, `protectedScan`, `seccompBpf`, `executionNetwork`, `stage.sh`, `fdTrim`). There is no native helper, keeper or FUSE file server in this tree.

## Persistence preconditions (not implemented here)

The controller-private source-protection store, its witness, lock and atomic publication (A1.3, A2.2) are Ploinky's. The journal's durable storage, fsync discipline and authenticated transport are later work. The worker's own durable state is the S1 store; this slice adds no table and does not change the schema version.

## Tests

From the repository root: `node --test robo-work/tests/executionTarget/*.test.mjs`. Every identity, key and record in them is synthetic; the source interlock in `sourceReservations.test.mjs` is an in-memory fake, not the Ploinky implementation.
