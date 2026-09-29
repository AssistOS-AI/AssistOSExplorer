---
title: DS001-coding-style
summary: Defines source structure, runtime configuration, security practices, and tests for the nested robot runtime.
---

## Introduction

This specification is the coding and test authority for RoboTeamAgent.

## Core Content

### RoboTeam directory structure

Paths below are relative to `roboTeamAgent/`. Folders group modules by responsibility; callers import the owning module directly. Moving a module requires updating its consumers and file-relative resource paths. Do not keep forwarding modules at old locations or add compatibility index files.

| Folder | Responsibility |
| --- | --- |
| `server/` | HTTP service, robot configuration, skill policies, runtime preparation and execution lifecycle. |
| `server/roboflow/` | Workflow definitions, matching robots to tasks, graph execution and run persistence. |
| `server/plugins/` | Integrations loaded by native coding-agent runtimes. |
| `public/` | Browser pages, styles and scripts for robots, workflow editing, runs and output views. |
| `tools/` | MCP command entrypoints that expose RoboTeam operations. |
| `scripts/` | Installation, startup, data preparation and service checks. |
| `shared/` | Shared processing used by the server and copilot, including summary markers and indexes. |
| `IDE-plugins/` | Explorer contributions for launching Copilot and opening RoboTeam; each subfolder owns one contribution. |
| `copilot/` | Conversational CLI package and its integration with RoboTeam. |
| `copilot/bin/` | Executable package entrypoints. |
| `copilot/scripts/` | Package setup and maintenance scripts. |
| `copilot/src/` | CLI entrypoints and conversational implementation. |
| `copilot/src/repl/` | Interactive terminal sessions and slash-command handling. |
| `copilot/src/mcp/` | Copilot command discovery exposed through MCP. |
| `copilot/src/permissions/` | Permission protocol and approval handling. |
| `copilot/src/ui/` | Terminal rendering and interaction components. Its `contracts/`, `providers/` and `themes/` folders hold UI interfaces, implementations and appearance settings. |
| `copilot/src/skills/` | Bundled task skills. Each skill owns its descriptor, executable `scripts/` and any local `specs/`. |
| `copilot/src/lib/` | Supporting modules grouped below; shared prompts and general constants remain directly in this folder. |
| `tests/`, `copilot/tests/` | Server and copilot checks; helper and fixture subfolders hold reusable setup and test inputs. |
| `docs/` | User and developer HTML documentation and its assets. |
| `docs/specs/` | Numbered design specifications and their matrix. |
| `docs/partials/` | Shared documentation page fragments. |

### Copilot library groups

Paths below are relative to `copilot/src/lib/`. Group by the module's actual responsibility, rather than by a filename prefix alone. Keep particular modules at the root when they do not share a cohesive subject with other modules.

| Folder | Responsibility |
| --- | --- |
| `execution/` | ALA discovery and execution, request and robot context, and native interaction coordination. |
| `cli/` | CLI arguments, command dispatch and clipboard access. |
| `config/` | Runtime configuration, configuration validation and saved workspace settings. |
| `storage/` | Private workspace paths, mutation and execution locks, and conversation persistence. |
| `skills/` | Skill discovery, repository sources, effective selection, inputs and invocation origin. |
| `ploinky/` | MCP clients, agent readiness and preparing Ploinky context for task scripts. |
| `tasks/` | Background task records, events, control, continuation and live-session metadata. |
| `webchat/` | WebChat protocol, dispatch, progress, sessions, interactions, resources and task presentation adapters. |
| `diagnostics/` | Logging and metrics. |
| `errors/` | Error types and safe lifecycle error formatting. |

`prompts.mjs` centralizes prompt construction. `constants.mjs` holds general constants. `skillRuntimePolicy.mjs` sanitizes sensitive runtime values and remains separate from skill discovery despite its historical name. `lib/skills/` implements skill management; the sibling `src/skills/` contains the actual bundled skills.

Runtime JavaScript uses ECMAScript modules, four-space indentation, named exports for testable units, and Node.js built-ins where sufficient. Configuration is resolved at startup and passed to constructors; tests may supply explicit overrides.

Identifiers and public interfaces use `robot`, never `profile`. Public errors avoid secrets and cross-owner existence disclosure. Secrets remain in environment or Ploinky-generated channels and never enter manifests, browser code, examples, or logs.

Browser identity comes from Router-injected `x-ploinky-auth-info`. MCP commands call the loopback service only with the generated internal token and AgentServer-authenticated user id. Filesystem operations validate robot ids, stay beneath the data root, use restrictive modes, and replace metadata atomically.

Inner Podman commands use argument vectors. Container operations target exact names and managed labels; broad pruning and public engine sockets are prohibited. Only the allowlisted `browser` and `desktop` modes select images.

Runtime dependency preparation belongs in `server/tool-cache.mjs`. Cache updates must use unique staging directories, executable validation, immutable generations, and atomic descriptor replacement. Commands for npm and cached host tools must use a copied environment with `NODE_OPTIONS` removed because Ploinky's symlink-preservation flags are runtime-loader policy, not package-manager policy. Runtime code must accept injected cache and process implementations so tests never require network access or a real nested engine.

Tests use Node's built-in runner and temporary data roots. They cover owner isolation, validation, exact Podman arguments, lifecycle serialization, ALA execution, cache reuse and fallback, authentication, and proxy paths. Real nested Podman, upstream registry, and Selkies checks remain deployment smoke tests.

The RoboTeam dashboard must use the Explorer UI color, spacing and typography tokens, with a locally bundled Inter font. It must honor the same stored light/dark preference and browser fallback without requiring Explorer to serve assets. Cards, inputs, buttons and the repository dialog must support narrow screens and keyboard focus. Skill descriptions remain hidden in the repository dialog; skillset descriptions remain visible.

Theme initialization must run inline in the document head before rendering, without a separate HTTP asset route. It must re-read Explorer’s preference on storage changes, page restore and focus, with the browser theme used only when no preference exists.
