---
title: DS004-runtime-plugins
summary: Defines runtime plugin discovery, policy filtering, mounting, and domain ownership in Explorer.
---

# DS004 Runtime Plugins

## Introduction

Runtime plugins extend Explorer without transferring domain responsibility into the Explorer codebase.

## Core Content

Explorer must discover enabled plugin bundles from agent-owned or repository-local `IDE-plugins/*/config.json` locations through the IDE plugin collection flow. The host must validate a plugin manifest, resolve its declared component dependencies, and apply `applicationPlugins` policy before mounting an application plugin.

Discovery supports a repository used directly as the workspace, immediate workspace agents, immediate top-level repositories containing manifest-bearing agent directories, and managed repositories under `.ploinky/repos`. Top-level repository discovery examines only their immediate agents and confines resolved manifests and plugin configuration paths to the physical workspace; it must not recursively load arbitrary nested folders. A local repository takes precedence over a managed checkout with the same repository name or Git origin, including registered aliases with different directory names. GitHub origin matching ignores URL transport, case, and the `.git` suffix. The selected local source replaces the entire managed source even when plugins were removed; an empty selected local source must not trigger discovery outside the workspace. Physical repository paths are scanned once. Existing direct-agent and managed repository symlink handling remains supported. Agent names, policy keys, workspace-relative asset paths, and manifest `ideSettings` retain their current meanings; discovery does not enable a disabled plugin.

The `applicationPlugins` object in `explorer/manifest.json` is the host whitelist for application-plugin identities. A discovered application plugin must be enabled by that whitelist before workspace plugin settings can admit it. The `routerAccess` declaration publishes `/shared/*` and `/web-components/components/*` as public asset routes; it does not make protected agent tools or data public.

Reusable WebSkel libraries, shared components, and `shared/ui/ui-common.css` must be consumed from Explorer's `/shared/*` route. A plugin must not copy those assets into its own bundle or add a duplicate public route when the host-owned shared contract applies.

Plugins must use declared Explorer slots and the WebSkel presenter lifecycle. A plugin must not replace Explorer routing, navigation ownership, shared authorization, or host layout contracts. A plugin may render a domain control and call the owning agent's tools, but it must not duplicate that agent's ACL evaluation or persist its protected state.

Mount contributions in `file-exp:toolbar` use manifest-first activation. Explorer renders a host-owned button immediately from the plugin `label`, `tooltip`, and `icon`; it must not import, instantiate, or mount that plugin during the initial Explorer render. The first click changes only that button to a loading state, resolves filesystem context, loads the runtime component and its declared dependencies, mounts it in the same stable container, and forwards the activation to the mounted control. Later clicks use the already mounted component without repeating the load.

A menu contribution declares its Explorer slots and stable presentation metadata. Explorer creates the menu entry synchronously from that metadata and must not import the plugin module while opening the menu. The first click sets a loading state only on the selected item, builds the generic filesystem context, imports the module, and calls `activateMenuItem()`. No asynchronous plugin operation may add or remove menu rows during an open interaction.

On the initial file-browser route, Explorer may mount the shell before runtime discovery completes. As soon as the catalog is discovered, the host must refresh manifest-backed menu metadata while preserving any open action menu. The later component-mount readiness phase may mount plugin components, but it must not rebuild or close that menu.

Agent dashboard launchers may use Explorer's `#agent-runtime-wait` bootstrap route before navigating to a protected page. A target must remain on the current origin, contain no credentials or fragment, and belong to the watched agent through either `/<agent>/...` or `/base-agent-additional-server/<agent>/<port>/...` with a valid TCP port. Cross-agent targets must be rejected. The loader must wait for the target HTTP response, the standard MCP tools handshake and a stable Router generation, and retain retry feedback for terminal failures. An embedded toolbar panel that declares `agentRef` applies this same readiness gate before it renders its frame: it starts the agent, waits for route-generation stability, probes the target route, and completes the MCP handshake. RoboTeam's toolbar panel uses this gate for `AchillesCLI/roboTeamAgent` and its port-3001 dashboard, because its no-wait dependency can still be starting when Explorer renders. The Router remains responsible for service exposure and authorization.

Toolbar panels use Explorer's shared `openExpandedModal` shell. A `toolbarModal` descriptor selects component or iframe content. A toolbar contribution whose manifest declares `toolbarModal` opens that panel immediately on first activation from the manifest descriptor, showing the shell loading state while the runtime component, dependent agent, or embedded page resolves; the mounted control's later activation reuses the open panel for the same content instead of opening a second one. Component content uses WebSkel reactive properties and its normal removal lifecycle; the shell owns fullscreen, resize, Escape and close controls. Git contributes `git-panel` without a standalone window implementation. Only one expanded panel is open at a time; opening different content removes the previous panel, while operation-specific secondary dialogs may overlay it.

The shared expanded dialog must derive its accessible name from its visible title using `aria-labelledby`, so initial and updated panel titles remain consistent for assistive technology and semantic browser controls.

An unavailable plugin component or dependent agent must produce a visible, recoverable interface error without preventing unrelated Explorer functionality from loading.

Runtime content that unauthenticated guests can reach must reference assets only through the publicly served routes (`/shared/*` and `/web-components/components/*`) or through the plugin's own public path. Explorer's `/assets/*` tree is not public, so guest-facing components and iframes must not depend on it; shared guest assets live under `shared/`.

Shared expanded panels serialize ownership across pending and visible launches. Reopening the same target retains its close promise and forwards updated properties; Git applies these through `updateModalProps` without recreating its panel or clearing drafts. Superseded launches are cancelled before display. Fullscreen restore preserves the previous dimensions within the viewport. Help delegates all window controls to the shared shell.

A `toolbarModal` descriptor may opt into refresh resume with `resume: true`. While such a panel is the active expanded panel, the shell records a resumable descriptor in per-tab session storage, and Explorer reopens it during startup, before any toolbar interaction, restoring the embedded content to the state it resumes from. The record is cleared only when the panel is closed by the user; a browser refresh tears the panel down without clearing it, so the panel returns. The embedded content owns its own deeper state recovery, for example rejoining an active room and restoring microphone and camera state, using its own per-tab record. Panels that do not declare `resume` are unaffected.

The shared shell is preloaded before toolbar interaction. Toolbar descriptors open it before plugin imports and runtime probes; content starts after the shell can paint. Loading stays inside the panel through initial data loading, with a stable Loading label and no retry counters. Lazy toolbar mounting never replays an activation for a descriptor panel.

Closing an expanded panel aborts its owned startup requests, polling and waits, removes iframe content, and prevents delayed registration from mounting content. Shared module imports and server operations already accepted are not rolled back; their late results must not continue the closed panel initialization.

Toolbar activation synchronously disables the clicked control, sets accessible busy state, and displays a spinner before waiting for the modal shell. This applies to both lazy and already mounted toolbar controls. Repeated activation is ignored until the shell opens or opening is cancelled; original button state is then restored.

The modal owns cleanup directly: closing marks it closed, aborts HTTP probes, clears its retry and readiness timers, and removes hosted content. Component loading uses normal awaits followed by closed checks. Each presenter releases its own resources in `afterUnload`; no generic promise cancellation wrapper is used.

Once the panel is visible, the toolbar control remains in its normal state. Its presenter may finish mounting in a hidden sibling and replaces the host button only after rendering completes; this background work must not reapply toolbar loading indicators.

## Conclusion

The runtime plugin contract makes one workspace interface extensible while keeping each domain implementation independent.
