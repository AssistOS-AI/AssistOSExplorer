# Intermediate validation handoff

The campaign stopped at human request. No further execution is planned. This is an incomplete intermediate result, not a full-suite pass or a release-ready deployment. [validation-results.json](validation-results.json) contains 41 unique historical runs and exact artifact hashes. [benchmark-metrics.json](benchmark-metrics.json) retains the earlier UI observations unchanged.

## Frozen runtime and stop snapshot

| Item | Recorded value |
| --- | --- |
| Branch | `live-sessions` |
| Runtime Ploinky | `c4382eb49a24f06c1aa9033180719e156c916dc8` |
| Runtime Explorer | `e6ca9ebcf375cc3a780121caf753ad37440566a8` |
| Operator snapshot | 2026-10-24 19:56:47 UTC |
| G11 Box | `40d01cf850e424569a8537d785608b6c36209cb3ef40c385b3a2e0f9fe6fbe75` |
| Reported start | 2026-10-24 19:47:08 UTC |
| Reported image prefix | `46b06b0a` |
| Publications | TCP `127.0.0.1:8080`; UDP `0.0.0.0:7882` |

The operator reported the Box running, with RoboTeam, Soul Gateway and Workspace Monitor running and local-llm still starting. G11 ran no tests, final quiet check, continuation/quiet receipt or dispatcher. The bounded waiter and exact orphan process were stopped; no orchestrators remained. The deployment was left to finish natural startup. Four protected deployments were reported unchanged. These statements describe the operator's stop snapshot, not an independent acceptance check or a continuing live-state guarantee. A later documentation-only commit does not change the frozen runtime revisions above.

## Results and unresolved work

| Scope on the frozen pair | Result |
| --- | --- |
| Ten supporting cases plus Open Interpreter and web-search routing | 12 passed across earlier generations |
| W01 WebTTY | 1 failed |
| Remaining selected identities | 13 unrun |
| G11 acceptance | No results |
| Final retained-generation quartet | Not completed |
| Final current-pair/QA benchmark comparison | Not run; earlier c9 observations remain historical |

W01 failed on a GSI-button GET `ERR_ABORTED` before Router fault injection. Its cause is unresolved. Earlier assertions and cleanup observations do not turn that case into a partial pass. Historical failures and the recorded cleanup limits remain in the JSON.

G9 and G10 each passed their sole canonical semantic case, then stopped on an operational barrier. G9 retained barrier 40 after a redacted session field failed validation; its later saved-data join and delegated strict-v3/quiet proofs are separate. G10 retained barrier 40 after process gate 20, followed by a separately saved quiet check. Both dispatcher stops remain recorded as 50. Later corroboration did not replace either original HOLD or resume a test. No exact process-disappearance time is claimed.

| Unrun group | Identities |
| --- | ---: |
| `03` default-off optional-agent activation | 1 |
| `33` Umami routing | 1 |
| `07` Live Sessions and restart identities | 2 |
| `31` settings and `40` tagged meeting chat | 3 |
| Official quartet: `05`, two `30` identities, `50` | 4 |
| `m70tk` ordinary-token routing and AKU | 2 |

The last semantic plan allowed 130 seconds of process grace. The existing recovery receipt binds one submission/reply pair. `m70tk` is the case that treats `@web-search` as ordinary chat rather than launcher dispatch. AKU requires two submissions and was scheduled last. One pair cannot establish both AKU submissions; this constraint remains for any separately resumed work.

The two `07` identities still need fresh native receipt capture. Release evidence capture is automatic, but it does not substitute for the native receipt or a test pass. The official quartet must pass as four separate invocations on one final retained fresh Box generation under the unchanged 30-minute age limit.

## Timing and evidence limits

If the reported component timings of 708, 616, 255 and 294 seconds recur, they total 1,873 seconds. That exceeds the 1,800-second generation limit by 73 seconds before overhead. This is a conditional scheduling estimate, not a completed failed test. Optional-agent activation is serialized by the workspace lease; there is no supported parallel-time discount or age-rule waiver. Clarify what the 616-second OnlyOffice timing includes before comparing it with the 600-second POST wait.

Private helpers, original artifacts and the campaign checkpoint remain operator-local. The checkpoint holds exact operational commands, private input handles, helper pins and custody history. Use those preserved records for a later handoff; this publication intentionally excludes credentials, raw transcripts, private host paths and conversation identifiers. No runtime guarantees can be recovered from a summary alone. Any later campaign requires explicit authorization to resume and fresh exact-generation prerequisites.
