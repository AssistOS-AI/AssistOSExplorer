# Deployed Copilot live skills gate

This checkpoint implements the registered fixture and seven-phase C5 wiring. Live execution remains blocked in `beforeAll` until phase6 credential preflight has independently verified B+C setup and its integration has passed review. Setting `SMOKE_COPILOT_LIVE_SKILLS=1` cannot bypass that refusal. Test discovery and offline checks do not launch browsers, native backends or services.

The earlier settings rewrite was unexecuted until the deployment gate (D1/D2); Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance. That status records the earlier acceptance window. It does not waive any current C5 or final acceptance requirement.

After the reserved preflight is integrated, `npm run test:copilot-live-skills` selects one Chromium test, one worker and zero retries. It submits exactly seven requests in one continuing native Codex conversation. Each request retains the 150 second limit. The composed test retains its 25 minute limit and maximum 30 minute Box generation age.

The fixture owns two unique paths below the verified workspace. Its uncommitted Git repository contains `skills/<name>/SKILL.md` and `receipt.mjs`; the separate execution folder contains receipts and `.roboteam` conversation state. Setup refuses existing paths or robot names, discovers the exact source through Marketplace `list-repos`, creates a new robot with only `codex`, and registers that canonical source on that robot. Required DocumentationSkills must already be local. Setup never downloads a repository or prepares another backend.

Before either conversation opens, the pinned `SkillPolicies.ensure` seeds an absent owned defaults policy with the entire repository selected. Existing policy files are refused. The first browser conversation remains untouched; the browser's New action creates the conversation used by all seven requests. C5 opens WebChat with the explicit owned robot and folder. The ordinary C1 default folder-launch gate remains separate.

| Native turn | Source or policy change | Required result |
| --- | --- | --- |
| Original | Control and probe exist before defaults and conversations | Two fresh helper receipts and both source-only answers |
| Descriptor edit | Change only the probe descriptor | New descriptor answer, unchanged helper bytes and link revision |
| Helper edit | Change only the probe helper | New helper answer, unchanged descriptor bytes and link revision |
| Addition | Add a third source skill through Explorer | Execute control and added helper; three fixture skills installed; changed link revision |
| Disable | Disable probe through RoboTeam's Conversation skills page (WebChat menu) | Advancing UI policy version, persistent exclusion, fresh control receipt and no probe link or receipt |
| Re-enable | Re-enable probe through the same page | Advancing UI version, removed exclusion, restored live link and fresh control/probe receipts |
| Delete | Delete the probe source directory through Explorer | Whole-source policy handles deletion; fresh control receipt, no probe link or receipt |

Prompts contain skill names and a fresh public phase UUID. Expected answers occur only in current descriptor/helper bytes. Each generated helper runs through its actual Ploinky symlink, resolves the registered source, checks canonical cwd, and writes one receipt with exclusive creation. Its version2 receipt records run, phase, skill, invoked link, resolved source, cwd, current helper hash and time. A copied helper or replayed phase fails. Previous receipts must remain byte-for-byte unchanged.

The revision is the hash of the managed `.agents/.roboteam-links.json` records. Descriptor/helper byte edits keep it stable. Addition, deletion and selection membership change it. The reader checks real symlinks, their literal targets and canonical sources, current source hashes, `skillExecution.live`, and the completed inventory revision. Inventory alone cannot establish execution.

Conversation metadata comes from `<execution-folder>/.roboteam/sessions/<id>.json`. The deployed pinned ALA transcript API reads the matching folder transcript. The browser assistant message must join exactly one completed native turn. Raw final text, native Codex backend, robot ID, home, cwd, session and continuing thread remain bound across phases. The supported View Thinking suffix is validated separately against the metadata's exact session/message URL. The observer does not read that log or project intermediate output and tools.

Every phase preserves the untouched conversation and owned defaults. A separate read-only snapshot preserves the existing default robot's configuration, repository registration and defaults policy, including after cleanup. The default robot is never opened or mutated by C5.

Future live invocation requires the existing exact release/Box/workspace pins and `SMOKE_ALA_COMMAND` naming the deployed canonical `<workspace>/<ALA>/bin/ala.mjs`. The reader checks the executable, package and transcript-reader hashes and all imported RoboTeam contract files. It also preserves the Box/runtime generation, image, mount and source guards. Observer and native execution use the canonical workspace path; `/workspace` is not an alternate namespace.

Cleanup first cancels and proves native quiescence, then closes Copilot/settings pages, removes owned links, unregisters the owned source, deletes the owned robot, and removes its folders and project-location reference. An ambiguous setup outcome, unfinished turn, identity mismatch, deletion conflict or cleanup failure retains ownership and fails the gate. Credential cleanup and recovery remain part of the reserved phase6 integration.

The offline fixture suite uses the pinned policy service, Marketplace discovery and Ploinky link installer with disposable files. It executes generated helpers through real symlinks and produces synthetic transcripts through ALA's recorder. These checks validate seven-phase obligations and isolation. They do not claim seven deployed native turns passed.
