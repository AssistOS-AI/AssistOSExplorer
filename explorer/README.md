<!-- {"achilles-ide-document":{"id":"Ly5wbG9pbmt5L3JlcG9zL2ZpbGVFeHBsb3Jlci9leHBsb3Jlci9SRUFETUUubWQ=","title":"README","version":1,"updatedAt":"2026-05-01T08:00:24.000Z"}} -->
<!-- {"achilles-ide-chapter":{"id":"chapter-32fd8318-a414-40cf-9d37-54470d2912eb","title":"Explorer","anchorId":"chapter-chapter-32fd8318-a414-40cf-9d37-54470d2912eb"}} -->
<a id="chapter-chapter-32fd8318-a414-40cf-9d37-54470d2912eb"></a>
# Explorer
<!-- {"achilles-ide-paragraph":{"id":"paragraph-d298d7a0-fbc2-4c41-9735-3fd0a6e15a05","type":"markdown","title":"Paragraph 1"}} -->
This folder contains the `explorer` agent inside the `AchillesIDE` repository.

Explorer is an HTTP Model Context Protocol (MCP) server plus the main workspace user interface. It owns filesystem browsing, preview, editing, plugin hosting, and the host shell used by the other workspace agents.  


<!-- {"achilles-ide-chapter":{"id":"chapter-76fb6bde-b772-4a9d-9f6b-a50521445ae4","title":"Current Responsibilities","anchorId":"chapter-chapter-76fb6bde-b772-4a9d-9f6b-a50521445ae4"}} -->
<a id="chapter-chapter-76fb6bde-b772-4a9d-9f6b-a50521445ae4"></a>
## Current Responsibilities
<!-- {"achilles-ide-paragraph":{"id":"paragraph-02da937c-c195-4138-8748-5c2bf4c513f3","type":"markdown","title":"Paragraph 1"}} -->
Explorer owns:

- filesystem MCP access within configured workspace roots
- host routing and preview selection
- general text and code editing
- normal Markdown source editing for `.md` files through the embedded TinyMDE editor
- explicit SOPLang tag editing for Markdown documents that need Achilles/SOPLang metadata workflows
- collaborative editing safeguards for local files
- application and document plugin hosting
- manifest-declared agent settings discovery for `Settings > Agents`
- account-menu plugin hosting for workspace-wide controls such as DPU audit
- client-side audit emission for Explorer actions, file open/save flows, plugin usage, and copilot autocomplete
- session-expiration handling for the browser client
- global loading overlays for long-running UI actions, which remain visible until the wrapped async workflow finishes with success or failure

For the general text and code editor, the current collaboration behavior is:

- auto-save is a user setting, default `off`, with a default interval of `10` seconds when enabled
- the editor surface shows when auto-save is enabled
- if a file changes on disk after an edit session starts, Explorer warns the user, opens a reload confirmation popup, and blocks save until the file is reloaded
- if a local file is only being viewed, Explorer polls lightweight file metadata for the current file and reloads the preview automatically if another user updates it
- if the authenticated workspace session expires, Explorer shows a session-expired message and redirects to `/auth/login` with the current route in `returnTo`

For Markdown files, Explorer uses two distinct editing paths:

- `Edit` opens the file as normal Markdown source using the embedded TinyMDE editor. The editor is bound to the same save, dirty-state, conflict, and DPU-backed update flows as other editable text resources.
- `Advanced edit` opens the structured document editor for Achilles/SOPLang metadata, document nodes, commands, variables, media tags, references, and other structured document workflows.

The default `.md` edit path must not implicitly hydrate the full SOPLang document model. Structured SOPLang editing is an explicit user action so ordinary Markdown files remain ordinary editable Markdown.

Explorer also reserves workspace secret files as non-browsable resources:

- `.secrets`
- any file ending in `.secrets`

These files are blocked from Explorer filesystem MCP access and hidden from the normal Explorer filesystem surface.


<!-- {"achilles-ide-chapter":{"id":"chapter-b731c5f4-b1ed-4f96-8cdf-4deb78b6707b","title":"Requirements","anchorId":"chapter-chapter-b731c5f4-b1ed-4f96-8cdf-4deb78b6707b"}} -->
<a id="chapter-chapter-b731c5f4-b1ed-4f96-8cdf-4deb78b6707b"></a>
## Requirements
<!-- {"achilles-ide-paragraph":{"id":"paragraph-9316f30c-8457-4f28-9bba-c90287950be4","type":"markdown","title":"Paragraph 1"}} -->
- a working Ploinky installation, with `ploinky` available in the shell
- a configured Ploinky host sandbox runtime for `lite-sandbox` agents, or a container runtime such as Podman or Docker when host sandboxing is disabled


<!-- {"achilles-ide-chapter":{"id":"chapter-c2f7c319-3f62-419d-94a1-ce5b077d7686","title":"Running Explorer","anchorId":"chapter-chapter-c2f7c319-3f62-419d-94a1-ce5b077d7686"}} -->
<a id="chapter-chapter-c2f7c319-3f62-419d-94a1-ce5b077d7686"></a>
## Running Explorer
<!-- {"achilles-ide-paragraph":{"id":"paragraph-10915355-5907-4d23-bb64-7655ceafc615","type":"markdown","title":"Paragraph 1"}} -->
For a fresh local Explorer workspace, run only the Ploinky Explorer entrypoint and let it own repository enablement, agent enablement, default variables, dependency startup, and router launch.

