# RoboTeamAgent

RoboTeamAgent is a globally enabled Ploinky dependency that manages workspace-scoped robots, persistent coding-agent homes, visible GUI containers, and asynchronous ALA tasks. Robot names are unique across the workspace; only administrators create or delete robots, while internal workspace agents can list and run them by `robotName`. Advanced Language Agent, abbreviated ALA, is the LLM execution layer. RoboTeam owns deterministic robot and container lifecycle; ALA runs the prompt through Codex, OpenCode, Pi, or Claude Code. RoboTeam prepares shared CLI installations dynamically. Robot shells expose every coding agent, while ALA receives only the robot's configured selection. New robots enable only OpenCode. The task-local MCP adapter connects Codex, OpenCode or Claude Code to the selected GUI server, so GUI tasks resolve to one of those backends while Pi is limited to Simple tasks.

The default robot is also the Explorer copilot. Every robot exposes the shared CLI/WebChat wrapper through `ploinky cli roboTeamAgent --robot <name>`. Use `/session`, `/tasks`, `/model`, `/permissions`, and `/skills use copilot,set/skill`. See [robot commands and message transport](docs/operations.html#robot-commands) for the complete reference, including `/session new`. The front copilot catalog is available only to default, which automatically mounts `bash` and `launch-gpt-researcher`. Every robot opened in WebChat also receives the required, read-only `list-workflows` and `launch-workflow` skills. The wrapper stores conversation sessions and task records in the opened folder under `.roboteam/`, where ALA also writes the conversation text under `.ala/sessions/`; records are not stored in or read from robot-scoped locations.

Before HTTP readiness, startup ensures the ordinary robot named exactly `default` exists. It reuses an existing record and home unchanged, or creates one through normal registry logic. Concurrent startup and ordinary creation cannot duplicate the name. This robot has no fixed ID or special marker and can be deleted by an administrator under the normal guards. A launch while it is absent fails; only the next startup recreates it. Registration does not copy credentials, download tools or start a GUI.

Each robot runs independent CLI conversations concurrently. Desktop and Browser have one graphical ALA slot; additional graphical tasks enter that robot's FIFO queue and start after the active task reaches a terminal state. The three start tools are native asynchronous Ploinky tools: the start call returns Ploinky task metadata, intermediate ALA messages appear in the task log, and the task becomes completed or failed when the ALA process exits. Desktop and Browser callers obtain the authenticated Selkies URL through the matching session-URL tool once the graphical runtime is ready.

A robot retains at most one GUI container after its ALA task stops, so a person can inspect the final visible state. RoboTeam reuses the container when the next graphical task has the same mode and resolved cwd. A different cwd or mode removes the idle retained container and starts one replacement with the requested `/workspace` mount. A Simple task starts no new container and does not remove a retained GUI container.

Desktop tasks use the current computer-use-linux release behind the current Supergateway package on a loopback-only Streamable HTTP bridge. Browser tasks use the current Playwright MCP package connected through CDP to the Chromium window shown by Selkies. These tools are resolved and installed into a persistent shared cache in the background at service startup instead of being baked into the images or declared in RoboTeam's `package.json`. In both modes RoboTeam starts ALA separately, gives it the caller's `cwd`, derives `--home` from the robot's persistent home, and injects the MCP bridge URL without rewriting saved backend configuration; ALA translates the URL into transient Codex configuration, process-only OpenCode remote `mcp` entries, or a Claude Code `--mcp-config` with `--strict-mcp-config`.

The dashboard and `openDesktopForRobot` also start a desktop without ALA. Startup prepares the current Codex, OpenCode, and Pi packages, plus Claude Code. A desktop mounts every coding-agent generation read-only and the matching immutable shell directory. The container PATH exposes all coding-agent executables while retaining LinuxServer's `/lsiopy/bin` directory required by Selkies. The robot home is mounted at `/config`, and ALA later receives that same directory through `--home`. Login and configuration created with `codex`, `opencode`, `pi`, or `claude` in the desktop or terminal therefore remain specific to that robot, while every robot shares the executable cache.

Claude Code is the fourth coding agent and, like Codex and OpenCode, can run Desktop and Browser tasks. All robots share one installation of the npm package `@anthropic-ai/claude-code`, passed to ALA as `CLAUDE_BIN`. To log a robot in, an administrator opens the robot's Terminal, runs `claude`, and logs in as usual; RoboTeam never handles those credentials. The robot shell sets `CLAUDE_CONFIG_DIR="$HOME/.claude"`, ALA receives `<robot home>/.claude`, and GUI containers receive `/config/.claude`, so the login, Claude Code's settings and its native sessions all stay in the robot home. Claude Code does not use Soul Gateway. `/model` in WebChat lists Claude's own models as ALA reads them from the installed CLI.

ALA itself runs in the outer RoboTeam container and starts the selected coding agent inside Bubblewrap. RoboTeam must be enabled in Ploinky global mode and invokes the workspace checkout at `/workspace/AdvancedLanguageAgent/bin/ala.mjs`, so local ALA contract changes such as `--home`, `--cwd`, and `--MCPServers` are available immediately during development. Invoking a real entrypoint also avoids the incorrect relative ESM resolution caused by Ploinky's Node.js symlink-preservation flags when an npm `.bin` symlink is used. RoboTeam enables ALA's structured event stream, forwards each coding-agent message to the native Ploinky task log, and keeps ALA's final standard output as the task result. Failed ALA tasks include a bounded diagnostic tail in the internal error.

The current nested RoboTeam environment cannot mount a private procfs inside an additional Bubblewrap user namespace. ALA probes the normal `--unshare-user` path first. When that specific probe fails, it keeps separate PID, IPC, and UTS namespaces and a private `/proc`, uses the outer container's admitted mount capability only while Bubblewrap constructs those mounts, and applies `--cap-drop ALL` before starting Codex. The filesystem remains read-only except for the selected cwd and controlled robot home, and the environment remains filtered. This is not an unsandboxed fallback: if neither private-proc path works, ALA fails closed. Codex also disables its redundant native sandbox because the complete Codex process already runs inside the ALA Bubblewrap boundary.

Creating a robot creates metadata and persistent directories only. It does not copy Codex, OpenCode, Pi, Claude Code, ALA, computer-use-linux, Playwright MCP, or an operating system into the robot. Service startup prepares shared generations under `/data/tool-cache`; every robot mounts or discovers those generations together with its own home and cwd. An immediate request shares and waits for any pending preparation it needs.

AchillesCLI's front copilot automatically mounts the builtin `bash` and `launch-gpt-researcher` skills. Like every robot opened in WebChat, it also receives `list-workflows`, which lists the workspace workflow types, and `launch-workflow`, which starts one. Its prompt carries no workflow catalog. `launch-workflow` calls `roboflow_start_flow` through the scoped runtime channel, which submits a native asynchronous Ploinky task, attaches it to the background observer and returns immediately. The background task carries the flow's monitoring link. The copilot cannot launch individual robots or control a flow after starting it.

## RoboFlow team workflows

RoboFlow owns directed task graphs end to end. Administrators create and edit global workflow types with prompts, skill selections and terminal, desktop or browser modes. RoboFlow chooses a matching robot at each visit and follows directed connections. The protected Standard development workflow (id `default`) has one task using the default robot and requires a caller-selected execution mode. The front copilot lists types and starts a workflow through `roboflow_start_flow`; it does not drive individual phases. SQLite retains immutable run graphs and task instances, with output files in the working directory and ordinary flow pages for monitoring and continuation. See [DS007](docs/specs/DS007-roboflow-team-workflow.md).

The **Cron jobs** tab lets administrators schedule a saved workflow at an interval or one or more daily times in an explicit time zone, inheriting its default objective. Generic Standard development and Code Development require an explicit objective; existing job overrides remain unchanged. Results default to workspace `cron-jobs-results`, created on save. **Change folder** opens a workspace directory browser with **New folder** and **Use this folder**; **Use default** restores the default. No absolute path entry is needed. The running RoboTeam service launches jobs through the same graph pipeline. Jobs persist across restart, but missed slots are skipped and the same job never overlaps its previous running or paused execution. Cards expose upcoming timing and the last run. The **⋮** menu groups **Run now**, **Enable/Disable**, **Edit job** and confirmed **Delete job**. Run now resets an enabled interval from the attempt time or selects the next configured daily occurrence; disabled jobs remain disabled after a manual run. Disabling or deleting a job leaves an already-started workflow intact. See [Cron job operations](docs/operations.html#cron-jobs).

Workflow `defaultObjective` captures the original generation request, with description or ordinary task prompts used for manual and legacy definitions. Explicit WebChat objectives take precedence; unchanged workflows may run with their default. Resolution and graph capture use the same SQLite transaction. Old executions retain their objective, while inheriting jobs resolve the latest saved default at each launch.

## Development

Administrators use each robot’s Manage skills dialog to register an HTTPS repository with a generated ID. The API also accepts absolute workspace sources and an optional explicit source name. Optional skillsets.md declares named subsets exposed through generated selection IDs. `robot_list` returns the robot description, available sets and skill frontmatter descriptions. Task calls accept comma-separated `skillSets` or its `skillset` alias for whole sets and `skills` for qualified names such as `documents/read-pdf`. AchillesCLI launch JSON also accepts arrays. Direct chat omission on the default robot selects only the copilot skillset; other robots default to empty. WebChat adds `list-workflows` and `launch-workflow` as required skills outside any selection. Workflow tasks use their configured selections: a repository's named skillsets or, when it declares none, its individual skills. Delegated task omission selects no skills. RoboTeam stores a conversation policy reference before enqueueing and captures current selected files after queue wait. RoboTeam installs the selected live links in the working directory and ALA receives no skill options; continuation resolves the current policy unless explicitly pinned. Imports and task catalogs are private robot data, separate from the shared tool cache.

`Delete robot` in the dashboard is administrator-only and requires confirmation, no unfinished tasks, and no retained container. It permanently removes that robot's home, imported repositories and task catalogs. Removing a repository makes its skills unavailable to live executions; a policy that still requires that source fails until explicitly changed. Pinned catalogs retain their captured bytes. Legacy path manifests remain unchanged and require explicit pin recovery before reuse. Source repositories remain untouched. See [Robots & Runs](docs/operations.html) for selectors and examples.

```sh
npm test
npm run check
```

The canonical runtime, desktop, and browser image definitions live in `container-image-builds/images/roboteam-agent`. The published defaults are `assistos/roboteam-agent:runtime`, `assistos/roboteam-desktop:runtime`, and `assistos/roboteam-browser:runtime`. Desktop derives from a digest-pinned LinuxServer Webtop image. Browser derives from a separate digest-pinned LinuxServer Chromium image. Both outputs are custom RoboTeam images, but their graphical stacks come from LinuxServer and account for most of their size. The browser image is separate but currently close to the desktop image in size because both include Selkies and a complete graphical runtime.

RoboTeam resolves current tool versions at startup and rechecks them on demand after the fixed six-hour interval. Shell, Desktop and Browser tools prepare concurrently after HTTP listening, so downloads do not delay service readiness. Preparation reports each family in service logs; a failed family does not stop the service, and a later request retries it. Startup creates no robot GUI session. A cache hit avoids another installation. A new version is installed in a unique staging directory, probed, stamped, and atomically activated. Concurrent requests share the same preparation promise; failed resolution or installation falls back to the last valid generation. The graphical base images remain digest-pinned. The Podman publication workflow uses the immutable stable base recorded in the image source lock, with Podman 5.8.7 and the `roboteam-runtime-v6` contract. Installation requires a successful exact Podman version check and the executable image initializer before preparing persistent data. Installation and service initialization run `/usr/local/bin/roboteam-podman-init` before using the engine. The helper establishes disposable tmpfs storage at `/var/lib/roboteam-podman` and preserves images under `/data/podman/images`.

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

Repositories without declared skillsets expose each skill’s name and description, grouped by repository ID, in robot discovery and the workflow member configuration. Individual selections use `repository-id/skill-name` in `skills` and combine with selected skillsets. Delegated tasks never receive copilot automatically; the front copilot's direct default chat initially selects only the copilot skillset. Explicit empty selection stays empty. Resume captures current selected files unless pinned.

See [Skills & Skillsets](docs/skills.html) for repository management, Markdown definitions and the execution catalog flow.

RoboTeam does not scan the workspace for instruction skills. Skill sources are the bundled catalog and repositories registered on the robot, resolved through the Ploinky marketplace endpoint; live conversation policies capture the current registered files at execution start. See [local skill discovery](docs/local-skills.html).

The creation form uses OpenCode automatically. Administrators choose one coding agent in the dialog opened by Coding agent on an existing robot card, which also displays the enabled agent. Stop the workstation and tasks before changing it, then open a new chat or terminal. The API retains support for any nonempty `codingAgents` combination. Existing robots without this field retain all four until configured. The robot home's `.ala/config.json` records the selected agent as `codingAgent` and holds one model and effort per agent; changing the agent keeps the models chosen for the others, and `/model` writes there. See [coding-agent configuration](docs/operations.html#coding-agents).
