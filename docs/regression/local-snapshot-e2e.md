# Local source snapshot verification

Use this mode to test an explicitly selected local candidate before committing it. Results are development evidence. Release and QA acceptance continue to require the normal clean-source verifier and their existing revision policy.

Set `SMOKE_SOURCE_VERIFICATION=local-snapshot` and `SMOKE_LOCAL_SNAPSHOT_MANIFEST` to an absolute JSON path. Keep the ordinary authoritative Playwright command, one worker, zero retries, and strict browser, persistence, and media assertions. Both `SMOKE_BASE_URL` and `SMOKE_BOX_BASE_URL` must identify the same loopback Router origin. The default verification mode is `release`; no fallback selects snapshot mode automatically.

The snapshot manifest contains exactly `kind`, `release`, and `trees`. Set `kind` to `local-snapshot-v1`. `release` uses the existing release manifest schema: the exact commits of `ploinky`, `explorer`, `achillesCLI`, and `achillesAgentLib`, plus `images.ploinkyBox.digest`. `trees` maps those same four names to their lowercase SHA-256 source-tree digests. Produce digests with `readSourceTreeDigest(repositoryPath)` from Ploinky's `tests/release/verifyLocalSnapshotBundle.mjs` after reconstructing the immutable candidate package in the selected deployment workspace.

Tree digests bind the actual bytes, paths, file types, executable modes, and symlink targets of tracked files and nonignored untracked source files. Deletions change the digest. Git metadata and ignored dependency/runtime output are excluded, as they are from the clean-source check. Enumeration, source identity, and file metadata are rechecked to detect changes during hashing. Unsupported entries and escaping symlinks fail verification.

The existing `PLOINKY_RELEASE_AGENTLIB_DIR`, `PLOINKY_RELEASE_ACHILLESCLI_DIR`, and `PLOINKY_RELEASE_EXPLORER_DIR` variables select the actual deployed checkouts. The verifier must run from the deployed Ploinky source. The collector checks Ploinky's read-only mount, the exact host workspace, AgentLib's read-only outer/nested mounts, and the source mount plus generated `/code` links of each routed runtime. It binds each inspected container to the active routing generation and compares its staged `/Agent` contents with the verified Ploinky runtime source. Mounts that hide these verified paths are rejected. A separate checkout with the same base commit is insufficient.

The active-generation probe runs inside the Box with the exact selected Router and media host ports taken from the verified live Box evidence (`PLOINKY_ROUTER_HOST_PORT` and `PLOINKY_MEDIA_HOST_PORT`), exactly as Ploinky's own bounded core exec supplies them. Ploinky's generation loader fails closed for any other physical port selection, so a probe without that environment cannot produce evidence, and missing or malformed selected ports stop the collector before any inspection.

Pre- and post-browser evidence must agree on all four repository digests, the outer Box generation, shared runtime sources, and the Explorer runtime binding. AchillesCLI may be inactive before folder launch, and launching a folder may replace its container. The post-run check requires an active AchillesCLI runtime bound to the same verified source and runtime bytes. Its container identity and generated code directory may change; its source identity cannot. This accommodates the workflow exercised by the gate without weakening its application assertions.

Preserve the base archives, binary patches, untracked source archive, package checksums, resolved dependency commits, immutable image identities, per-gate commands, browser traces, and final source verification outside the deployment directory. A failed gate retains its evidence; rebuilding a changed candidate requires a fresh fixture and a new complete set of gates. Never combine passes from different candidates.

### UserPersisto callback integration

Run the cross-repository callback regression against the selected full Ploinky checkout and shared AgentLib:

```sh
PLOINKY_REPO_ROOT=/absolute/path/to/ploinky \
PLOINKY_AGENTLIB_DIR=/absolute/path/to/achillesAgentLib \
node --test tests/integration/userpersisto-router-callback.test.mjs
```

This test uses temporary workspace state, ephemeral loopback listeners, and a controlled test clock. It exercises the real UserPersisto service, provider runtime, generic SSO bridge, and Router callback, including valid login, code expiry while browser state is still valid, account blocking between issuance and exchange, replay, and no session cookie on denial. It is a separately invoked integration regression and does not replace fresh browser E2E evidence or the live expiry checks.
