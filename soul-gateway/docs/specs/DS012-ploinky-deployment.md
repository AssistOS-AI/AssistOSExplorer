---
title: DS012-ploinky-deployment
summary: Defines the Ploinky-managed deployment, Router paths, startup and shutdown, agent discovery, persistent data, and operational verification.
---

## Introduction

Soul Gateway runs as one Ploinky-managed agent. Ploinky supplies the container runtime, dependency cache, persistent data mount, signed identity material, external Router paths, and the Explorer settings and toolbar entries that form the production environment.

## Core Content

### Agent manifest

The manifest must pin the shared Ploinky Node image by digest. It provides Node 24 on Debian Trixie, the built-in SQLite API, and a maintained Git/libcurl stack. The image must pass native amd64 and arm64 Git/npm transport checks before adoption, while Git retains its default HTTP negotiation.

<code>manifest.json</code> must select the declared Ploinky Node image, run <code>bash /code/install.sh</code> for installation, run <code>bash /code/startup.sh</code> as the agent process, and expose <code>bash /code/cli.sh</code> as the agent CLI. The persistent volume must map the workspace <code>.data/soul-gateway</code> directory to <code>/data</code>.

The agent must listen on port <code>7000</code> by default. The manifest must supply <code>DATA_DIR=/data</code>, <code>CREDENTIALS_DIR=/data/credentials</code>, and <code>SQLITE_PATH=/data/soul-gateway.sqlite3</code>. <code>startup.sh</code> must bind <code>HOST=0.0.0.0</code> unless configured otherwise and start <code>src/index.mjs</code> from the mounted source tree. Direct starts must explicitly configure all three persistence paths and must not fall back to a relative data directory.

The manifest enables no companion agent. It declares <code>FREE_MODELS_ENABLED</code> (default <code>true</code>), <code>OPENROUTER_API_KEY</code> (default empty), and <code>LLM_DEFAULT_TIERS</code> (default <code>fast,code,plan,write,deep,ultra,web-assist</code>) among its profile environment values. <code>STREAM_IDLE_TIMEOUT_MS</code> is read by <code>src/config/env.mjs</code> with a default of 300000 ms and is not declared in the manifest. <code>PRICING_DIRECTORY_TIMEOUT_MS</code> (default 5000 ms, clamped to the range 1 ms to 2147483647 ms because a timer takes no larger delay) bounds each load of the external pricing directory; it is read by <code>src/config/env.mjs</code> and is not yet declared in the manifest.

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

### Default model hub behavior

The deployed Soul Gateway is the model hub for its workspace. Public callers reach the [compatibility tiers](../wiki.html#definition-compatibility-tier) <code>fast</code>, <code>code</code>, <code>plan</code>, <code>write</code>, <code>deep</code>, <code>ultra</code>, and <code>web-assist</code> through Soul Gateway; vendor-backed children use AchillesAgentLib and discovered Ploinky-agent children use signed Router capability calls. The local gateway must not delegate its tier policy to a second remote Soul Gateway.

On first start, the free model defaults back every tier with free OpenRouter models through the [free-only provider](../wiki.html#definition-free-only-provider) <code>openrouter-free</code> and its bundled restricted key, as specified in DS002 and DS005. The gateway starts and serves its management interface and model list without internet access, because the tier records and baseline models are written before any catalog request and a failed catalog refresh leaves them in place. A network that accepts connections and then stalls does not hold startup either: model discovery is bounded by its discovery timeout (10 s per provider, and the startup refresh walks providers serially) and the pricing-directory load, which a non-empty catalog sync awaits, by <code>PRICING_DIRECTORY_TIMEOUT_MS</code>; a timeout degrades like any other directory failure, with a warning and no directory metadata, and is remembered for a backoff window so the next callers do not pay it again.

The one-time install runs on every database that lacks the <code>free-model-defaults</code> [bootstrap marker](../wiki.html#definition-bootstrap-marker), not only on a new deployment. An existing gateway that already has its own providers and tiers, for example a production deployment, installs the free provider and any missing tier names on its first start with this version unless it starts with <code>FREE_MODELS_ENABLED=false</code>. Set that value before the upgrade when the free provider and tiers are not wanted there. Answering a request on these tiers requires outbound HTTPS access to <code>openrouter.ai</code>. Soul Gateway performs no local inference by default; the bundled key's shared daily quota and expiry limit the free service.

An administrator who wants other models behind a tier, including a discovered Ploinky agent model, edits the tier's children through the management interface.

### Explorer and CLI

The Explorer <code>soul-gateway-settings</code> settings entry and the admin-only <code>soul-gateway-tool-button</code> toolbar button must point to the Router-prefixed management dashboard and remain administrator-only. The CLI must expose health and status without a management cookie and must require <code>PLOINKY_AUTH_COOKIE</code> for keys, models, and logs.

### Operational verification

Deployment and restart workflows must verify the Router-published health endpoint, agent container status, and the configured SQLite file inside the container. Graceful termination must follow DS011. Direct host access is a read-only diagnostic path by default; deployment, restart, destroy, and administrative state changes should use the repository's automation workflows.
