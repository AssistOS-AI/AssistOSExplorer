---
title: DS012-ploinky-deployment
summary: Defines the Ploinky-managed deployment, Router paths, startup and shutdown, agent discovery, persistent data, and operational verification.
---

## Introduction

Soul Gateway runs as one Ploinky-managed agent. Ploinky supplies the container runtime, dependency cache, persistent data mount, signed identity material, external Router paths, and Explorer settings entry that form the production environment.

## Core Content

### Agent manifest

<code>manifest.json</code> must select the declared Ploinky Node image, run <code>bash /code/install.sh</code> for installation, run <code>bash /code/startup.sh</code> as the agent process, and expose <code>bash /code/cli.sh</code> as the agent CLI. The persistent volume must map the workspace <code>.data/soul-gateway</code> directory to <code>/data</code>.

The agent must listen on port <code>7000</code> by default. The manifest must supply <code>DATA_DIR=/data</code>, <code>CREDENTIALS_DIR=/data/credentials</code>, and <code>SQLITE_PATH=/data/soul-gateway.sqlite3</code>. <code>startup.sh</code> must bind <code>HOST=0.0.0.0</code> unless configured otherwise and start <code>src/index.mjs</code> from the mounted source tree. Direct starts must explicitly configure all three persistence paths and must not fall back to a relative data directory.

### Router paths

The [Ploinky Router](../wiki.html#definition-ploinky-router) must publish these [agent-port paths](../wiki.html#definition-agent-port-path):

| Path | Access contract |
| --- | --- |
| <code>/base-agent-additional-server/soul-gateway/7000/v1/*</code> | Router guest access plus mandatory Soul Gateway signed-subject authentication. |
| <code>/base-agent-additional-server/soul-gateway/7000/management/*</code> | Authenticated Router access plus verified administrator protected-route identity. |
| <code>/base-agent-additional-server/soul-gateway/7000/healthz/*</code> | Public health access. |

The service root must redirect to <code>/management</code> internally. External documentation and integrations must use the Router prefix rather than assuming port <code>7000</code> is publicly exposed.

### Dependencies and data

The Ploinky dependency cache must supply runtime packages that are not declared as ordinary application dependencies, including AchillesAgentLib. Node must supply the built-in <code>node:sqlite</code> API. Installation and startup may link <code>/Agent/node_modules</code> into the mounted code directory when <code>/code/node_modules</code> is absent.

<code>install.sh</code> must create data and credential directories and generate <code>/data/encryption.key</code> when absent. Optional headless search may require Chromium when <code>BROWSER_POOL_SIZE</code> is positive. Persistent recovery must keep the database, encryption key, and credential directory together.

### Ploinky agent discovery

At startup, Soul Gateway must use the Router discovery client to reconcile eligible Ploinky agent routes before the initial runtime snapshot loads. A periodic discovery timer must repeat reconciliation without making startup depend on remote agent availability. Discovery failures must be logged and must not crash the gateway.

Reconciliation may create or update [Ploinky agent model](../wiki.html#definition-ploinky-agent-model) provider and model records within its ownership scope, disable stale discovered records according to the reconciliation contract, and request snapshot refresh after changes. It must not overwrite unrelated manually managed providers or models.

### Standard local hub behavior

The deployed Soul Gateway is the local LLM hub. The discovered model named by <code>LLM_DEFAULT_AGENT</code> may seed <code>fast</code>, <code>plan</code>, and <code>deep</code> according to <code>LLM_DEFAULT_TIERS</code>. Public callers reach these tiers through Soul Gateway; vendor-backed children use AchillesAgentLib and discovered Ploinky-agent children use signed Router capability calls. The local gateway must not delegate its tier policy to a second remote Soul Gateway.

### Explorer and CLI

The Explorer <code>soul-gateway-settings</code> entry must point to the Router-prefixed management dashboard and remain administrator-only. The CLI must expose health and status without a management cookie and must require <code>PLOINKY_AUTH_COOKIE</code> for keys, models, and logs.

### Operational verification

Deployment and restart workflows must verify the Router-published health endpoint, agent container status, and the configured SQLite file inside the container. Graceful termination must follow DS011. Direct host access is a read-only diagnostic path by default; deployment, restart, destroy, and administrative state changes should use the repository's automation workflows.
