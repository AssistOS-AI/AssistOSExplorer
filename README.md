# AchillesIDE

AchillesIDE is a Ploinky workspace application centered on Explorer. It gives users one authenticated browser interface for navigating workspace files, editing content, previewing resources, and using agent-owned workflows such as confidential data, Git, tasks, SOPLang documents, media, and Office editing.

Explorer owns the shared IDE experience. Its coupled agents own their domain data, authorization, and mutations. This separation lets a user work from one interface without weakening the security or lifecycle rules of the integrated services.

## Prerequisites

- Node.js 20 or later.
- The `ploinky` command-line tool.
- A container runtime supported by Ploinky, such as Podman or Docker.

## Start Explorer

From a Ploinky workspace that contains this repository, run:

```bash
ploinky start explorer
```

Open the Ploinky dashboard at `http://127.0.0.1:8080/dashboard`, then open Explorer at `http://127.0.0.1:8080/#file-exp/`.

Ploinky starts the dependencies declared in `explorer/manifest.json`, configures the router, and serves Explorer as the workspace's static application. Check the local runtime with:

```bash
ploinky status
curl -I http://127.0.0.1:8080/dashboard
```

### Default language models

A fresh `ploinky start explorer` does not download or start a local model. The workspace's local Soul Gateway seeds a restricted free OpenRouter provider on first start, with the tiers `fast`, `code`, `plan`, `write`, `deep`, `ultra`, and `web-assist`. The provider uses a bundled credential guarded to free models only. Its daily quota is shared by every installation that uses that bundled credential, so the free service is not unlimited. It requires internet access and is not available offline. An administrator can replace the credential through the existing admin-only Soul Gateway settings dashboard.

OpenCode's free models are available through the optional `proxies/opencode-free` agent, which `ploinky start explorer` does not enable; to add it to a workspace, run `ploinky enable agent proxies/opencode-free` from the workspace root. The agent wraps the unmodified OpenCode CLI; once enabled, Soul Gateway discovers it like any other agent and adds it to no tier by default: plain-text chat only, no tool calls and no images, one answer per request delivered as a single chunk after several seconds, a free quota shared by every installation that uses the bundled key, and prompts subject to the free models' data-use terms. Native OpenCode execution through RoboTeam's installed OpenCode CLI is unchanged.

## Use Explorer

Use Explorer to browse workspace files and virtual DPU resources. Normal Markdown uses source editing by default. Select Advanced edit only when the document requires SOPLang-aware structure such as metadata, commands, variables, or references.

Confidential resources appear below `/Confidential`. Explorer displays these resources but delegates storage, permissions, secrets, research-data operations, audit, and provenance to dpuAgent. Configure DPU sources from the administrative Data Sources settings surface; source configurations reference a DPU secret and do not expose its value.

Repository documentation is available through the mounted path `/.ploinky/repos/AchillesIDE/docs/development.html` in a running workspace.

## Development and verification

Run the affected agent's tests before making a wider change:

```bash
cd explorer && npm test
cd ../dpuAgent && npm test
```

Read the [documentation entry point](docs/index.html), the [terminology wiki](docs/wiki.html), and the [specification matrix](docs/specsLoader.html?spec=matrix.md) before changing a documented behavior. `docs/specs/` contains the normative contracts.
