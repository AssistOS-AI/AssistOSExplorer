---
title: Coding Style
summary: Defines documentation, manifest, generated-config, supervision, and validation style for runtime-v5 liveKitServerAgent.
---

# DS001 - Coding Style

## Introduction

This specification is the local coding-style authority for `liveKitServerAgent`. It
covers the LiveKit runtime manifest, pinned image contract, post-attestation
configuration generation, shell supervision, private health implementation,
tests, and documentation.

## Core Content

JSON manifests use two-space indentation where the local file already does so.
Shell hooks and supervisors use portable POSIX shell patterns unless a manifest
explicitly selects another shell. JavaScript health helpers use ESM. All
documentation, specifications, and code comments are written in English.

The local source layout is contract-bearing:

| Path | Purpose |
| --- | --- |
| `manifest.json` | Pinned image, exact host-mode capability, Router services, private volumes, readiness, and derived-secret contract. |
| `scripts/generate-config.mjs` | Validates the mounted topology generation after Router authority attestation and generates fixed LiveKit, Redis, and Egress configuration. |
| `scripts/start-livekit-server-agent.sh` | Supervises required processes, enforces socket ownership, and fails closed. |
| `scripts/health/livekit-server-agent-health.sh` | Summary readiness probe used by the managed runtime. |
| `scripts/health/supervisor-health.mjs` | Detailed supervisor-only health served on the unmounted Unix socket. |
| `docs/specs/` | Authoritative DS contracts. |

Generated LiveKit, Redis, and Egress files are runtime output, not hand-authored
source. They must use the mounted immutable topology and manifest-provided
derived secrets. When the topology omits media for a local deployment, the
manifest may pass the explicit local-only `PLOINKY_MEDIA_PUBLIC_IP` or the
manifest-resolved `PLOINKY_HOST_REACHABLE_IPV4`, which deployment-time
detection normally supplies and operator configuration may replace through
normal optional env resolution; neither variable must ever override a topology
media stanza or satisfy a cross-network release gate. Generated files must not
persist topology candidates, caller assertions, long-term relay credentials, or
plaintext operator credentials. The generated
mount is non-required during host staging and is populated by container startup;
pre-attestation hooks must not receive Router locator or topology environment.

The manifest remains slim. It declares only Router access policy for
agent-port convention paths and agent dependencies; it must not contain
physical publication, UDP, edge, Cloudflare, topology, or generic
server-inventory sections. The runtime does not start a local TURN daemon, TLS
proxy, certificate process, or tunnel connector.

Validation starts with the narrowest checks that cover the edited surface:

- `find . -name '*.json' -not -path './.git/*' -print0 | xargs -0 -n1 python3 -m json.tool >/dev/null`
- `sh -n scripts/start-livekit-server-agent.sh`
- `node --check scripts/generate-config.mjs`
- `sh -n scripts/health/livekit-server-agent-health.sh`
- `node --check scripts/health/supervisor-health.mjs`

Runtime-topology changes also require the native Linux release lanes: direct
UDP on amd64 and arm64 with two browsers on distinct external networks, plus
external TURN/UDP and TURN/TLS fallback. If those prerequisites are not
available locally, record the exact blocked gate instead of weakening it.

### Decisions & Questions

#### Question #1: Why make generated config rules part of coding style?

Response:
The already-attested container startup is where the immutable topology and
derived secrets become runtime files. Treating these files as generated output
prevents stale YAML,
candidate topology, or local credentials from becoming a second source of
truth.

#### Question #2: Why validate listener ownership as well as shell syntax?

Response:
Syntax checks prove only that scripts parse. The security and publication
boundary also requires LiveKit to own UDP `7882`, administrative services to
remain private, and unexpected wildcard/control listeners to fail startup.

## Conclusion

Coding Style remains valid while changes preserve the pinned image boundary,
immutable topology input, generated-config boundary, exact listener ownership,
shell and ESM validation, release-gate expectations, and synchronized DS/HTML
documentation.
