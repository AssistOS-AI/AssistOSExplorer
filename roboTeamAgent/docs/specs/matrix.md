# Specification Matrix

| Name | Description |
| --- | --- |
| [DS000-vision](specsLoader.html?spec=DS000-vision.md) | Defines RoboTeam as one Ploinky-hosted nested-container manager for persistent robots with browser and desktop runs. |
| [DS001-coding-style](specsLoader.html?spec=DS001-coding-style.md) | Defines source structure, runtime configuration, security practices, and tests for the nested robot runtime. |
| [DS002-model-strategy](specsLoader.html?spec=DS002-model-strategy.md) | Separates deterministic robot lifecycle from ALA-selected coding-agent and model execution. |
| [DS003-main-behavior](specsLoader.html?spec=DS003-main-behavior.md) | Defines workspace robots, concurrent CLI conversations, retained visible workstations, observable delegated ALA tasks, global graph workflows, recurring scheduled execution and live agent runs. |
| [DS004-robot-container-runtime](specsLoader.html?spec=DS004-robot-container-runtime.md) | Defines persistent robot storage, runtime-only GUI images, current-version tool caching, and bounded nested Podman lifecycle. |
| [DS005-ploinky-security](specsLoader.html?spec=DS005-ploinky-security.md) | Specifies authenticated routing, administrator controls, workspace robot access, nested-container authority, secrets, and experiment limitations. |
| [DS006-ala-task-boundary](specsLoader.html?spec=DS006-ala-task-boundary.md) | Defines the outer ALA process, persistent home, cwd, MCP injection, cancellation, and resume boundary. |
| [DS007-roboflow-team-workflow](specsLoader.html?spec=DS007-roboflow-team-workflow.md) | Global task graphs, creator-selected sequential sub-workflows, human business decisions, coordinated pause and resume, SQLite execution records and directed routing. |
| [DS008-proxy-pool](specsLoader.html?spec=DS008-proxy-pool.md) | Defines how RoboTeam leases one proxy per robot from the optional proxyAgent, the direct-connection fallback, the exit-address locale, the credential-holding loopback relay, and the managed Chromium policy for Browser and Desktop workstations. |
| [DS009-robot-email-identity](specsLoader.html?spec=DS009-robot-email-identity.md) | Defines robots named by an email address, their creation from a CSV of addresses in the Robots tab, and the identity instructions their Browser and Desktop tasks receive. |
| [DS010-live-sessions](specsLoader.html?spec=DS010-live-sessions.md) | Publishes running copilot turns, delegated copilot tasks, robot tasks and workflow phases to Explorer's Live Sessions list with signed ownership, private IPC and owner-only messages. |
