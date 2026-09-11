# OnlyOffice runtime dependencies

Static compression uses the pinned image's existing GNU find and gzip. The wrapper validates both vendor compression commands before services start and uses batched find execution to propagate gzip failures. Tests exercise the host find and gzip commands, including filenames with spaces, and verify compressed bytes with Node.js zlib. No new package or installation step is required.

The agent package declares no third-party npm dependencies. The bootstrap completion helper uses only Node.js built-ins (`crypto`, `fs`, `path` and `url`) and Linux procfs. It adds no package, service, image layer or installation step. Tests use the built-in Node.js test runner.

The supported environment remains the immutable OnlyOffice agent image selected by `manifest.json`. Its existing Node.js, Bash, awk, curl, iproute2 and DocumentServer components supply the startup and readiness commands. The bootstrap helper requires Linux process statistics and the kernel boot ID; absent or malformed data fails startup/readiness before completion can be published. The wrapper rejects a changed vendor startup layout before running it. An incompatible image requires rebuilding and validating the existing image contract, rather than downloading software at agent startup.

The image and its bundled dependencies are an inherited deployment dependency, not a new dependency introduced by the readiness fix. Their component versions, licenses and notices remain those of the pinned image; this file does not claim a new independent license audit. Change the manifest digest only through the existing image publication and runtime acceptance procedure. DocumentServer cannot be removed while this agent provides Office editing; the bootstrap barrier can be simplified if a future validated vendor image exposes an equivalent process-bound completion contract.

The test fixtures additionally use the existing host Bash and `mkfifo` commands to hold bootstrap phases until explicitly released. They do not use a timing delay as readiness evidence and install nothing on the host.
