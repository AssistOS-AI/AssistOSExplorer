# Live acceptance probes

Run these commands inside the selected robot's actual sandbox on the exact apparatus candidate. Use dedicated robots A and B. An administrator creates `marker-B` in B's home and records its tree hash and modes before testing. Keep operator controls and artifacts outside robot-writable projects. Never substitute a model's refusal for command output.

`isolation.mjs --probe <name> --robot <A> --victim <B> --workspace <absolute-root>` emits `ROBOWORK_COMMAND_PROBE_V1` only after every selected assertion succeeds. Missing prerequisites and unsupported controller-only scenarios exit non-zero. Transport the exact checked script through an admitted read-only skill folder; a model must execute the command and return its produced sentinel. Provider-free tests use synthetic inputs and do not establish live isolation.

| Probe | Additional prerequisites and evidence |
| --- | --- |
| paths | Optional `--service-pid` adds host proc-root aliases. Administrator positive control must read B's marker from RoboWork. Snapshot B's tree hash and modes before and after. |
| proc | Run inside each execution path. PID namespace, environment and proc-root checks must all succeed. Administrator control lists the service's data root. |
| fds | Runs a real `ls -l /proc/self/fd`. Focused regression inserts an inherited descriptor and requires failure. |
| masks | Start Browser and Desktop at workspace root. `--control <root-file>` must name a dedicated writable root file. Hidden data/runtime directories must be empty and an existing .env empty or unreadable. |
| service | `--router <tool-url>` requires the deployed unsigned internal-tool URL. The separate controller scenario must also prove privileged callback refusal and successful allowed workflow/research skills. |
| gui | `--denied <comma-separated-URLs>` must enumerate B's session/MCP ports, RoboWork localhost 3001/7000 and gateway 3001/7000. `--own <own-MCP-url>` must answer. Repeat inside A's GUI container and native sandbox. Administrator loopback controls must answer. |
| channels | `--foreign <other-run-channel>` and `--cache <existing-cache-file>` require known paths. Foreign context must be inaccessible; cache must be readable and reject writable opens. Controller evidence must inventory own channels. |
| hostlink | `--project <project>` requires the preplanted transcript/home links. Check victim tree hashes and modes before and after a real Copilot turn. Controller negative control removes narrowing only in an isolated test build. |

`persistence.mjs --robot <A> --marker /home/<A>/<owned-marker> --sha256 <expected> --stage <stage>` checks exact bytes, rejects symlinks and emits a command receipt. The operator invokes it at `initial`, `restart`, `recreate` and `box-recreate`, pairing each receipt with actual lifecycle command and container-generation evidence. The script itself performs no restart and does not prove one occurred.

Controller orchestration is required for planted-home symlink helper calls, other-agent masks and Explorer API, enabled-manifest agentExec inventory, refused grants, deletion, capability callbacks, home mount inode identity, image selection, real TTY controls, proxy/network effects and restart continuity. These checks must retain the approved Acceptance IDs, negative controls and exact prerequisites; none is represented by a skipped sandbox probe.
