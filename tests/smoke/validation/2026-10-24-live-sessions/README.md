# Live Sessions validation reference, 24 October 2026

The campaign stopped at human request. This intermediate snapshot preserves 12 passed cases, 1 failed WebTTY case and 13 unrun identities on the frozen runtime pair, plus 41 unique historical runs. The operator stop snapshot is dated 2026-10-24T19:56:47Z. No further campaign execution is planned. The full suite is incomplete and the deployment is not release-ready. See [HANDOFF.md](HANDOFF.md) for the stopped state, unresolved gates and evidence limits.

| File | Contents |
| --- | --- |
| [benchmark-metrics.json](benchmark-metrics.json) | Two saved UI observations, all three timing samples for every step, numerical summaries, browser/CPU/network measurements, provenance and the actual comparator refusal |
| [HANDOFF.md](HANDOFF.md) | Stop snapshot, frozen runtime, unresolved cases and constraints for a later handoff |
| [validation-results.json](validation-results.json) | Per-candidate coverage for 26 identities, forty-one recorded E2E runs, durations, outcomes, historical semantic measurements and incomplete release gates |

The original artifacts remain outside the repository. SHA-256 values in these files identify the source artifacts. The reference omits credentials, cookies, headers, request/response bodies, query values, account identities, private host paths, file contents and raw request waterfalls. Publication did not rerun a benchmark, login, deployment or live probe.

## UI measurements

Both observations use the clean benchmark source at Explorer `c9e9e695aedbfc584e10b1d6114282cd7d19636f`, tree `7936c54b1d9770e4d1860c0dcd42485c212c46f1`. The source schema is 2 and scenario is `explorer-ui-v1`. Each run records exit 0, three complete iterations and ten passed steps per iteration. There are no failed, skipped, cancelled or missing steps.

| Setting | QA observation | Local generation 2 observation |
| --- | --- | --- |
| UTC interval | 10:58:26.550 to 10:59:26.415 | 11:58:31.170 to 11:58:51.760 |
| Reported duration | 59,864.393 ms | 20,589.888 ms |
| Process duration | 60 s | 21 s |
| Browser controls | Chromium 148.0.7778.96, headless, cache disabled, 1440×1000 | Same |
| Client software | Node 24.22.1, Playwright 1.60.0, Chromium build 1223 | Same |
| Client platform | Linux x64, kernel 7.0.0-38-generic, 20 logical CPUs | Same |
| Client load, 1/5/15 minutes | 0.26 / 0.21 / 0.13 | 0.17 / 0.29 / 0.47 |
| Network | Remote HTTPS through the public internet and Cloudflare | HTTP loopback on the client host |
| Selected directory and file | `/AdvancedLanguageAgent`, `/test1.backlog` | Same paths, different file content |
| Server source/image | Unknown | Separately recorded Ploinky `7c9fabdb`, Explorer `c9e9e695`, selected image identities in JSON |
| Generation age | Unknown | About 40 minutes 15 seconds at benchmark start |

| Step | QA median ms | QA p95 ms | Local median ms | Local p95 ms |
| --- | ---: | ---: | ---: | ---: |
| router-login-page | 1688.401 | 2694.578 | 154.728 | 1456.784 |
| login-to-explorer-interactive | 4422.516 | 4732.201 | 1104.348 | 1265.128 |
| refresh-root-listing | 591.934 | 595.013 | 195.773 | 207.674 |
| open-workspace-directory | 586.376 | 645.328 | 222.054 | 222.081 |
| return-root-from-workspace-directory | 68.938 | 75.980 | 86.888 | 94.898 |
| open-confidential | 433.911 | 600.970 | 135.053 | 190.222 |
| open-confidential-my-space | 350.945 | 404.879 | 159.225 | 184.161 |
| return-root-from-confidential | 75.528 | 76.531 | 69.532 | 90.273 |
| open-workspace-file | 589.440 | 778.210 | 198.482 | 208.778 |
| open-git-panel | 4170.089 | 4242.275 | 1143.236 | 1144.263 |

