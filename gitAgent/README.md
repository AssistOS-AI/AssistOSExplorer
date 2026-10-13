# gitAgent

Model Context Protocol (MCP) agent for Git operations inside a Ploinky workspace.

## Responsibilities

- expose Git actions through `mcp-config.json`
- execute Git commands through `tools/git_tool.sh` and `tools/git_tool.mjs`
- keep repository access constrained to workspace roots
- provide LLM-assisted commit message generation

## Available tools

- repository lifecycle and inspection: `git_init_repository`, `git_submodule_add`, `git_info`, `git_status`, `git_repos_overview`, `git_identity`
- branch workflow: `git_branch_list`, `git_branch_checkout`, `git_branch_create`, `git_branch_merge`
- diff and ignore inspection: `git_diff`, `git_check_ignore`, `git_add_ignore`, `git_remove_ignore`
- staging workflow: `git_stage`, `git_stage_exact`, `git_unstage`, `git_untrack`, `git_restore`
- conflict workflow: `git_conflict_versions`, `git_checkout_conflict`
- remote workflow: `git_check_large_files`, `git_commit`, `git_push`, `git_fetch`, `git_pull`, `git_stash`, `git_stash_pop`
- support tools: `git_diagnose`, `git_set_identity`, `git_commit_message`

## Runtime

The agent is started through [manifest.json](./manifest.json) with:

```sh
sh /code/scripts/startAgent.sh
```

The start script loads application programming interface (API) keys from process env first and then falls back to `.ploinky/.secrets`.

The same `manifest.json` also declares the agent permission identity used for DPU-backed secret access. That identity is the source of truth for the principal granted remote-token read access.

## Environment

Filesystem validation uses these roots when present:

- `ASSISTOS_FS_ROOT`
- `WORKSPACE_ROOT`
- `PLOINKY_WORKSPACE_ROOT`

Generated-local Soul Gateway credentials and Router transport values are
Ploinky-owned. They are supplied through the mounted, verified Router descriptor
and are deliberately absent from this agent's manifest environment.

## Notes

- `git_commit_message` depends on the default LLM runtime from `achillesAgentLib`.
- The agent is decoupled from the Explorer user interface (UI). Explorer or other clients should call Git through MCP, not through shared interface internals.
- Execution tools operate only on the repository explicitly resolved from the provided path. They do not scan the workspace and do not fall back to a different repository when the target path is invalid.
- Explorer menus use a separate menu contribution plugin. The menu stays host-owned in Explorer, while `gitAgent` owns actions such as `New repository`, `Add to .gitignore`, and `Remove from .gitignore`.
- `New repository` switches to an explicit `Add Git submodule` flow when the current Explorer directory is already inside a repository. Independent init, clone, and GitHub-create operations reject nested targets.
- `git_submodule_add` accepts an existing remote and leaves the resulting `.gitmodules` entry and gitlink staged for an explicit parent-repository commit.
- Explorer selection semantics are strict: selecting any file or folder inside a repository selects that repository for repository-level actions, while commit and push flows remain limited to the selected files from that repository.
- Commit and Commit & Push capture the selection and await complete status for the selected repositories before staging, committing and pushing; Sync uses the same selection rule. Background tree loading does not control commit inputs. No-op or failed commits retain the selection and draft. Completion messages count executed operations, not fetch-only checks.
- Autosync/autocommit runs only for repositories explicitly chosen in autosync settings. It does not infer targets from the current tree selection and does not default to all discovered repositories.
- When an AutoSync push is explicitly rejected as non-fast-forward, AutoSync pulls the new remote commits and retries the push once. It never force-pushes and stops for conflicts or a second rejection.
- Before integrating remote updates, Commit, Commit & Push, Sync, Pull, and AutoSync fetch the current upstream and check for incoming commits. With no incoming commits, they leave working files and staging unchanged during this check. Incoming commits plus uncommitted work require an explicit **Stash & pull** or **Abort** choice. Closing the warning also aborts; AutoSync stops after an abort. Pause coding agents working in the repository before granting permission because stash temporarily removes local changes. Approved updates restore the stash afterward; conflicts stop the operation for review.
- `git_fetch` refreshes upstream metadata without changing working files, staging, or `HEAD`. Credential validation uses fetch, not pull. Direct `git_pull` disables Git's configured autostash; it never implicitly stashes local work.
- Commit and Push warn about Git file content of at least 50 MiB, showing paths and sizes with **Continue** or **Abort**. Commit checks added or modified staged versions; Push checks outgoing history, including files deleted in later commits. Closing the warning aborts and stops AutoSync. Staging and existing commits remain available; no files are deleted or automatically migrated to Git LFS. Push inspection uses local remote-tracking refs and can over-warn when those refs are stale. Direct MCP callers receive `large_files_warning` and must obtain user permission before retrying with the listed `approvedLargeFileOids`; approval applies only to those exact blob versions for that invocation.
- Git status reports a pending merge and its prepared message separately from unresolved files. After every conflict is resolved and staged, the commit modal pre-fills that message so manual Commit and Commit & Push can use or edit it; Sync and AutoSync complete the merge with Git's prepared message before another pull or push.
- `git_add_ignore` both appends the ignore pattern and removes already tracked paths from the Git index, including staged-but-diverged entries that require forced index removal, so ignored items stop participating in future commits unless explicitly re-added.
- `git_remove_ignore` removes the matching ignore rule and re-adds the target to Git tracking when possible.

## Documentation

- [Git specification matrix](./docs/specs/matrix.md)
- [Git documentation](./docs/index.html)
