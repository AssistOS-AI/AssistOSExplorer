# Explorer Box Environment Contract

Explorer manifests own product configuration and secrets only. Edge topology,
publication, target addresses, and browser locators are box-owned runtime state.

| Consumer | Required runtime input | Source |
| --- | --- | --- |
| Media topology consumers | `PLOINKY_EDGE_TOPOLOGY_FILE` | Read-only unversioned generation mounted by Ploinky |
| Managed private callers | `PLOINKY_INTERNAL_ROUTER_URL` | Fixed private Router listener selected by network class |
| Browser-facing plugins | Authenticated `/api/edge/topology` projection | Current active one-service locator, `Cache-Control: no-store` |
| WebMeet control | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Shared generated secrets |
| WebMeet data | `PLOINKY_WEBMEET_MASTER_KEY` | Agent-scoped generated secret |
| OnlyOfficeAgent/onlyOffice | `ONLYOFFICE_JWT_SECRET` | Shared generated secret |
| Umami | database/application secrets in its manifest | Agent-owned generated secrets |

Consumer code must resolve topology for each operation that produces or uses a
locator. It must reject unknown schema, inactive publication, stale generation,
missing service, and malformed external relay configuration. No agent may
derive a hostname from its id, use a private listener as a browser URL, or use
environment fallback for edge topology.

External Cloudflare connector/API credentials and external TURN long-term
secret are Ploinky-core operator inputs. They are not Explorer repository
variables and are never copied into consumer environments. TURN consumers
receive only short-lived credentials from the private broker after exact
generation ACL and assertion validation.

The managed-bridge private lane is currently unavailable on the observed
rootless Podman host-gateway topology and remains fail-closed pending the
Ploinky DS004 Question #8 architecture decision. Consumers must not substitute
the public listener, a direct target, a widened bind, or startup environment
when `PLOINKY_INTERNAL_ROUTER_URL` is unavailable.
