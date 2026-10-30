# rwworker (proof-fixture worker host, slice P6b)

The worker side of the proof-fixture G7 round trip with the `rwtarget` fixture. Decision B2: a worker host composed from production `robo-work/server/` modules inside a fixture worker image counts as the T2 worker image for proof-fixture evidence; the packaged production worker agent stays a T3 deliverable. Decision B4: the mailbox seam is the native worker-side peer, `rw-target-helper worker-peer --session`. Nothing outside `tests/g7/fixture` and `tests/g7/selftest` may import these files (T1-10).

| File | Content |
| --- | --- |
| `workerHost.mjs` | Admission through the qualification store and `requireExecutionTarget`, channel epochs per A11.2 (the attempted epoch is recorded before each bootstrap; the next request is `max(attempt, accepted) + 1`), helper codes reduced to known spellings (A11.6), the TargetBinding, revalidation of the admitted binding before commit, prepare/commit/lookup over the native peer, every reply frame re-validated with `validateTargetFrame`, receipts reconciled and start outcomes classified with `receipts.mjs`. Durable fixture state in one private file |
| `fixtureMinter.mjs` | PROOF-FIXTURE stand-in for the Router mint route and for the session-key hand-over: signs tickets with the public fixture key (`native/crates/target-helper/tests/vectors/session-fixture-v1.json`). Every minted ticket is checked with the production `validateHelperTicketClaims` before it is presented |
| `main.mjs` | One step per invocation (`admit`, `define`, `prepare [--drop]`, `lookup [--lose-accepted]`, `commit [--revalidate]`, `revalidate`, `state`); prints one canonical JSON result |
| `Containerfile` | The `rwworker` image: Node 24 (the agent base Ploinky uses, by digest), the modules above, the operator record tool, the session vectors and the default static `rw-target-helper` |

## Proof-fixture departures

| Departure | Why | Production replacement |
| --- | --- | --- |
| The worker holds the ticket signing key | Ploinky delivers no per-helper-incarnation ticket secret to the helper and registers no mint route | Router mint route plus a secret handle shared only by the Router and the helper |
| Session key derived from the ticket secret (`native/crates/target-helper/src/session.rs`) | Recorded departure from T0 section 8 (amendment A11.5) | None: accepted by A11 |
| The helper runs `--proof-fixture-keeper` (launches nothing) | Keeper launch is G1 | The G1 launcher |
| The worker reaches the mailbox through an operator `podman run -v <instance mailbox>` inside the Box | Ploinky binds the mailbox only into the target, and refuses manifest volumes outside the workspace inside a Box | A worker-side mailbox bind in Ploinky provisioning |
| Source-protection, attestation and HOME facts are operator-supplied | Not produced by Ploinky for this fixture yet | Ploinky discovery and source-protection facts |
| The worker's durable state is a file, not the S1 store | Fixture scope | S1 worker state |

## Tests

`robo-work/tests/g7/selftest/rwworker.test.mjs` runs the host end to end against `rw-target-helper serve --proof-fixture-session` on the host. It needs `RW_TARGET_HELPER_FIXTURE_BIN` (a `--features proof-fixture` static build) and optionally `RW_TARGET_HELPER_BIN`; without them its tests are skipped, which is not a pass. Use a short `TMPDIR` (AF_UNIX path length).