`benchmark-metrics.json` retains each iteration's raw visible and settled duration, readiness timing details, network-tail state, request counts, failure/cancellation counts, cache hits, transfer bytes, duplicate requests and timing summaries by request category. It also retains JavaScript/layout/style/heap counters, long-task and event-timing measurements with observer availability, initial navigation metrics and web vitals. Per-step summary fields include count, minimum, maximum, mean, median and p95 wherever the original schema supplies them. Null and unavailable observer values remain distinct from zero.

The complete summaries match recomputation from the raw iterations. Independent duration calculations also match. Percentiles use linear interpolation at `(sampleCount - 1) * quantile`, then round to three decimal places. Three samples per step cannot establish statistical significance or characterize a population tail.

Git reaches `credentials-gate` in all six iterations. This measures arrival at that terminal state and does not establish authenticated repository browsing. All recorded console-error, console-warning and page-error counts are zero.

QA has 429 request records per iteration; local generation 2 has 456. QA has two login-page network-tail cutoffs, each with one active request. The local run has no cutoff. Cutoff samples do not enter settled-latency aggregates. QA records three requests per iteration marked both failed and canceled, in Explorer, DPU and Git categories. The local run records the same categories plus one external request. Failed and canceled counts overlap and must not be added as distinct failures. Their causes were not established by these artifacts.

The unchanged comparator ran on the actual two result files. It exited 1, wrote no comparison result and emitted exactly:

```text
Error: Benchmark target controls do not match.
```

The matching browser settings do not control network, server hardware, source revisions, graph, data, workload or generation age. No code-only causal or controlled regression claim follows. The local generation was about 40 minutes old, so this observation is not a fresh E2E gate. The earlier QA run at 09:39:27 UTC failed with exit 1 and zero of three iterations passed; it remains excluded.

Both selected files were reported as 20 bytes, but their contents differ. Concurrent protected deployments were present on the client host. Background-idle and file-size descriptions are operator reports. The raw result metadata contains no deployed source identity for either run. Local provenance comes from separately saved generation evidence and an operator observation; QA provenance remains unknown. The benchmark source revision is not substituted for a server revision.

## Live E2E history

G8 through G10 use Ploinky `c4382eb49a24f06c1aa9033180719e156c916dc8` and Explorer `e6ca9ebcf375cc3a780121caf753ad37440566a8`. The JSON retains full historical source identities. Earlier references remain in repository history. The benchmark file is unchanged and retains its older snapshot date and observations.

| Ploinky / Explorer | Passed | Failed | Unrun | Skipped | Cancelled | Scope |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `c4382eb4` / `e6ca9ebc` | 12 | 1 | 13 | 0 | 0 | Stopped runtime pair |
| `c4382eb4` / `a89594d2` | 10 | 1 | 15 | 0 | 0 | Historical |
| `7c9fabdb` / `de326894` | 9 | 1 | 16 | 0 | 0 | Historical |
| `7c9fabdb` / `4cbc5236` | 0 | 1 | 25 | 0 | 0 | Historical |
| `7c9fabdb` / `c9e9e695` | 4 | 1 | 21 | 0 | 0 | Historical |
| `7c9fabdb` / `51c7f9da` | 0 | 1 | 25 | 0 | 0 | Historical |

These rows describe the same identities across different source pairs and must not be summed. Partial progress inside a failed test remains a failure. Unit suites, discovery and prerequisite checks do not count toward live acceptance. A canonical test pass does not erase a separate operational HOLD.

