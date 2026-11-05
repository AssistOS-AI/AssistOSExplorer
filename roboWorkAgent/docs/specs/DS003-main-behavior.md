---
title: DS003-main-behavior
summary: Defines robot-home ownership, resident execution and controlled interactive environments.
---

## Introduction

RoboWork provides persistent robot accounts and isolated execution for RoboTeam's conversations and workflows. RoboTeam is its sole internal controller.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Persistent robot homes | Keep native accounts and files separate across disposable executions. |
| Resident task execution | Run ALA and preserve tasks across controller restarts. |
| Interactive environments | Provide robot terminals, Browser, Desktop and chosen-image execution. |

### Persistent robot homes

RoboTeam creates or configures a robot through `robot_ensure`, `robot_config_set` and related tools. RoboWork keeps its home under workspace `.data/.private/roboWorkAgent` and presents it as `/home/<id>`. Confined helpers prepare and inspect home configuration without following robot-controlled links into another home. Deletion refuses active runs or GUI resources and removes only that robot's owned state. Administrator plain-terminal access and indirect workflow prompting retain the limits stated in DS002.

### Resident task execution

RoboTeam starts a conversation turn, task or workflow phase with `run_start`. RoboWork starts ALA using the selected robot's home, the admitted project folder as the one writable place, the rest of the workspace read-only at its canonical path with `.data`, `.ploinky`, `.ploinky-box` and the root `.env` masked as empty entries, read-only skills and per-run callback channels. RoboWork adds the workspace itself; a `run_start` caller cannot grant, widen or remove it. `run_read`, `run_input` and `run_stop` carry output, messages, callback replies and cancellation. Native inference uses ALA and the runtime-configured providers, including the robot-specific Soul Gateway socket. Robot code receives no Ploinky credential. The authoritative run inventory lets RoboTeam reattach after restart; RoboWork restart interrupts runs. Bounded logs, startup retention and replay semantics are specified in DS002.

### Interactive environments

RoboTeam requests `gui_ensure` to open Browser or Desktop and displays the returned authenticated RoboWork session URL. The same home is available at `/config` and `/home/<id>`. Administrators choose a robot and optional image environment through the RoboWork terminal profile source. A workflow Environment starts a new container from the selected agent image. Each path shows the workspace read-only next to the writable working folder, and keeps sibling homes, private service data and service loopback unreachable. Image selection does not reuse the running target's programs, credentials or localhost. DS002 defines the mounts, proxy ownership and network limits.
