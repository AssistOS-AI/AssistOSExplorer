---
title: DS004-runtime-plugins
summary: Defines runtime plugin discovery, policy filtering, mounting, and domain ownership in Explorer.
---

# DS004 Runtime Plugins

## Introduction

Runtime plugins extend Explorer without transferring domain responsibility into the Explorer codebase.

## Core Content

Explorer must discover enabled plugin bundles from agent-owned or repository-local `IDE-plugins/*/config.json` locations through the IDE plugin collection flow. The host must validate a plugin manifest, resolve its declared component dependencies, and apply `applicationPlugins` policy before mounting an application plugin.

The `applicationPlugins` object in `explorer/manifest.json` is the host whitelist for application-plugin identities. A discovered application plugin must be enabled by that whitelist before workspace plugin settings can admit it. The `routerAccess` declaration publishes `/shared/*` and `/web-components/components/*` as public asset routes; it does not make protected agent tools or data public.

Reusable WebSkel libraries, shared components, and `shared/ui/ui-common.css` must be consumed from Explorer's `/shared/*` route. A plugin must not copy those assets into its own bundle or add a duplicate public route when the host-owned shared contract applies.

Plugins must use declared Explorer slots and the WebSkel presenter lifecycle. A plugin must not replace Explorer routing, navigation ownership, shared authorization, or host layout contracts. A plugin may render a domain control and call the owning agent's tools, but it must not duplicate that agent's ACL evaluation or persist its protected state.

Mount contributions in `file-exp:toolbar` use manifest-first activation. Explorer renders a host-owned button immediately from the plugin `label`, `tooltip`, and `icon`; it must not import, instantiate, or mount that plugin during the initial Explorer render. The first click changes only that button to a loading state, resolves filesystem context, loads the runtime component and its declared dependencies, mounts it in the same stable container, and forwards the activation to the mounted control. Later clicks use the already mounted component without repeating the load.

A menu contribution declares its Explorer slots and stable presentation metadata. Explorer creates the menu entry synchronously from that metadata and must not import the plugin module while opening the menu. The first click sets a loading state only on the selected item, builds the generic filesystem context, imports the module, and calls `activateMenuItem()`. No asynchronous plugin operation may add or remove menu rows during an open interaction.

On the initial file-browser route, Explorer may mount the shell before runtime discovery completes. As soon as the catalog is discovered, the host must refresh manifest-backed menu metadata while preserving any open action menu. The later component-mount readiness phase may mount plugin components, but it must not rebuild or close that menu.

Agent dashboard launchers may use Explorer's `#agent-runtime-wait` bootstrap route before navigating to a protected page. A target must remain on the current origin, contain no credentials or fragment, and belong to the watched agent through either `/<agent>/...` or `/base-agent-additional-server/<agent>/<port>/...` with a valid TCP port. Cross-agent targets must be rejected. The loader must wait for the target HTTP response, the standard MCP tools handshake and a stable Router generation, and retain retry feedback for terminal failures. RoboTeam's toolbar button must open this waiting route for `AchillesCLI/roboTeamAgent` and its port-3001 dashboard, because its no-wait dependency can still be starting when Explorer renders. The Router remains responsible for service exposure and authorization.

An unavailable plugin component or dependent agent must produce a visible, recoverable interface error without preventing unrelated Explorer functionality from loading.

## Conclusion

The runtime plugin contract makes one workspace interface extensible while keeping each domain implementation independent.