| Run | Generation | Explorer | Outcome | Process seconds | Reporter ms | Exit |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| ls-q05-20261024T114027Z | 2 | `c9e9e695` | passed | 37 | 33112.531 | 0 |
| ls-q30-20261024T114104Z | 2 | `c9e9e695` | passed | 17 | 14713.390 | 0 |
| ls-q30media-20261024T114121Z | 2 | `c9e9e695` | passed | 21 | 19191.237 | 0 |
| ls-q50-20261024T114143Z | 2 | `c9e9e695` | passed | 219 | 216658.877 | 0 |
| ls-r3-w01-20261024T125445Z | 3 | `c9e9e695` | failed | 32 | 29527.033 | 1 |
| ls-r4-w01-20261024T133836Z | 4 | `51c7f9da` | failed | 79 | 77016.541 | 1 |
| ls-r5-w01-20261024T144931Z | 5 | `4cbc5236` | failed | 44 | 41911.556 | 1 |
| ls-r6-s00a-20261024T154847Z | 6 | `de326894` | passed | 6 | 3727.470 | 0 |
| ls-r6-s00b-20261024T154854Z | 6 | `de326894` | passed | 7 | 5310.491 | 0 |
| ls-r6-s04-20261024T154901Z | 6 | `de326894` | passed | 22 | 19836.832 | 0 |
| ls-r6-s20-20261024T154924Z | 6 | `de326894` | passed | 9 | 6452.866 | 0 |
| ls-r6-s60-20261024T154933Z | 6 | `de326894` | passed | 6 | 4275.761 | 0 |
| ls-r6-s10a-20261024T154940Z | 6 | `de326894` | passed | 13 | 10775.763 | 0 |
| ls-r6-s10b-20261024T154953Z | 6 | `de326894` | passed | 10 | 8114.589 | 0 |
| ls-r6-s61a-20261024T155003Z | 6 | `de326894` | failed | 7 | 4468.193 | 1 |
| ls-r6-s61b-20261024T155058Z | 6 | `de326894` | passed | 9 | 6543.448 | 0 |
| ls-r6-s61c-20261024T155115Z | 6 | `de326894` | passed | 10 | 7520.557 | 0 |
| ls-r7-w01-20261024T162328Z | 7 | `a89594d2` | failed | 82 | 79605.529 | 1 |
| ls-r7-s00a-20261024T162527Z | 7 | `a89594d2` | passed | 7 | 4478.586 | 0 |
| ls-r7-s00b-20261024T162534Z | 7 | `a89594d2` | passed | 8 | 5872.512 | 0 |
| ls-r7-s04-20261024T162542Z | 7 | `a89594d2` | passed | 23 | 20500.743 | 0 |
| ls-r7-s20-20261024T162605Z | 7 | `a89594d2` | passed | 9 | 6948.401 | 0 |
| ls-r7-s60-20261024T162615Z | 7 | `a89594d2` | passed | 7 | 5182.780 | 0 |
| ls-r7-s10a-20261024T162623Z | 7 | `a89594d2` | passed | 14 | 11838.322 | 0 |
| ls-r7-s10b-20261024T162637Z | 7 | `a89594d2` | passed | 10 | 8308.013 | 0 |
| ls-r7-s61a-20261024T162648Z | 7 | `a89594d2` | passed | 8 | 6024.864 | 0 |
| ls-r7-s61b-20261024T162656Z | 7 | `a89594d2` | passed | 10 | 7902.993 | 0 |
| ls-r7-s61c-20261024T162707Z | 7 | `a89594d2` | passed | 10 | 8847.153 | 0 |
| ls-r8-w01-20261024T182924Z | 8 | `e6ca9ebc` | failed | 97 | 94663.995 | 1 |
| ls-r8-s00a-20261024T183132Z | 8 | `e6ca9ebc` | passed | 7 | 4465.087 | 0 |
| ls-r8-s00b-20261024T183139Z | 8 | `e6ca9ebc` | passed | 8 | 5911.386 | 0 |
| ls-r8-s04-20261024T183147Z | 8 | `e6ca9ebc` | passed | 23 | 20632.001 | 0 |
| ls-r8-s20-20261024T183211Z | 8 | `e6ca9ebc` | passed | 9 | 7009.889 | 0 |
| ls-r8-s60-20261024T183220Z | 8 | `e6ca9ebc` | passed | 7 | 4760.614 | 0 |
| ls-r8-s10a-20261024T183227Z | 8 | `e6ca9ebc` | passed | 14 | 11847.045 | 0 |
| ls-r8-s10b-20261024T183242Z | 8 | `e6ca9ebc` | passed | 10 | 8513.844 | 0 |
| ls-r8-s61a-20261024T183253Z | 8 | `e6ca9ebc` | passed | 8 | 6015.930 | 0 |
| ls-r8-s61b-20261024T183301Z | 8 | `e6ca9ebc` | passed | 10 | 8015.446 | 0 |
| ls-r8-s61c-20261024T183312Z | 8 | `e6ca9ebc` | passed | 10 | 8667.466 | 0 |
| ls-r9-m70oi-20261024T185813Z | 9 | `e6ca9ebc` | passed | 129 | 126680.202 | 0 |
| ls-r10-m70ws-20261024T193143Z | 10 | `e6ca9ebc` | passed | 175 | 171883.622 | 0 |