```bash
mkdir -p ~/work/testExplorerFresh
cd ~/work/testExplorerFresh
ploinky destroy || true
find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
ploinky start explorer
```

Open:

- dashboard: `http://127.0.0.1:8080/dashboard`
- Explorer route: `http://127.0.0.1:8080/#file-exp/`

Verify:

```bash
ploinky status
curl -I http://127.0.0.1:8080/dashboard
```


<!-- {"achilles-ide-chapter":{"id":"chapter-d64db818-6438-4467-b356-34daf4b574de","title":"Why Global Mode Is Required","anchorId":"chapter-chapter-d64db818-6438-4467-b356-34daf4b574de"}} -->
<a id="chapter-chapter-d64db818-6438-4467-b356-34daf4b574de"></a>
## Why Global Mode Is Required
<!-- {"achilles-ide-paragraph":{"id":"paragraph-53c41736-fddf-4916-8732-6e633ca05847","type":"markdown","title":"Paragraph 1"}} -->
Ploinky agents can run in different modes:

- `isolated`: only the agent workdir is mounted
- `global`: the workspace root is mounted

Explorer must run in `global` mode if it should browse the whole workspace, including `.ploinky/repos` and sibling workspace directories. The default local `ploinky start explorer` path is responsible for applying that mode. If Explorer runs in `isolated` mode, treat it as a profile/startup regression rather than fixing the fresh deployment with manual bootstrap commands.


<!-- {"achilles-ide-chapter":{"id":"chapter-c08998bf-a899-4282-9c25-6428fbded3f6","title":"Filesystem Root","anchorId":"chapter-chapter-c08998bf-a899-4282-9c25-6428fbded3f6"}} -->
<a id="chapter-chapter-c08998bf-a899-4282-9c25-6428fbded3f6"></a>
## Filesystem Root
<!-- {"achilles-ide-paragraph":{"id":"paragraph-76746b20-b599-4604-91c9-6b005951f0c0","type":"markdown","title":"Paragraph 1"}} -->
Explorer uses `ASSISTOS_FS_ROOT` to decide what path to expose.

- default local deployment: `ploinky start explorer` provides the workspace root through profile/default configuration
- custom override: use a workspace variable only when intentionally diverging from the default local deployment


<!-- {"achilles-ide-chapter":{"id":"chapter-d7219fe8-f8b2-4cd2-8ffe-4c37eb7a66a7","title":"Repo-Scoped HTML Preview","anchorId":"chapter-chapter-d7219fe8-f8b2-4cd2-8ffe-4c37eb7a66a7"}} -->
<a id="chapter-chapter-d7219fe8-f8b2-4cd2-8ffe-4c37eb7a66a7"></a>
## Repo-Scoped HTML Preview
<!-- {"achilles-ide-paragraph":{"id":"paragraph-c78a5894-56f3-4c2b-84b6-9bb09605d79c","type":"markdown","title":"Paragraph 1"}} -->
Explorer web preview for `.html` files uses repo-scoped URLs generated from the selected file path.

Example:

- `/.ploinky/repos/AchillesIDE/docs/development.html?__previewReload=1`

This keeps similarly named files from different repositories from colliding under a shared `/docs/...` namespace.


<!-- {"achilles-ide-chapter":{"id":"chapter-0a71d524-0109-4942-af31-3652b77026c4","title":"Documentation","anchorId":"chapter-chapter-0a71d524-0109-4942-af31-3652b77026c4"}} -->
<a id="chapter-chapter-0a71d524-0109-4942-af31-3652b77026c4"></a>
## Documentation
<!-- {"achilles-ide-paragraph":{"id":"paragraph-9ab706ec-5970-40fb-a222-13bd7b07993c","type":"markdown","title":"Paragraph 1"}} -->
- [Explorer specification matrix](../docs/specs/matrix.md)
- [DPU agent documentation](../dpuAgent/docs/index.html)
- [OnlyOffice agent documentation](https://assistos-ai.github.io/OnlyOfficeAgent/onlyOffice/docs/index.html)
- [Workspace Monitor documentation](../workspaceMonitorAgent/docs/index.html)


<!-- {"achilles-ide-chapter":{"id":"chapter-314577f2-f72c-47f2-bed6-8844715ad50b","title":"Troubleshooting","anchorId":"chapter-chapter-314577f2-f72c-47f2-bed6-8844715ad50b"}} -->
<a id="chapter-chapter-314577f2-f72c-47f2-bed6-8844715ad50b"></a>
## Troubleshooting
<!-- {"achilles-ide-paragraph":{"id":"paragraph-404237cb-2035-4e6f-af3f-bb1011e3dfb5","type":"markdown","title":"Paragraph 1"}} -->
If Explorer only shows `agents/` after a fresh local startup, first verify that the workspace was started through the default entrypoint:

```bash
ploinky destroy
find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
ploinky start explorer
```

If the problem persists after that clean startup, inspect the selected Ploinky profile, generated Explorer manifest, and router logs. Do not make manual `enable agent` or `ASSISTOS_FS_ROOT` changes part of the normal fresh deployment path.

If HTML preview returns `404` for repo-scoped paths, validate static exposure directly:

```bash
curl -I "http://127.0.0.1:8080/.ploinky/repos/AchillesIDE/docs/development.html"
```

Expected result:

- `HTTP/1.1 200`
