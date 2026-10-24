# Live Sessions validation reference, 24 October 2026

This snapshot preserves UI benchmark measurements and selected live E2E results as of 2026-10-24T15:57:29.181Z, with G6 execution evidence through 2026-10-24T15:51:25Z. Validation is incomplete. The current source pair has nine passed cases, one failed case and sixteen unrun cases out of 26 selected identities. The WebTTY case has not run on this pair. Earlier results remain bound to their original source pairs and generations.

| File | Contents |
| --- | --- |
| [benchmark-metrics.json](benchmark-metrics.json) | Two saved UI observations, all three timing samples for every step, numerical summaries, browser/CPU/network measurements, provenance and the actual comparator refusal |
| [validation-results.json](validation-results.json) | Per-candidate coverage for 26 identities, seventeen recorded E2E runs, durations, outcomes, historical semantic measurements and incomplete release gates |

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

Every source pair below uses Ploinky `7c9fabdb016e81067e6a0d5bd6cf00033cf64fe0`. Current Explorer is `de32689404ca8069eb3b5830dd5deb2be2f1f33f`. The JSON preserves full historical source identities and the earlier 14:57 snapshot remains in repository history. Benchmark observations still use their original c9 source and deployment; no new benchmark has run on the current pair.

| Explorer revision | Passed | Failed | Unrun | Skipped | Cancelled | Scope |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `de326894` | 9 | 1 | 16 | 0 | 0 | Current at snapshot |
| `4cbc5236` | 0 | 1 | 25 | 0 | 0 | Historical |
| `c9e9e695` | 4 | 1 | 21 | 0 | 0 | Historical |
| `51c7f9da` | 0 | 1 | 25 | 0 | 0 | Historical |

These rows describe the same selected identities across different candidates. Their counts must not be summed. Partial progress inside a failed test remains a failure. Unit suites, discovery entries and synthetic probes do not count toward these live outcomes.

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

Generation 2 passed four official identities but was later retired. Generations 3, 4 and 5 each failed the WebTTY identity on their respective source pairs. These outcomes remain historical and provide no current-candidate acceptance credit.

Generation 6's ten canonical invocations ran from 15:48:47 to 15:51:25 UTC. Nine passed and the first GitHub identity, 61a, failed. Each invocation discovered exactly one identity, used one worker and zero retries, and recorded the same source pair, image and generation start. No runtime case skipped, retried, canceled or flaked. List-only discovery records contain empty results and a skipped label; that label is not a runtime skip. A runner preflight check is also not an additional E2E case.

The 61a assertion expected a main-frame navigation through `/auth/login`. The saved navigation array instead contains the sign-in service path followed by Explorer. The exact-directory assertion appears before the failing assertion in the saved error context. The case remains failed; this observation makes no root-cause claim. Its source body performs no token-store or fixture-creation operation.

The sequence stopped after 61a. A saved check at 15:50:46 UTC records the same Box start and image, nine running agents, three clean source records, and an HTTP 200 Live Sessions response with zero sessions. The sequence resumed with 61b at 15:50:58 UTC. The complete 61b case passed its disconnect and absent-secret/permission assertions. The complete 61c case passed with its fixture-key restoration in `finally`; no separate post-restoration filesystem snapshot was recorded. These are saved observations, not a fresh state probe.

The initial attempt at 15:48:23 UTC exited 1 because `GEN` was missing. It stopped before npm and before creation of a run artifact. It is preserved as a non-test event and is not added to the ten cases.

Default graph readiness has fifteen saved records, including nine successful declared-protocol observations. The generation started at 15:36:01.707 UTC; its unchanged 30-minute deadline was 16:06:01 UTC. All ten test invocations completed before that deadline. This does not prove later live state or optional service readiness.

The final retained-generation quartet remains pending. It requires four exact identities, each in its own invocation, on one retained fresh generation within the 30-minute age limit. Historical passes, supporting cases and the older benchmark do not close that gate. Later runs or source revisions require a dated update to this reference.