All earlier records remain unchanged. G2's four official passes belong to a retired generation. G3, G4 and G5 each failed WebTTY. G6 recorded nine supporting passes and one failed navigation assertion. G7 recorded ten supporting passes and a late WebTTY diagnostic mismatch. G8 recorded ten supporting passes and a WebTTY GSI request-abort failure before Router fault injection. Its incomplete cleanup attachment and later exited-session observation remain distinct. The G8 semantic baseline HOLD is not a test outcome.

G9's sole Open Interpreter routing case passed, but its original barrier returned 40 after a redacted session field failed validation. The dispatcher stopped with reported exit 50. Saved-file joins and separately delegated strict-v3/quiet observations corroborate completion without replacing that original HOLD. The JSON preserves all phase timings, proof limitations and the distinction between its pre-run quiet receipt and later verifier observation. No earlier introduction is treated as a regression baseline.

G10's sole web-search routing case passed with wrapper/inner exit 0, one test and zero skips/retries/flakes/errors. It ran from 19:31:43 to 19:34:38 UTC: 175 process seconds, 171,883.622 reporter milliseconds and 169,779 actual test milliseconds. Its exact generation started at 19:16:25.475 UTC, with unchanged deadline 19:46:25 UTC.

The saved v3b barrier receipt contains a bound captured-tab/attempt/message join, metadata-helper exit 0 with completed status, and lifecycle-helper exit 0 with outcome `end`. The retained diagnostic snapshot and result hashes match the receipt and join. The process gate then returned 20 with nine processes, seven of seven baseline members, zero native-agent/active-turn counts and one unknown process. The barrier remained HOLD with exit 40 and the dispatcher stopped with reported exit 50. The ordinary-token routing case, m70tk, and the AKU case did not run.

| G10 observed phase | UTC timestamp | Interval from preceding listed phase |
| --- | --- | ---: |
| Before submit | 19:33:19.267 | Not applicable |
| Execution start | 19:33:19.412 | 145 ms |
| Engine active-finish | 19:34:36.880 | 77,468 ms |
| Execution finally | 19:34:36.902 | 22 ms |
| Reply pair observed | 19:34:37.533 | 631 ms |

The wall-clock before-submit to reply-pair interval is 78,266 ms. The engine's recorded elapsed value at active-finish is 77,467 ms. These distinct values describe one attempt and support no controlled regression claim.

A separate saved read-only check at 19:39:54.679 reports exit 0, unchanged exact Box/start pins, eight processes, seven of seven baseline members and zero native-agent/active-turn/unknown counts. It did not replace the original HOLD or resume a test. The reviewer subsequently bound the earlier unknown process to the recorded turn and identified the source's normal 120-second grace. That process-role explanation is delegated reviewer/source evidence. The exact disappearance time was not observed and is not inferred.

The campaign is now stopped at human request. At 19:56:47 UTC, the operator reported G11 running on the same runtime pair, with local-llm still starting and no G11 tests, final quiet check, continuation/quiet receipt or dispatcher run. The bounded waiter and exact orphan process were stopped; no orchestrators remained. The deployment was left to finish natural startup, and four protected deployments were reported unchanged. This is an operator snapshot, not new acceptance evidence or a live-state guarantee. The final retained-generation quartet, final current-pair/QA benchmark comparison and thirteen unrun selected identities were not completed. No further campaign execution is planned; details are in [HANDOFF.md](HANDOFF.md).
