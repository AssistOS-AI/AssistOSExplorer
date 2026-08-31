---
title: DS005-ploinky-security
summary: Specifies the single-agent identity, authenticated Router exposure, trusted user metadata, mutation protection, internal token use, and security limitations.
---

## Introduction

RoboTeam is a security-sensitive [Ploinky agent](../wiki.html#definition-ploinky-agent) because its profile browser directories can contain authenticated website sessions. Public access must remain mediated by the Ploinky Router.

## Core Content

The canonical agent identity must remain `agent:AchillesCLI/roboTeamAgent`. This repository-derived identity is independent of the default route key `roboTeamAgent`. A deployment may change the route key only when it updates `ROBOTEAM_ROUTE_KEY`, `ROBOTEAM_PUBLIC_BASE_PATH`, and the manifest route declaration as one compatible configuration change.

The manifest must declare the RoboTeam port `7000` through an authenticated [agent-port route](../wiki.html#definition-agent-port-route). It must not declare VNC, websockify, Chromium debugging, AgentServer, or application container ports as direct public services. Ploinky must authenticate both HTTP and WebSocket traffic before it reaches RoboTeam.

Browser requests must use Router-injected `x-ploinky-auth-info` as their user identity. RoboTeam must reject a missing or malformed identity. The Router must strip client-supplied internal identity headers before injecting trusted metadata. State-changing browser requests must carry the Ploinky browser mutation proof bound to the selected route and session.

The bundled Ploinky AgentServer must listen on loopback port `7001` and must be reached through the service proxy on port `7000`. MCP tool tags remain authenticated by default and must not be changed to `internal` or `admin` without an explicit contract and policy update.

Ploinky must generate `ROBOTEAM_INTERNAL_TOKEN`. MCP command handlers must receive the authenticated user through invocation metadata and must call the loopback service with that user id and the generated token. The service must compare the token without logging it. This token is separate from Ploinky user sessions, agent assertions, Router Request JWTs, and the per-agent secret.

The manifest and source must not contain `PLOINKY_MASTER_KEY`, literal agent secrets, passwords, cookies, browser sessions, raw JWTs, or literal generated tokens. Diagnostic logs may contain profile ids, process names, timestamps, and non-secret failure reasons but must not contain complete authentication headers or credential-bearing browser data.

The persistent data volume is a credential-bearing store. Profile Unix ownership protects profiles from ordinary processes running under another profile UID. The trusted root control service, the shared container kernel, the Ploinky runtime, and the storage operator remain inside the trust boundary. RoboTeam does not provide virtual-machine isolation or application-level encryption at rest.

Chromium runs as the unprivileged profile UID with `--no-sandbox` for compatibility with the nested container runtime. The profile desktop is therefore one trust domain and must not be presented as a hostile-content sandbox. Stronger browser or code isolation requires a separately specified task-runtime or per-profile-container boundary.
