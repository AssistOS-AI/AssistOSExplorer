---
title: DS008-proxy-pool
summary: Defines how RoboTeam leases one proxy per robot from the optional proxyAgent, the direct-connection fallback, the exit-address locale, the credential-holding loopback relay, and the managed Chromium policy for Browser and Desktop workstations.
---

## Introduction

Robot browsers can reach the internet through proxies instead of the host's own address. The shared pool of proxies, its provider accounts and its administration page live in the separate Ploinky agent `proxyAgent` (repository `PloinkyProxies`), so other agents can draw proxies from the same pool. RoboTeam is one consumer: it leases one proxy per robot workstation and keeps everything that touches the robot's container here.

## Core Content

### proxyAgent and the lease

proxyAgent stores the accounts, proxies, assignments and exit-address locales, seals provider configuration and proxy credentials with its own generated secret, synchronizes the providers, and serves the administration page. Its design is in its own README. It exposes three MCP tools tagged `internal`, so only agents can call them, each through the Router with a signed Agent Assertion:

| Tool | Answer |
| --- | --- |
| `proxy_lease { subject, label? }` | `{ active: false }`, or `{ active: true, proxy: { id, scheme, host, port, username, password, country }, locale: { timezone, locale, lang } }`; an active pool with nothing free answers `{ ok: false, status: 409 }`. |
| `proxy_release { subject }` | `{ released }`. |
| `proxy_assignments { subjects? }` | The proxy each subject holds, without credentials. |

proxyAgent keys every assignment by the Router-verified caller principal and the subject, so RoboTeam's subjects are its robot IDs and no other consumer can see or take them. RoboTeam sends the robot name as the lease's `label`, which proxyAgent only displays. `server/proxy-pool/proxy-client.mjs` calls these tools through Ploinky's `AgentMcpClient`; the agent name defaults to `proxyAgent` and can be changed with `ROBOTEAM_PROXY_AGENT`.

proxyAgent is optional. RoboTeam's manifest does not enable it, and robots must work without it. When proxyAgent is not installed, is unreachable, answers anything but a lease, or its pool is inactive, the workstation starts with a direct connection, as when no account exists, and the service logs a warning. The pool is inactive while no enabled or draining account lists a proxy. Only an active pool with nothing free stops the start, with HTTP 409, before any container is created.

### Use Proxy

**Use Proxy** is one global setting for every robot, not a per-robot one. It is stored in `/data/proxy-pool/settings.json` as `{ "useProxy": true | false }` and is on by default; a missing or unreadable file reads as on. While it is off, RoboTeam asks proxyAgent for no lease and every Browser or Desktop workstation starts with a direct connection, the service's `UTC` timezone and no locale, exactly as without proxyAgent. Turning it off releases nothing, so each robot gets its reserved proxy back when the setting is turned on again. The change takes effect at each workstation's next start; a running workstation keeps its relay until then. `GET /api/robot-proxies` returns the setting as `useProxy`, and `PUT /api/proxy-settings { useProxy }` changes it; both require an administrator. The dashboard shows the **Use Proxy** checkbox in the Robots heading only to administrators and only while proxyAgent is reachable, and marks a held proxy as not used while the setting is off.

### Assignment

The assignment rules belong to proxyAgent and are unchanged. A robot keeps its proxy while that proxy is available, has not failed its last check, and belongs to an enabled or draining account whose credentials were not rejected, so websites see a stable address across sessions. Otherwise the robot receives the free usable proxy of an enabled account with the highest priority, preferring the account with the fewest assigned subjects, then the oldest account, then address order. Draining accounts keep their robots but receive no new ones.

While Use Proxy is on, every Browser or Desktop workstation start asks for a lease before any container is created. A robot's lease is released when the robot is deleted, without waiting for proxyAgent. A lease left behind because proxyAgent was unreachable is released the next time the dashboard lists robot proxies. An administrator can also release it from the robot's **⋮ → Release proxy** while the workstation is stopped. Changes to accounts and assignments take effect at the robot's next workstation start; a running workstation keeps its relay.

### Relay and container network

