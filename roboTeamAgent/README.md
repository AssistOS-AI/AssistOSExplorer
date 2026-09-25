# RoboTeamAgent

RoboTeamAgent is a globally enabled Ploinky dependency that manages workspace-scoped robots, persistent coding-agent homes, visible GUI containers, and asynchronous ALA tasks. Robot names are unique across the workspace; only administrators create or delete robots, while internal workspace agents can list and run them by `robotName`. Advanced Language Agent, abbreviated ALA, is the LLM execution layer. RoboTeam owns deterministic robot and container lifecycle; ALA runs the prompt through Codex, OpenCode, or Pi. RoboTeam prepares shared CLI installations dynamically and exposes the robot's configured selection. New robots enable only OpenCode. The task-local MCP adapter connects Codex or OpenCode to the selected GUI server, so GUI tasks resolve to one of those backends while Pi is limited to Simple tasks.

The default robot is also the Explorer copilot. Every robot exposes the shared CLI/WebChat wrapper through `ploinky cli roboTeamAgent --robot <name>`. Use `/session`, `/tasks`, `/model`, `/permissions`, and `/skills use launch-workflow,set/skill`. See [robot commands and message transport](docs/operations.html#robot-commands) for the complete reference, including `/session new`. The front copilot catalog is available only to default, which automatically mounts `bash`, `launch-gpt-researcher` and `launch-workflow`. The wrapper stores conversation sessions and task records in the opened folder under `.achilles-cli/`; records are not stored in or read from robot-scoped locations.

Before HTTP readiness, startup ensures the ordinary robot named exactly `default` exists. It reuses an existing record and home unchanged, or creates one through normal registry logic with empty specialization. Concurrent startup and ordinary creation cannot duplicate the name. This robot has no fixed ID or special marker and can be deleted by an administrator under the normal guards. A launch while it is absent fails; only the next startup recreates it. Registration does not copy credentials, download tools or start a GUI.

Each robot runs independent CLI conversations concurrently. Desktop and Browser have one graphical ALA slot; additional graphical tasks enter that robot's FIFO queue and start after the active task reaches a terminal state. The three start tools are native asynchronous Ploinky tools: the start call returns Ploinky task metadata, intermediate ALA messages appear in the task log, and the task becomes completed or failed when the ALA process exits. Desktop and Browser callers obtain the authenticated Selkies URL through the matching session-URL tool once the graphical runtime is ready.

A robot retains at most one GUI container after its ALA task stops, so a person can inspect the final visible state. RoboTeam reuses the container when the next graphical task has the same mode and resolved cwd. A different cwd or mode removes the idle retained container and starts one replacement with the requested `/workspace` mount. A Simple task starts no new container and does not remove a retained GUI container.

Desktop tasks use the current computer-use-linux release behind the current Supergateway package on a loopback-only Streamable HTTP bridge. Browser tasks use the current Playwright MCP package connected through CDP to the Chromium window shown by Selkies. These tools are resolved and installed into a persistent shared cache in the background at service startup instead of being baked into the images or declared in RoboTeam's `package.json`. In both modes RoboTeam starts ALA separately, gives it the caller's `cwd`, derives `--home` from the robot's persistent home, and injects the MCP bridge URL without rewriting saved backend configuration; ALA translates the URL into transient Codex configuration or process-only OpenCode remote `mcp` entries.

The dashboard and `openDesktopForRobot` also start a desktop without ALA. Startup prepares the current Codex, OpenCode, and Pi packages. A desktop mounts only the selected coding-agent generations read-only and the matching immutable shell directory. The container PATH exposes those selected executables while retaining LinuxServer's `/lsiopy/bin` directory required by Selkies. The robot home is mounted at `/config`, and ALA later receives that same directory through `--home`. Login and configuration created with `codex`, `opencode`, or `pi` in the desktop therefore remain specific to that robot, while every robot shares the executable cache.

ALA itself runs in the outer RoboTeam container and starts the selected coding agent inside Bubblewrap. RoboTeam must be enabled in Ploinky global mode and invokes the workspace checkout at `/workspace/AdvancedLanguageAgent/bin/ala.mjs`, so local ALA contract changes such as `--home`, `--cwd`, and `--MCPServers` are available immediately during development. Invoking a real entrypoint also avoids the incorrect relative ESM resolution caused by Ploinky's Node.js symlink-preservation flags when an npm `.bin` symlink is used. RoboTeam enables ALA's structured event stream, forwards each coding-agent message to the native Ploinky task log, and keeps ALA's final standard output as the task result. Failed ALA tasks include a bounded diagnostic tail in the internal error.

The current nested RoboTeam environment cannot mount a private procfs inside an additional Bubblewrap user namespace. ALA probes the normal `--unshare-user` path first. When that specific probe fails, it keeps separate PID, IPC, and UTS namespaces and a private `/proc`, uses the outer container's admitted mount capability only while Bubblewrap constructs those mounts, and applies `--cap-drop ALL` before starting Codex. The filesystem remains read-only except for the selected cwd and controlled robot home, and the environment remains filtered. This is not an unsandboxed fallback: if neither private-proc path works, ALA fails closed. Codex also disables its redundant native sandbox because the complete Codex process already runs inside the ALA Bubblewrap boundary.

Creating a robot creates metadata and persistent directories only. It does not copy Codex, OpenCode, Pi, ALA, computer-use-linux, Playwright MCP, or an operating system into the robot. Service startup prepares shared generations under `/data/tool-cache`; every robot mounts or discovers those generations together with its own home and cwd. An immediate request shares and waits for any pending preparation it needs.

AchillesCLI's front copilot receives the workflow catalog and automatically mounts the builtin `bash`, `launch-gpt-researcher` and `launch-workflow` skills, using `launch-workflow` to start flows. The skill calls `roboflow_start_flow` through the scoped runtime channel, which submits a native asynchronous Ploinky task, attaches it to the background observer, and returns the flow's final result and monitoring link after RoboFlow runs it to completion. The copilot cannot launch individual robots or control a flow after starting it.

## RoboFlow team workflows

RoboFlow owns team workflows end to end. An administrator creates a workflow type that declares which robots may work on an objective, their skillsets or skills, whether each runs as a terminal, desktop or browser task, and exactly one decision member. Workflow types can be edited in the dashboard or with `roboflow_update_workflow`. Startup guarantees a default workflow with the default robot as a terminal decision member plus browser and desktop members; it is read-only and cannot be edited or deleted. The front copilot receives only the workflow catalog and starts one with `roboflow_start_flow`; it never drives the flow. RoboFlow then starts the decision robot, which inspects the flow with `roboflow_flow_state`, launches members with `roboflow_launch_robot`, and completes the flow with `roboflow_finish_flow`. RoboFlow re-invokes the decision robot after each step's member runs finish. Every member launch wraps an existing `RuntimeManager` task; it never changes task storage or identity. Flow status is `start`, `running`, `completed`, `failed` or `stopped`. Every run's complete log is visible on the read-only RoboFlow monitoring page, which the copilot links from chat and the generic WebChat side panel opens through its embedded-link handling. This version deliberately omits schedules, leases, dependencies and rework graphs. See [DS007](docs/specs/DS007-roboflow-team-workflow.md).

## Development

Administrators use each robot’s Manage skills dialog to register an HTTPS repository with a generated ID. The API also accepts absolute workspace sources and an optional explicit source name. Optional skillsets.md declares named subsets exposed through generated selection IDs. `robot_list` returns the robot description, available sets and skill frontmatter descriptions. Task calls accept comma-separated `skillSets` or its `skillset` alias for whole sets and `skills` for qualified names such as `documents/read-pdf`. AchillesCLI launch JSON also accepts arrays. Direct chat omission on the default robot selects the copilot skillset plus the individual `launch-workflow` skill; other robots default to empty. Workflow tasks use their configured selections: a repository's named skillsets or, when it declares none, its individual skills. Delegated task omission selects no skills. RoboTeam stores a conversation policy reference before enqueueing and captures current selected files after queue wait. RoboTeam installs the selected live links in the working directory and ALA receives no skill options; continuation resolves the current policy unless explicitly pinned. Imports and task catalogs are private robot data, separate from the shared tool cache.

`Delete robot` in the dashboard is administrator-only and requires confirmation, no unfinished tasks, and no retained container. It permanently removes that robot's home, imported repositories and task catalogs. Removing a repository makes its skills unavailable to live executions; a policy that still requires that source fails until explicitly changed. Pinned catalogs retain their captured bytes. Legacy path manifests remain unchanged and require explicit pin recovery before reuse. Source repositories remain untouched. See [Robots & Runs](docs/operations.html) for selectors and examples.

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

Each member must match a skill's `name` in `SKILL.md` from that repository. The skillset name is its Markdown heading; no version field is required. No file means no declared skillsets. Choose the described combinations returned by `robot_list` and select them through a workflow member's `skillSets` parameter or `roboflow_create_workflow`.

Repositories without declared skillsets expose each skill’s name and description, grouped by repository ID, in robot discovery and the workflow member configuration. Individual selections use `repository-id/skill-name` in `skills` and combine with selected skillsets. Delegated tasks never receive copilot automatically; the front copilot's direct default chat initially selects only `launch-workflow`. Explicit empty selection stays empty. Resume captures current selected files unless pinned.

See [Skills & Skillsets](docs/skills.html) for repository management, Markdown definitions and the execution catalog flow.

RoboTeam does not scan the workspace for instruction skills. Skill sources are the bundled catalog and repositories registered on the robot, resolved through the Ploinky marketplace endpoint; live conversation policies capture the current registered files at execution start. See [local skill discovery](docs/local-skills.html).

The creation form uses Codex automatically. Administrators choose one coding agent in the dialog opened by Coding agent on an existing robot card, which also displays the enabled agent. Stop the workstation and tasks before changing it, then open a new chat or terminal. The API retains support for any nonempty `codingAgents` combination. Existing robots without this field retain all three until configured. See [coding-agent configuration](docs/operations.html#coding-agents).
