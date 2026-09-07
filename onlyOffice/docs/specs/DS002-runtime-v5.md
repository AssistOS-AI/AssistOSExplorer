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

Controlled shutdown must stop new control and editor admission, force-save each writable session whose source document DocumentServer actually requested, and await its durable callback acknowledgement before stopping DocumentServer. Issued control configurations that DocumentServer never consumed are not live editors and must not enter the callback wait set. The wrapper and its foreground helpers must run in a dedicated process group so one SIGTERM reaches the complete foreground tree. After the authoritative application drain, the wrapper may notify DocumentServer's loopback cluster-inactive endpoint, but the notification must have a two-second total timeout and must not extend the agent beyond Ploinky's clean-exit bound.

Each session must resolve the current immutable [topology generation](wiki.html#definition-topology-generation) and store an atomic guarded 0600 state file under the persistent work directory. Bundled service data remains image-owned; only exact guarded service paths may receive ownership or mode preparation.

## Conclusion

The runtime contract makes service activation and session generation explicit and fails closed when the expected pinned topology is not present.