For a proxied workstation RoboTeam starts one `ProxyRelay` on a random outer loopback port. The relay accepts CONNECT tunnels and absolute-form plain HTTP requests, removes hop-by-hop and client proxy headers, and forwards them to the upstream proxy with its `Proxy-Authorization`. An upstream refusal or failure reaches Chromium as 502, which Chromium reports as a tunnel failure. The container is started with `--network pasta:-T,3128:<relay port>`, so its loopback port 3128 reaches only that robot's relay and no other outer loopback service. The relay closes when the container is removed by stop, replacement, failed start or shutdown. A retained workstation is reused only when its proxy is the one the robot currently holds and its locale still matches that proxy's exit address.

Chromium cannot answer proxy authentication by itself, which is why credentials stay in the relay. RoboTeam receives them only in the lease answer, keeps them in memory, and never puts them in container arguments, environment, files or logs. Both GUI images ship Debian-packaged Chromium, so RoboTeam mounts the managed policy `/etc/chromium/policies/managed/roboteam-proxy.json` read-only from `/data/proxy-pool/chromium-proxy-policy.json`. The policy fixes `ProxySettings` to `http://127.0.0.1:3128` and sets `WebRtcIPHandling` to `disable_non_proxied_udp`. It applies to the Browser image's own Chromium used by Playwright MCP through CDP, to Chromium opened on the Desktop, and to any later Chromium start, and it cannot be changed from the browser. Other Desktop programs are not proxied. Coding agents and ALA run in the outer container and are never proxied.

The lease also carries the locale of the address the proxy presents, which proxyAgent resolves. When the proxy has no recorded exit address, an exit check discovers it. A geolocation lookup of that address runs through the same proxy, never from the host's own address, and is cached by the exit address. The lookup supplies the IANA timezone. The language comes from a fixed map of the reported country code, or of the provider's country when the lookup gives none, to one locale shipped by both GUI images; an unmapped country uses `en_US.UTF-8`. An unreachable proxy, an unreadable answer or an invalid timezone yields `UTC` and `en_US.UTF-8`, is not cached, and does not stop the workstation. The container receives that timezone as `TZ` instead of the service's `UTC`, plus `LC_ALL`, `LANG` and `LANGUAGE`. The Browser image's `CHROME_CLI` adds `--lang` for any language other than `en-US`. The Desktop image's Chromium launcher reads `LC_ALL` from the desktop session and passes the same `--lang`; that launcher change takes effect only after the desktop image is rebuilt. The managed Chromium policy stays one shared file and is not used for language. Keyboard layout, fonts and HTML geolocation are not set. A workstation without a lease keeps the service's `UTC` and sets no locale.

A proxied Browser container is also firewalled, because it exists only for Chromium. RoboTeam creates it, initializes it so its network namespace exists without anything running in it, loads `container-firewall.nft` from `/data/proxy-pool/` into that namespace with `nsenter --net=<namespace> nft -f`, and only then starts it; if any step fails the container is removed and never starts. The rules let outbound traffic leave only through loopback, where port 3128 is the relay, and accept inbound connections only on loopback and on the session and MCP ports 3000 and 8100. DNS, UDP and direct TCP are dropped, so a program that ignores the proxy fails instead of reaching the internet on the host's address, and Chromium resolves names through the proxy. The container has no `CAP_NET_ADMIN`, so its root user cannot change the rules. A Desktop container is not firewalled, so that its other programs keep their network. The [architecture page](architecture.html#proxied-network) draws these paths.

### Administration

Accounts, providers, synchronization and proxy checks are administered on proxyAgent's own page, at `/base-agent-additional-server/proxyAgent/7001/`. That page shows, for each proxy in use, the robot name and the consumer agent, such as `Scout · roboTeamAgent`. RoboTeam shows the robot side. `GET /api/robot-proxies` returns the proxy each robot holds, without credentials, with its account, exit address, timezone and language, and whether it is still usable; `available` is false when proxyAgent cannot be reached. `DELETE /api/robots/<robot id>/proxy` releases a stopped robot's proxy and answers 409 while its workstation runs. Both routes require an administrator after the normal signed entitlement gate. The dashboard shows the proxy on each robot card and offers **Release proxy** in its menu.
