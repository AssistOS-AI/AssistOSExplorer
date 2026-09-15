# Deployment helper dependencies

Explorer's browser UUID compatibility uses `createSecureUuid` from its existing
WebSkel dependency. The implementation is maintained in the WebSkel source
repository (`utils/uuid.mjs`, exported by `index.js`) and compiled with its
locked Vite build. Only generated distributions are copied to
`explorer/shared/libs/webskel`; that directory retains the upstream MIT LICENSE.
The loader, document IDs, SCRIPTA variant/image IDs and browser DPU idempotency
keys use native `crypto.randomUUID()` or the cryptographic
`crypto.getRandomValues()` fallback. No new npm package, global installation,
runtime download, or non-cryptographic random source is introduced. Missing
secure randomness fails explicitly before an identifier is generated. Existing
IDs and prefixes are preserved. Source and update location:
https://github.com/AssistOS-AI/WebSkel; rebuild and test there before refreshing
the bundled ESM/UMD artifacts and running Explorer's tests.

The QA shutdown, recovery and Soul settings helpers add no npm packages. They use Node.js built-ins and the exact deployed Ploinky checkout. The ordinary helpers require the Node runtime already supplied by the deployment host and Box. Soul snapshot reconciliation additionally requires `node:sqlite` with `DatabaseSync` and `backup`; it fails with `SOUL_SQLITE_UNAVAILABLE` before opening a database or creating output if those APIs are absent. Use a compatible reviewed Node runtime for that optional operation. Do not install packages during recovery startup.

Recovery reuses the host's Git, Podman or Docker, sudo, GNU `cp` and `cmp`, and util-linux `flock`. The workflow also uses GNU `du` for capacity admission. These are existing deployment prerequisites. Git verifies the exact clean source revisions; the container engine verifies and controls the selected runtime; sudo preserves mixed database ownership; GNU copy preserves filesystem metadata; flock serializes host operations without leaking its lock descriptor into containers. Node filesystem copying cannot preserve all required ownership and extended metadata. Missing tools or failed commands stop the operation with a nonzero status. Install or update them through the deployment host's existing operating-system package process, then rerun admission checks before mutation.

The host distribution supplies these tools and their license notices; this repository does not vendor or redistribute them. Git, GNU coreutils and sudo retain their upstream licenses, and util-linux has component-specific licenses. Exact distribution package revisions and bundled license-file paths belong in each deployment's host inventory and are not pinned by these scripts. Container engine versions and immutable Box images remain governed by Ploinky's runtime checks. No new global installation is authorized by this document.

Existing component dependencies are documented in [OnlyOffice's dependency record](onlyOffice/dependencies.md) and [the smoke-suite dependency record](tests/smoke/dependencies.md). Soul uses SQLite's standard backup and transaction implementation rather than a custom database or WAL parser. Remove these optional recovery dependencies only when the corresponding preservation requirement is replaced and verified.
