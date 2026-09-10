# RoboTeamAgent

RoboTeamAgent is a globally enabled Ploinky dependency that manages workspace-scoped robots, persistent coding-agent homes, visible GUI containers, and asynchronous ALA tasks. Robot names are unique across the workspace; only administrators create or delete robots, while internal workspace agents can list and run them by `robotName`. Advanced Language Agent, abbreviated ALA, is the LLM execution layer. RoboTeam owns deterministic robot and container lifecycle; ALA runs the prompt through Codex, OpenCode, or Pi. RoboTeam prepares all three CLIs dynamically. The current task-local MCP adapter connects Codex to the selected GUI server, so OpenCode and Pi are currently limited to Simple tasks.

The default robot is also the Explorer copilot. Every robot exposes the shared CLI/WebChat wrapper through `ploinky cli roboTeamAgent --robot <name>`. Use `/session`, `/tasks`, `/model`, `/permissions`, and `/skills use copilot,set/skill`. See [robot commands and message transport](docs/operations.html#robot-commands) for the complete reference, including `/session new`. The copilot set is available to all robots and selected automatically only for default. Existing AchillesCLI data is neither migrated nor deleted.

Before HTTP readiness, startup ensures the ordinary robot named exactly `default` exists. It reuses an existing record and home unchanged, or creates one through normal registry logic with empty specialization. Concurrent startup and ordinary creation cannot duplicate the name. This robot has no fixed ID or special marker and can be deleted by an administrator under the normal guards. A launch while it is absent fails; only the next startup recreates it. Registration does not copy credentials, download tools or start a GUI.

Each robot runs independent CLI conversations concurrently. Desktop and Browser have one graphical ALA slot; additional graphical tasks enter that robot's FIFO queue and start after the active task reaches a terminal state. The three start tools are native asynchronous Ploinky tools: the start call returns Ploinky task metadata, intermediate ALA messages appear in the task log, and the task becomes completed or failed when the ALA process exits. Desktop and Browser callers obtain the authenticated Selkies URL through the matching session-URL tool once the graphical runtime is ready.

A robot retains at most one GUI container after its ALA task stops, so a person can inspect the final visible state. RoboTeam reuses the container when the next graphical task has the same mode and resolved cwd. A different cwd or mode removes the idle retained container and starts one replacement with the requested `/workspace` mount. A Simple task starts no new container and does not remove a retained GUI container.

Desktop tasks use the current computer-use-linux release behind the current Supergateway package on a loopback-only Streamable HTTP bridge. Browser tasks use the current Playwright MCP package connected through CDP to the Chromium window shown by Selkies. These tools are resolved and installed into a persistent shared cache in the background at service startup instead of being baked into the images or declared in RoboTeam's `package.json`. In both modes RoboTeam starts ALA separately, gives it the caller's `cwd`, derives `--home` from the robot's persistent home, and injects the MCP bridge URL without rewriting saved Codex configuration.

The dashboard and `openDesktopForRobot` also start a desktop without ALA. Startup prepares the current Codex, OpenCode, and Pi packages. A desktop mounts the shared cache read-only at `/data/tool-cache` and uses its stable `shell/bin` links to the validated generations. The container PATH exposes all three executables while retaining LinuxServer's `/lsiopy/bin` directory required by Selkies. The robot home is mounted at `/config`, and ALA later receives that same directory through `--home`. Login and configuration created with `codex`, `opencode`, or `pi` in the desktop therefore remain specific to that robot, while every robot shares the executable cache.

ALA itself runs in the outer RoboTeam container and starts the selected coding agent inside Bubblewrap. RoboTeam must be enabled in Ploinky global mode and invokes the workspace checkout at `/workspace/AdvancedLanguageAgent/bin/ala.mjs`, so local ALA contract changes such as `--home`, `--cwd`, and `--MCPServers` are available immediately during development. Invoking a real entrypoint also avoids the incorrect relative ESM resolution caused by Ploinky's Node.js symlink-preservation flags when an npm `.bin` symlink is used. RoboTeam enables ALA's structured event stream, forwards each coding-agent message to the native Ploinky task log, and keeps ALA's final standard output as the task result. Failed ALA tasks include a bounded diagnostic tail in the internal error.

The current nested RoboTeam environment cannot mount a private procfs inside an additional Bubblewrap user namespace. ALA probes the normal `--unshare-user` path first. When that specific probe fails, it keeps separate PID, IPC, and UTS namespaces and a private `/proc`, uses the outer container's admitted mount capability only while Bubblewrap constructs those mounts, and applies `--cap-drop ALL` before starting Codex. The filesystem remains read-only except for the selected cwd and controlled robot home, and the environment remains filtered. This is not an unsandboxed fallback: if neither private-proc path works, ALA fails closed. Codex also disables its redundant native sandbox because the complete Codex process already runs inside the ALA Bubblewrap boundary.

Creating a robot creates metadata and persistent directories only. It does not copy Codex, OpenCode, Pi, ALA, computer-use-linux, Playwright MCP, or an operating system into the robot. Service startup prepares shared generations under `/data/tool-cache`; every robot mounts or discovers those generations together with its own home and cwd. An immediate request shares and waits for any pending preparation it needs.

AchillesCLI integrates RoboTeam through its Anthropic `launch-robot` skill and scoped runtime channel. Robot discovery is `launch-robot/scripts/list.mjs`, which calls `robot_list`, not a separate product skill. The launcher submits a native asynchronous Desktop or Browser task, passes the parent-captured AchillesCLI directory as `cwd`, attaches the task to the background observer, waits for the GUI and MCP bridge, and returns the live Selkies URL. `/exec launch-robot desktop: <task>` or JSON with omitted `robotName` selects `default`; existing named syntax remains supported and explicit invalid or unknown names never fall back. Task observation persists intermediate messages and completion after the script returns.

## Development

Administrators open Manage skills on a robot to add an HTTPS skill repository or remove an existing one. Expand a repository to inspect its skills and the descriptions and member lists from skillsets.md. The Markdown file uses one # heading per skillset and ## Description / ## Skills sections; a repository without this file contributes no skillsets. Robot discovery publishes generated selection IDs with descriptions. Choose by description and pass the IDs in skillSets. Resume and Continue reuse the saved selection.

`Delete robot` in the dashboard is administrator-only and requires confirmation, no unfinished tasks, and no retained container. It permanently removes that robot's home, imported repositories and task catalogs. Removing a repository makes its skills unavailable to future executions; RoboTeam prunes those paths from saved task manifests before starting or continuing. Source repositories remain untouched. See [Robots & Runs](docs/operations.html) for selectors and examples.

```sh
npm test
npm run check
```

The canonical runtime, desktop, and browser image definitions live in `container-image-builds/images/roboteam-agent`. The published defaults are `assistos/roboteam-agent:runtime`, `assistos/roboteam-desktop:runtime`, and `assistos/roboteam-browser:runtime`. Desktop derives from a digest-pinned LinuxServer Webtop image. Browser derives from a separate digest-pinned LinuxServer Chromium image. Both outputs are custom RoboTeam images, but their graphical stacks come from LinuxServer and account for most of their size. The browser image is separate but currently close to the desktop image in size because both include Selkies and a complete graphical runtime.

RoboTeam resolves current tool versions at startup and rechecks them on demand after the fixed six-hour interval. Shell, Desktop and Browser tools prepare concurrently after HTTP listening, so downloads do not delay service readiness. Preparation reports each family in service logs; a failed family does not stop the service, and a later request retries it. Startup creates no robot GUI session. A cache hit avoids another installation. A new version is installed in a unique staging directory, probed, stamped, and atomically activated. Concurrent requests share the same preparation promise; failed resolution or installation falls back to the last valid generation. The graphical base images remain digest-pinned, and the Podman publication workflow resolves its rolling version-6 channel once to an exact digest for every architecture in one run.

See [the documentation](docs/index.html) and [the design specifications](docs/specs/matrix.md) for the complete contract.


A repository may define `skillsets.md` at its root:

```markdown
# report-review

## Description

Use when a report needs PDF inspection and a written review.

## Skills

- read-pdf
- write-doc

# pdf-inspection

## Description

Use when only the PDF needs inspection.

## Skills

- read-pdf
```

Each member must match a skill's `name` in `SKILL.md` from that repository. The skillset name is its Markdown heading; no version field is required. No file means no declared skillsets. Choose the described combinations returned by `robot_list` and send their IDs through `launch-robot`'s `skillSets` parameter.

Repositories without declared skillsets expose each skill’s name and description, grouped by repository ID, in robot discovery and the default robot’s turn context. Individual selections use `repository-id/skill-name` in `skills` and combine with selected skillsets. Delegated tasks never receive copilot automatically; direct default chats retain their base copilot skills. Resume reuses the saved catalog.

See [Skills & Skillsets](docs/skills.html) for repository management, Markdown definitions and the task manifest flow.
