# Live Sessions validation reference

The campaign records 21 passed identities, 4 failed and 1 unrun as of 2026-10-25T23:45:00.333Z. The final four official gates passed as separate invocations on the same G19 Box before its original 30-minute deadline, with independent cleanup verification completed at 23:33:40.237 UTC. The full suite remains incomplete and the deployment is not release-ready. The independent benchmark audit and descriptive comparison are complete.

| File | Contents |
| --- | --- |
| [validation-results.json](validation-results.json) | Current 26-identity matrix, 41 unchanged historical runs, 12 continuation runs, and the complete previous snapshot |
| [benchmark-metrics.json](benchmark-metrics.json) | Historical measurements, current QA references and three completed G19 observations |
| [HANDOFF.md](HANDOFF.md) | Remaining work and evidence limits |

## Final generation

The exact runtime pair is Ploinky `c4382eb49a24f06c1aa9033180719e156c916dc8` and Explorer `123f0a176433439f9f96cc2099b96bfb99a96d84`. G19 started at 23:05:59.601 UTC on 25 October and retained its 23:35:59.601 UTC deadline. The initial readiness HOLD remains recorded separately from the later default-nine pass and twelve-protocol readiness pass.

| Gate | Process seconds | Result |
| --- | ---: | --- |
| Copilot folder launch | 33 | Passed; process cleanup settled naturally within the normal grace |
| Public meeting loader | 19 | Passed; two rooms independently confirmed absent |
| Meeting media and chat | 25 | Passed; media evidence and room cleanup independently verified |
| OnlyOffice persistence and restart | 218 | Passed; both restarts and final document/blob/plaintext absence independently verified |

OnlyOffice recorded two raw console 403 errors. Each met the existing bounded CSRF recovery rule, one for reopen and one for cleanup-document-deletion. Both had a new-generation successful refresh followed immediately by a successful retry of the same operation. Unacknowledged errors and page errors were zero. This is not a claim of zero raw browser errors or a broader waiver.

## Remaining failures and history

W01 retains the GSI-button request-abort failure. G13 AKU failed after no reply within 420 seconds. G15 native observation failed with EACCES; its serial restart case was skipped and remains unrun. G16 optional activation failed at the STT health probe with an unresolved terminal cause. G12 passed with an operational HOLD retained separately. G17 added three passes, but two settings rooms required supported UI cleanup followed by independent absence verification. G18 Umami routing passed its actual test.

## Measurements

Three separate G19 benchmark processes each completed one iteration and ten passed steps, matching the current QA protocol. Measurements ran from 23:34:04.680 to 23:34:28.872 UTC at generation ages 1,685,079 to 1,709,271 ms. All 30 network tails completed; browser errors, warnings and HTTP 401/403 counts were zero. Each apparatus run still contains four overlapping failed/canceled request records, versus three on QA. The additional canceled request is an external background Ping POST, sequence 21, with null status. Its destination and cause are unavailable in the sanitized artifacts. Apparatus also records a 303 for /auth/login; QA does not. Failed and canceled counts overlap and must not be added.

QA deployed source and image identities are unknown. Network, server hardware, data and generation age differ. No controlled speedup claim follows. The previous measurements and strict comparator refusal remain preserved. The current strict comparator also exited 1 with `Error: Benchmark target controls do not match.` This refusal is preserved and is not a comparison pass. Independent recomputation with the frozen metrics function matched all six native reports. The descriptive summaries use three samples per cohort and interpolated p95 values; these samples do not establish statistical significance or a population tail.

The previous stopped snapshot remains under `historicalSnapshot` in the validation JSON. Its stop statements apply to 24 October, before authorized continuation. Original reports remain outside git. This publication excludes credentials, private host paths, raw logs, request bodies and conversation identifiers. Publication preparation ran no tests or live probes.

## Current descriptive timing summaries

All times below are milliseconds. Each cell gives median / p95 for three samples. The complete qualified comparison and raw report hashes are in the benchmark JSON.

| Step | QA visible | Apparatus visible | QA settled | Apparatus settled |
| --- | ---: | ---: | ---: | ---: |
| router-login-page | 2270.757 / 2581.931 | 384.425 / 1506.721 | 3028.413 / 3567.439 | 1392.581 / 1995.436 |
| login-to-explorer-interactive | 5231.100 / 5518.272 | 1547.098 / 1555.212 | 6216.153 / 6342.303 | 1826.743 / 1878.582 |
| refresh-root-listing | 561.412 / 709.220 | 201.712 / 207.364 | 990.872 / 1274.737 | 376.930 / 384.485 |
| open-workspace-directory | 618.372 / 662.126 | 217.172 / 217.233 | 1021.093 / 1249.250 | 418.437 / 419.050 |
| return-root-from-workspace-directory | 71.768 / 75.256 | 79.627 / 86.659 | 543.416 / 552.565 | 264.171 / 277.978 |
| open-confidential | 458.684 / 482.105 | 146.880 / 180.639 | 812.096 / 881.809 | 323.435 / 379.168 |
| open-confidential-my-space | 458.867 / 472.676 | 152.836 / 177.473 | 803.953 / 808.465 | 336.803 / 354.986 |
| return-root-from-confidential | 76.815 / 84.302 | 69.605 / 83.903 | 594.886 / 921.725 | 266.263 / 270.945 |
| open-workspace-file | 635.019 / 694.237 | 207.413 / 217.899 | 1161.495 / 1223.505 | 419.763 / 420.485 |
| open-git-panel | 4635.553 / 5203.964 | 1147.069 / 1200.345 | 5415.189 / 5894.741 | 1299.134 / 1351.931 |

The independent final quiet audit passed at 23:36:16.672 UTC, when the retained Box was 1,817,071 ms old, or 30 minutes 17.071 seconds. This was after the original deadline and provides no new freshness credit. It found 12 matching active registry/container tuples, pinned images, read-only code, no browser/test or lifecycle workers, no workspace lease, stable outer bindings and four unchanged protected deployments. The Box remains retained.
