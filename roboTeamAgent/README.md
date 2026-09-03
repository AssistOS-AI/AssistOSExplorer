# RoboTeamAgent

RoboTeamAgent is a globally enabled Ploinky dependency that manages owner-scoped robots, persistent coding-agent homes, visible GUI containers, and asynchronous ALA tasks. Each owner gives robots unique names; all MCP task tools address a robot by `robotName`.

Each robot has one execution slot. The slot may hold one desktop container, one lighter browser container, or one simple ALA process. A GUI container may remain live after its ALA task stops, so a person can inspect or control the exact same visible session. The container must be stopped explicitly before another mode can use the slot.

Desktop tasks use the current computer-use-linux release behind the current Supergateway package on a loopback-only Streamable HTTP bridge. Browser tasks use the current Playwright MCP package connected through CDP to the Chromium window shown by Selkies. These tools are resolved and installed into a persistent shared cache on first use instead of being baked into the images or declared in RoboTeam's `package.json`. In both modes RoboTeam starts ALA separately, gives it the caller's `cwd`, derives `--home` from the robot's persistent home, and injects the MCP bridge URL without rewriting saved Codex configuration.

The dashboard and `openDesktopForRobot` also start a desktop without ALA. Before the first desktop starts, RoboTeam prepares the current Codex package and mounts that cached generation read-only at `/opt/roboteam-codex`; the container PATH exposes its executable. The robot home is mounted at `/config` and later passed to ALA as `--home`, so `codex login` performed in the desktop and an ALA task use the same robot-specific configuration while sharing one cached Codex installation.

Creating a robot creates metadata and persistent directories only. It does not install or copy Codex, ALA, computer-use-linux, Playwright MCP, or an operating system into the robot. The first operation that needs a runtime tool prepares a shared generation under `/data/tool-cache`; every robot then mounts that generation together with its own home and cwd.

## Development

```sh
npm test
npm run check
```

The canonical runtime, desktop, and browser image definitions live in `container-image-builds/images/roboteam-agent`. The published defaults are `assistos/roboteam-agent:runtime`, `assistos/roboteam-desktop:runtime`, and `assistos/roboteam-browser:runtime`. Desktop derives from a digest-pinned LinuxServer Webtop image. Browser derives from a separate digest-pinned LinuxServer Chromium image. Both outputs are custom RoboTeam images, but their graphical stacks come from LinuxServer and account for most of their size. The browser image is separate but currently close to the desktop image in size because both include Selkies and a complete graphical runtime.

RoboTeam resolves current tool versions at first use and rechecks them after a configurable interval, six hours by default. A cache hit starts immediately. A new version is installed in a unique staging directory, probed, stamped, and atomically activated. Concurrent requests share the same preparation promise; failed resolution or installation falls back to the last valid generation. The graphical base images remain digest-pinned, and the Podman publication workflow resolves its rolling version-6 channel once to an exact digest for every architecture in one run.

See [the documentation](docs/index.html) and [the design specifications](docs/specs/matrix.md) for the complete contract.
