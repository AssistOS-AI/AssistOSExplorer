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

### Agent repositories

This repository holds Explorer and the agents `dpuAgent`, `gitAgent`, `emailAgent`, `userPersistoAgent`, `workspaceMonitorAgent`, `soul-gateway` and `roboTeamAgent`. The manifest's `repos` map installs `legacy-agents` (`soplangAgent`, `tasksAgent`, `multimedia`, `webAssist`) for the rest of the default graph, plus `webmeet` (`webmeetAgent`, `liveKitServerAgent`, `webmeetScribeAgent`, `webmeetStt`), none of whose agents is enabled by default. `UmamiAgent`, `OnlyOfficeAgent` and `webmeet` are installed for Marketplace but not enabled by default, and `local-llms` supplies the local model agent. Ploinky names this repository `AchillesIDE`, so its agents run as `AchillesIDE/<agent>`.

### Account provider

UserPersisto owns authentication and account administration independently of Explorer. Its My Account page manages profile and sign-in security without application launch links. Explorer explicitly selects the provider's `explorer` dependency profile, which declares `explorer.access` for its existing `admin` and `user` roles. Other applications use the neutral provider profile without acquiring Explorer permissions. See [the account provider contract](docs/specsLoader.html?spec=DS012-user-persisto.md) for configuration and access rules.

### Default language models

A fresh `ploinky start explorer` does not download or start a local model. The workspace's local Soul Gateway seeds a restricted free OpenRouter provider on first start, with the tiers `fast`, `code`, `plan`, `write`, `deep`, `ultra`, and `web-assist`. The provider uses a bundled credential guarded to free models only. Its daily quota is shared by every installation that uses that bundled credential, so the free service is not unlimited. It requires internet access and is not available offline. An administrator can replace the credential through the existing admin-only Soul Gateway settings dashboard.

OpenCode's free models are available through the optional `legacy-agents/opencode-free` agent, which `ploinky start explorer` does not enable; to add it to a workspace, run `ploinky enable agent legacy-agents/opencode-free` from the workspace root. The agent wraps the unmodified OpenCode CLI; once enabled, Soul Gateway discovers it like any other agent and adds it to no tier by default: plain-text chat only, no tool calls and no images, one answer per request delivered as a single chunk after several seconds, a free quota shared by every installation that uses the bundled key, and prompts subject to the free models' data-use terms. Native OpenCode execution through RoboTeam's installed OpenCode CLI is unchanged.

## Use Explorer

Use Explorer to browse workspace files and virtual DPU resources. Normal Markdown uses source editing by default. Select Advanced edit only when the document requires SOPLang-aware structure such as metadata, commands, variables, or references.

Choose **Download** from an ordinary file or folder's context menu to save it locally. A file retains its original bytes and name; a folder downloads as a recursive ZIP, including empty directories. Progress appears in your browser's downloads. Private agent data, runtime metadata, secret files and recursive symbolic links are not included. This requires the download-capable Ploinky Router as well as the updated Explorer assets.

Confidential resources appear below `/Confidential`. Explorer displays these resources but delegates storage, permissions, secrets, research-data operations, audit, and provenance to dpuAgent. Configure DPU sources from the administrative Data Sources settings surface; source configurations reference a DPU secret and do not expose its value.

Repository documentation is available through the mounted path `/.ploinky/repos/AchillesIDE/docs/development.html` in a running workspace.

### Hardware limits

Administrators edit CPU cores, RAM percentage and eligible NVIDIA GPU shares in Settings → Hardware limits. Saving changes desired policy; Apply recreates selected exact instances. Instance rows distinguish pending and applied limits, usage, refusal and blocked dependency. Administration keeps its navigation links. Workspace Monitor reports applied limits without editing policy. See the [hardware limits workflow](docs/workspace-operations.html#hardware-limits) for the saved host gate, host status/clear recovery, GPU assurance and accepted administrator authority exposure.

## Development and verification

Run the affected agent's tests before making a wider change:

```bash
cd explorer && npm test
cd ../dpuAgent && npm test
```

Read the [documentation entry point](docs/index.html), the [terminology wiki](docs/wiki.html), and the [specification matrix](docs/specsLoader.html?spec=matrix.md) before changing a documented behavior. `docs/specs/` contains the normative contracts.
