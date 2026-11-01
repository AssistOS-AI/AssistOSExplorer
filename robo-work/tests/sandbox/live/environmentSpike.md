# Environment image feasibility spike

`environmentSpike.mjs` is a test-only S1–S5 harness for the approved Environment image plan. Run it as root inside a **new task-owned Linux spike worker** created by the coordinator, with the exact frozen source mounted read-only. It does not start Explorer, invoke a model, enable Environment admissions, or change product code. The existing r10 deployment and its pause process are outside its scope.

| Probe | Evidence and verdict |
| --- | --- |
| S1 | Anonymous TLS-verified public digest pull into a fresh on-disk graphroot, exact-labelled create, mount, immutable image ID, Created/configured state, and exact cleanup. The container object is never started. |
| S2 | Existing supervisor, launcher, prep, execution netns, socket stdio, resource locators, skills and masks. Only workload `/usr` and bin/sbin/lib/lib64 come from the mounted image. Orchestration and endpoint retain the worker view. All five capability sets must be zero, NNP=1, seccomp=2, and util-linux `unshare -U /usr/bin/true` must actually run and refuse with EPERM. A same-identity worker sentinel must remain alive before and after the probe and be absent from the private procfs scan. Missing tools, loaders, incomplete output or scan failures fail the probe. |
| S3 | Worker and workload UID/GID maps. Missing workload evidence is BLOCKED. |
| S4 | Own cgroup resolution, cgroup2 mount options, controllers, subtree control, internal process count, bounded empty-child limit writes/readback, and child absence. No process moves, controller enablement, chmod or remount. Failure directs the coordinator to the already approved Q-E4a delegation follow-up. |
| S5 | Alternative B only: crun `run`, `--ipc=none`, automatic user namespace, disabled cgroup management and one preserved descriptor; record actual private procfs and descriptor observation. OBSERVED_FAILURE is an acceptable finding about the unchosen alternative, not success of that alternative. |

S2 proves read-only `/usr` and library feasibility plus P-CAP/P-NS only. It does **not** prove writable top-level E5, injected tools, L-1 final acceptance, P-FD/P-MASK/P-NET acceptance, crash recovery or per-workload cgroup enforcement. FD links, skills and masks are supporting observations only.

## Candidate and invocation

On the Mac source checkout, `node robo-work/tests/sandbox/live/environmentSpike.mjs --freeze` emits Explorer's HEAD commit/tree, binary tracked dirty diff SHA-256, and content hashes of every worker server file and live harness file, including untracked files. Preserve the full binary diff and untracked files with that manifest. Assemble this envelope outside Git; all four repositories require exact commit, tree and tracked dirty diff SHA-256:

```json
{
  "schemaVersion": 1,
  "repositories": {
    "Explorer": { "commit": "<40hex>", "tree": "<40hex>", "diffSha256": "<64hex>", "files": { "robo-work/server/main.mjs": "<64hex>", "...": "..." } },
    "Ploinky": { "commit": "<40hex>", "tree": "<40hex>", "diffSha256": "<64hex>" },
    "CIB": { "commit": "<40hex>", "tree": "<40hex>", "diffSha256": "<64hex>" },
    "ALA": { "commit": "<40hex>", "tree": "<40hex>", "diffSha256": "<64hex>" }
  },
  "workerImage": {
    "reference": "localhost/robo-work-environment-spike:task",
    "id": "sha256:<64hex>",
    "baseReference": "docker.io/assisto/worker@sha256:<64hex>",
    "archiveSha256": "<64hex>"
  },
  "boxId": "<64hex>",
  "workerContainerId": "<64hex>"
}
```

The worker spike overlay may be locally built and need not be published. The coordinator verifies the running worker container's image ID against `workerImage.id`, records its exact build sources/CIB diff and saved image archive hash, and inserts exact Box/worker IDs. Those external identities are coordinator attestations; the harness verifies the mounted source content hashes, not the host's container identity. Environment `--image` alone must be a public fully qualified digest reference. Hashes must be regenerated when candidate bytes or commits change.

Inside the new spike worker, invoke with argument values supplied by the coordinator:

```sh
node /opt/robo-work/tests/sandbox/live/environmentSpike.mjs \
    --image docker.io/library/debian:bookworm@sha256:<exact-public-digest> \
    --workspace env-spike-task \
    --reservation <32-lowercase-hex> \
    --candidate-manifest /evidence/candidate.json \
    --output /evidence/fresh-run
```

The output directory must not exist. The store is fixed at `/var/lib/robo-work/environment-spike/<workspace>-<reservation>/storage`, below an existing non-tmpfs persistent worker bind. The runtime path is a fresh `/run/rwes-<reservation-prefix>`. No arbitrary graphroot or existing resources are accepted. The harness emits exactly five final JSON records on stdout and writes `S1.json` through `S5.json`, `commands.jsonl`, `resource-journal.jsonl` (append before each resource creation), and `resource-journal.json`. Preflight errors after candidate validation produce failed/blocked records. Malformed CLI or candidate identity is refused before resource creation. Exit zero requires S1–S4 PASS and no cleanup quarantine; S5 retains its observational verdict.

Cleanup checks exact container names and all three labels before removal by immutable container ID; mount absence is checked from real mountinfo. The supervisor proves its processes and views absent, and S4 removes only its empty child. Every reserved network locator is independently recovered and verified through the real execution-network module, including reservations whose setup threw before the supervisor retained its handle. Netns files, both veth names and the nft table must be absent; failed/unknown inspections or deletion of a known-present part produce quarantine. Exact cleanup is repeated once. Any unknown cleanup error remains a failure even if the retry succeeds, and `quarantine.json` preserves identities for recovery. The on-disk image store is retained as evidence; the coordinator may remove that exact task store after checking the records. No prune, reset, broad deletion or unrelated image removal is used.

## Prerequisites and offline checks

The harness adds no npm dependencies. Node built-ins and existing worker sandbox modules are used. Existing worker tools (`bwrap`, `setpriv`, `unshare`, `mount`, `umount`, `nsenter`, `ip`, `nft`, `/usr/local/bin/node`) remain prerequisites. The test-only CIB overlay supplies pinned Podman, containers-common, crun, conmon and fuse-overlayfs; record their versions in the CIB build evidence. Podman runs with a fixed PATH, argument arrays, a fresh HOME and empty registry auth file, with no inherited registry/proxy credentials. No startup download occurs except the explicit S1 digest pull.

The selected image must contain working `/bin/sh`, `/usr/bin/env`, util-linux `/usr/bin/unshare`, and `/usr/bin/{true,cat,readlink,tr,grep,ls,wc}` with their libraries. Slim images may lack unshare; that is a prerequisite failure requiring a suitable public digest, not proof of refusal. CIB's pinned dependency/OS license inventory remains authoritative; this harness redistributes no external runtime. Remove these test-only prerequisites when the spike is retired.

```sh
node --check robo-work/tests/sandbox/live/environmentSpike.mjs
TMPDIR=/tmp node --test robo-work/tests/sandbox/environmentSpike.test.mjs
```

These offline tests use synthetic Podman results to attack wrong labels, uncertain absence, failed removals and repeat cleanup. They also test CLI refusal, altered source manifests, non-executed unshare, capability failures and a stale/visible sentinel. They create no actual container, namespace, mount or cgroup; Linux S1–S5 remains a separate coordinator-owned run after independent review.
