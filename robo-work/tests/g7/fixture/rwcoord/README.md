# rwcoord (proof-fixture authenticated target admission, slice P7)

The coordinator side and the worker-side admission front of the proof-fixture G7 admission. A coordinator reaches the worker only through Ploinky's signed coordinator hop: the coordinator agent calls the worker's declared coordinator route on the private Router listener with its private agent assertion, the Router admits exactly the declared coordinator principals and forwards a provider-audience Router Request (tool `__coordinator_admission__`). The front verifies that request with the production `server/coordinatorAuth.mjs`, derives the operation from the verified coordinator and the origin request ID, and decides with the production `requireExecutionTarget` against the worker-owned qualification store. Nothing outside `tests/g7/fixture` and `tests/g7/selftest` may import these files (T1-10); `tests/g7/driver.mjs` only runs them as commands.

| File | Content |
| --- | --- |
| `admissionFront.mjs` | `createAdmissionFront`: hop verification and replay burn, exact body `{version, originRequestId, selection, surface?}`, `deriveTargetOperationId` (the S1 rule over `coordinator:<principal>` and `target-admission`, or `owner:user:<id>` with verified owner evidence), recorded-admission replay and `operation_conflict`, a durable intent written before the count (a retry after a lost admission record is evaluated without its own counted slot, so it is never charged twice; the store's `consumeExecution` stays authoritative for the budget; the intent is removed once the admission is recorded and, when the store refuses the count, only an intent that this request wrote (nothing was counted by it); a pre-existing intent, one left after a failed record write, and any intent after an `io_error` are kept, since an earlier attempt may have counted), front-owned facts (mode, request, worker half, qualification facts, mandatory exclusions), the decision, durable counting (`consumeExecution`) and the admission record. `serveAdmissionFront`: the loopback HTTP listener |
| `front.mjs` | `serve`: the front process inside the worker container (worker identity and per-agent secret from the Ploinky environment; the secret is never printed). `observe`: read-only count, admission records and leftover intents for the driver |
| `coordinator.mjs` | `admit`: one admission request through the Ploinky private Router (Ploinky's own descriptor loader and assertion signer from `/Agent`), or through the LOCAL stand-in. `operation-id`, `origin-id` |
| `localRouter.mjs` | LOCAL stand-in for the coordinator hop (self-tests and `driver.mjs` local runs only): declared-caller check and a real HS256 Router Request; the caller arrives unauthenticated in a header, so local results are never live evidence. Excluded from the image build context; a live driver configuration that names it is refused |
| `facts.mjs` | Operator tool: base facts variants (`facts-base`, `facts-ploinky-source`, `facts-unprepared`, `facts-no-source-unprepared`), the canonical proof-fixture record whose operation IDs are derived from the coordinator and the admissible origins, and the plan with LIVE/FIXTURE labels |
| `render-manifests.mjs` | Operator tool: the worker manifest (executionProvider with one coordinator route on port 7301, callers exactly the coordinator; start = the front), the coordinator and an undeclared agent |
| `Containerfile` | `rwp7`: the rwworker image by digest plus the server tree and this directory without `localRouter.mjs` (the build fails if it is present) |

## Trust split

| Fact | Source |
| --- | --- |
| Coordinator principal, owner evidence | The verified hop only (`caller` = `actor` = `sub`, declared coordinator) |
| Operation ID | Derived from the verified hop and the rch-bound `originRequestId`; never taken from a body |
| Selection, Environment surface | rch-bound request content |
| Worker principal, runtime instance, enable generation | The Ploinky environment of the worker container |
| Worker generation | Operator (`--worker-generation`; FIXTURE) |
| Exclusions | The front: RoboTeam (`agent:AchillesIDE/roboTeamAgent`), the owning worker by principal and runtime instance, the verified coordinator (RoboTeam's stand-in); base facts may add aliases and identities, never remove these |
| Qualification facts | The worker-owned store, re-read for every request |
| Mode | Front configuration (`proof-fixture`; `production` refuses every fixture record) |
| Discovery entries, HOME, attestation digests, source facts | Operator base facts (LIVE-observed or FIXTURE, labelled by `facts.mjs`); with `sourceState: {provider: "ploinky"}` the source record comes from Ploinky's source-protection `state` operation |

## Proof-fixture departures

| Departure | Why | Production replacement |
| --- | --- | --- |
| Coordinator-alone admission row (`target-admission` origin key) | A Router-minted owner grant needs a user session that a headless task Box does not have; A10 names only coordinator, operation and time window. Owner evidence, when present, is still verified and selects the coordinator-API row | T3 Environment-aware admission in `coordinatorAdapter.mjs` |
| A target-admission decision, not an S1 admission | No S1 schema change in this slice | T3 |
| The front is a separate fixture process from the rwworker host | The rwworker host is another slice's writer scope; the front records the admitted operation ID for it | The packaged worker agent (T3) |
| Discovery entries, HOME, effective-security and channel digests, most source facts are operator-supplied | No Router discovery caller, source-fact provider, enforcement evidence or priorInventories stage exists yet | Ploinky discovery and source-protection facts |
| Hop replay cache in memory | Same limitation as `coordinatorAuth.mjs`; a restart forgets consumed jtis, the operation ID keeps retries idempotent | Durable token replay (S1) |

## Tests

`robo-work/tests/g7/selftest/rwcoord.test.mjs` (front in process and over HTTP, real HS256 tokens) and `robo-work/tests/g7/selftest/driver.test.mjs` (the driver against separate front, stand-in Router and coordinator processes). Neither needs a helper binary; nothing is skipped.
