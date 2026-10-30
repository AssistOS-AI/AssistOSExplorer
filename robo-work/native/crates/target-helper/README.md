# rw-target-helper

The RoboWork target helper of plan section 5.6 ("Target helper and private descriptor seam", "Receipts, fencing and cleanup"), against the frozen T0 contract (base + A1..A9: sections 2, 8, 9 and 10). Slice P2 of `proof-target-implementation-sequence-2026-10-29_claude.md`. Dependencies: `libc` (already vendored and locked); `rw-proto` for tests only. No new third-party crate.

| Module | Content | Proven against |
|---|---|---|
| `crypto` | SHA-256, HMAC-SHA256, HKDF-SHA256, constant-time compare, strict base64url | FIPS 180-4, RFC 4231, RFC 5869 known answers; the transport corpus |
| `canon` | Canonical target JSON encoder, digest and strict canonical parser (Node refusal order and codes) | Unit tests; corpus canonical texts and digests |
| `contract` | Primitive types, `TargetBinding`, frame descriptor manifest, channel manifest | Unit tests; corpus binding |
| `ticket` | HS256 helper-ticket verification with one-use JTI/challenge replay records | `transport-v1.json` ticket; the per-scope-key audience test; lifetime, epoch, permission, header and replay refusals |
| `frame` | Frame encoder and validator (MAC before header parsing) | `transport-v1.json` frames byte for byte, every flipped byte, wrong keys, sequence, epoch, claims, ancillary facts |
| `journal` | Durable operation journal (file-backed, flock single writer whose lock-file identity is rechecked, link(2) unique key, rename updates, fsync, persisted per-resource release progress, settled-size budget) | `journal-differential.json` generated from `journalModel.mjs`; native crash, tamper, swap, lock, release-retry and budget tests |
| `mailbox` (Linux) | AF_UNIX mailbox: first-byte-only SCM_RIGHTS receive; rights after the first byte, MSG_CTRUNC or malformed control data refuse at once (reading stops, received descriptors close); bounded reads; owned descriptors | socketpair and listener tests (fd-table and queued-byte checks); binary roles |
| `keeper` | Keeper launch: `UnavailableUntilG1`; feature `proof-fixture` adds `ProofFixtureNoKeeper` (launches nothing) | Unit test |
| `service` | Journal operations gated on keeper availability: mutations refuse `keeper_unavailable` before any journal write. `TargetService::new` always runs `NoEffects`; only the `proof-fixture` build has `TargetService::proof_fixture` (`ProofFixtureNoKeeper` + `journal::FixtureEffects`: synthetic identity digests, gate release without a process) | Native test |
| `session` (slice P6b, T0 amendment A11) | Session handshake: helper challenge (two 32-byte CSPRNG values, 5 s), bootstrap (ticket and worker possession proof; the lease is the ticket's required `leaseId` claim), accepted/refused; proofs bind the claims digest, nonce, challenge, incarnation and lease; session key `HKDF-SHA256(ticket secret, SHA256(claims), "ploinky-target-session-v1")` handed to the worker by the Router with the ticket and derived by the helper after verification; feature `proof-fixture`: the public fixture ticket key | `tests/session_fixture.rs` against `session-fixture-v1.json` (node:crypto) |
| `peer` (Linux, slice P6b) | `serve_session`: handshake (channel epochs keyed on the verified `leaseId`, strictly increasing, recorded only after `accepted` was sent; at most 4096 leases per incarnation, leases idle past an execution lifetime pruned, otherwise `capacity_exceeded`), then authenticated `prepare`/`commit`/`lookup` frames against the journal, `failure` frames for refusals, close without reply for invalid frames; `WorkerSession`: the worker-side peer of decision B4 | `tests/session.rs` (socket pair), `tests/session_binary.rs`, `robo-work/tests/g7/selftest/rwworker.test.mjs` |

## Binary

| Command | Role |
|---|---|
| `rw-target-helper journal-init --root <dir>` | Provisioning (Ploinky, P3): creates the journal store in the provisioned directory under an identity minted from the kernel CSPRNG (an existing store is reported, never overwritten); prints `{journalStoreIdentity, device, inode}` for Ploinky to record. A lost journal provisioned again always gets a new identity |
| `rw-target-helper serve --mailbox <socket> --journal-root <dir> --store-identity <Id> --helper-incarnation <Id>` | Target side: opens (never creates) the journal, binds the mailbox 0600, serves. Without a ticket key no connection has a session, so every frame is refused (`frame_authentication`) and its descriptors closed |
| `... serve ... --proof-fixture-session [--proof-fixture-keeper]` | `proof-fixture` build only (a default build exits 64): every connection runs the A11 handshake with the public fixture ticket key, then authenticated frames (`peer`). Without `--proof-fixture-keeper` mutations still refuse `keeper_unavailable` before any journal write; with it the fixture launcher admits the journal round trip while launching nothing |
| `rw-target-helper worker-peer --mailbox <socket> --probe` | Worker side: connects, records the target's kernel credentials (diagnostics only), sends one probe frame with one descriptor and expects refusal and close |
| `rw-target-helper worker-peer --mailbox <socket> --session` | Worker side (decision B4): prints the challenge, reads `{op:"bootstrap", ticket, sessionKey}` from stdin (the session key never in argv or environment), then `{op:"frame", messageKind, body}` lines, printing each validated reply with its raw frame. A helper refusal is printed only as an enumerated code or `refused` (A11.6). Proof-fixture faults: `{op:"bootstrap-drop", ...}` (lost `accepted`) and `{op:"drop", ...}` (lost reply) |

A failed mailbox `connect` is `connect_refused` (missing path, permission, no listener, not a socket, anything else) or `connect_timeout`, never a journal code: nothing was sent.

Exit codes: 64 usage, 69 not Linux (mailbox roles), 75 journal or mailbox unavailable (including a refused connect), 2 session refused (worker peer), 1 other failure.

Feature `proof-fixture` (off by default): the fixture ticket key, the `serve` fixture switches and the fixture launcher. Ploinky does not yet deliver a per-helper-incarnation ticket secret to the helper or expose a mint route, so the worker-side fixture minter (`robo-work/tests/g7/fixture/rwworker/fixtureMinter.mjs`) holds the same public key: a departure from the authority model, valid only as proof-fixture evidence.

## Vectors

| File | Source | Check |
|---|---|---|
| `tests/vectors/transport-v1.json` | Byte copy of `robo-work/tests/executionTarget/fixtures/transport-v1.json` | `transport_vectors.rs` requires equal SHA-256 with the shared file |
| `tests/vectors/contracts-v1.json` | Byte copy of the authoritative common vectors (A5.5, `eb8df3e6…dbbc`) | `common_vectors.rs` replays the `canonical` and `parseRejections` sections against `canon` |
| `tests/vectors/frame-descriptor-parity.json` | Hand-written cases for header `descriptors` values (null, `{length:0}`, strings, numbers) | `frame_descriptor_parity.rs`; `robo-work/tests/executionTarget/frameDescriptorParity.test.mjs` pins the same results against Node's validator |
| `tests/vectors/session-fixture-v1.json` | `node tests/vectors/gen-session-fixture.mjs tests/vectors/transport-v1.json <out>` (node:crypto only) | `session_fixture.rs` replays the session key and proofs; `robo-work/tests/g7/selftest/rwworker.test.mjs` regenerates it and requires byte equality |
| `tests/vectors/journal-differential.json` | `node tests/vectors/gen-journal-differential.mjs <robo-work> <out>` (imports the oracle read-only) | `journal_differential.rs` replays it; `robo-work/tests/executionTarget/journalDifferentialVector.test.mjs` regenerates it and requires byte equality |

## Documented differences from `journalModel.mjs`

Coordinator decision (2026-10-29): for the phantom cursor and the chunk budget the native behavior is adopted; the oracle is to be aligned later.

| Case | Model | Native |
|---|---|---|
| Retried `prepare` of a stopped record that was never created | creates it, reports `prepared` | no create; `stopping` receipt (oracle owner disposition pending) |
| Refused `input` that opened a new connection | phantom cursor `{0, acknowledged}` | nothing persists (adopted) |
| Input chunk history | unbounded | refused (`capacity_exceeded`) once the record's projected settled size (every resource released with evidence, maximal counters and times, acknowledged cursors) would exceed the 256 KiB per-record budget, so a record can always be stopped, exited, released and retired (adopted) |
| Release hook failure part-way | not modeled | each successful resource release is persisted (no revision change) before the next; a retry calls the hook only for the rest. The hook must still be idempotent per (key, resource) |
| `stop` with a non-object request | `state_corrupt` (TypeError) | `invalid_request` |
| Stop of a `reserved` record | stop effect only if created | stop hook always called (create may have happened before a crash); idempotent |

## Not in this slice

Keeper launch through the session (G1 landed separately); concurrent sessions (one at a time, 300 s idle timeout); a worker-side mailbox bind and per-incarnation ticket-secret delivery in Ploinky provisioning; the Router mint route (the P4 minter is a library); descriptor import, stop and release over the session. Gate additions for `scripts/gates.sh` (lock set, vector identities, ELF check of `rw-target-helper`) are coordinator follow-ups.
