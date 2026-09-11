---
title: DS002-runtime-v5
summary: Defines control and editor route access, service readiness, topology generations, and managed storage.
---

# DS002 Runtime V5

## Introduction

OnlyOffice [Runtime-v5](wiki.html#definition-runtime-v5) runs the pinned image behind two [Router](wiki.html#definition-router) targets and a manifest-defined persistent storage layout.

## Core Content

When enabling OnlyOffice in Marketplace, the administrator must select `global` runtime mode so the editor can access workspace files.

Explorer must leave `onlyOffice` disabled by default. An administrator can enable it through Marketplace using Ploinky lifecycle controls; the same runtime, readiness, and authorization contracts apply after enablement.

The control route at /base-agent-additional-server/onlyOffice/7000/control/* must require authenticated access. The editor route at /base-agent-additional-server/onlyOffice/8080/* must be public only for the declared editor transport. The manifest must not create a physical-host publication.

Startup readiness must verify the exact configured nginx alias, the distinct byte-identical 105:107 and 0644 copies, the [::1]:8000 DocService listener, callback storage, and the expected [DocumentServer support services](wiki.html#definition-support-services), addresses, and process ownership. Recurring liveness may use bounded loopback HTTP checks after activation.

The default DocumentServer launch must resolve the bundled wrapper relative to the agent module and pass its absolute path directly to `/bin/bash`. It must retain the caller's working directory and must not depend on that directory containing the agent source or load a login shell to locate the wrapper. Paths containing spaces or shell metacharacters must remain literal arguments. An explicit `command` option or non-empty `ONLYOFFICE_DOCUMENT_SERVER_COMMAND` retains the existing `/bin/bash -lc` shell-command behavior; an empty environment value selects the bundled default.

Readiness must also require completion of the current DocumentServer bootstrap. The pinned vendor script starts supervisor and nginx before font generation, whose final steps restart DocService and the converter. The wrapper must await successful font generation and static compression before publishing completion immediately before the final log tail. It must preserve each awaited child's failure status, run those phase scripts with their declared shell's error-exit option so a later successful command cannot hide a failed step, and reject an unknown vendor bootstrap layout before executing it. A fixed delay or the first successful HTTP response cannot establish bootstrap completion.

Before starting services, the wrapper validates the pinned static-compression script's two ordered find/gzip commands. It replaces their per-file execution terminators with batched execution, retaining the selected assets, font paths, compression options, original files, configuration steps and nginx reload order. Batched find execution propagates a failed gzip child's status, which shell error-exit alone cannot detect with the vendor's per-file form. Missing, changed, duplicated, reordered or additional gzip commands must fail startup before services run.

Bootstrap state lives in the process-owned, non-persistent `/run/onlyoffice-agent-bootstrap` directory, with mode 0700 and atomic regular 0600 files. Each wrapper start invalidates prior readiness and creates a new nonce bound to its PID, Linux process start time and kernel boot ID. Completion must match that current startup and a live process; malformed files, unsafe ownership or permissions, symlinks, PID reuse, a changed startup or an exited process must fail closed. The wrapper retains its PID across execution of the patched vendor script. Readiness checks the barrier before and after the existing runtime attestation and requires the same startup nonce in both checks, even if a replacement startup has already completed. It requires nginx's proxied DocService `/healthcheck` response to contain exactly `true`. Existing JWT, nginx configuration, address and socket-owner checks remain mandatory.

Controlled shutdown must stop new control and editor admission, force-save each writable session whose source document DocumentServer actually requested, and await its durable callback acknowledgement before stopping DocumentServer. Issued control configurations that DocumentServer never consumed are not live editors and must not enter the callback wait set. The wrapper and its foreground helpers must run in a dedicated process group so one SIGTERM reaches the complete foreground tree. After the authoritative application drain, the wrapper may notify DocumentServer's loopback cluster-inactive endpoint, but the notification must have a two-second total timeout and must not extend the agent beyond Ploinky's clean-exit bound.

Each session must resolve the current immutable [topology generation](wiki.html#definition-topology-generation) and store an atomic guarded 0600 state file under the persistent work directory. Bundled service data remains image-owned; only exact guarded service paths may receive ownership or mode preparation.

## Conclusion

The runtime contract makes service activation and session generation explicit and fails closed when the expected pinned topology is not present.
