---
title: DS003-main-behavior
summary: Defines the gitAgent contract covered by DS003-main-behavior.
---

# DS003-main-behavior

## Introduction

The main behavior of gitAgent is the user and integration outcome described by this contract.

## Core Content

### DS02 - Git Explorer Plugin

### Summary

Git integrates with Explorer through three application plugin surfaces:

- `git-tool-button`, mounted in `file-exp:toolbar`
- `git-menu-contributions`, contributing the `Add new repository` and `.gitignore` items to host-owned Explorer menus
- `git-clone-repository`, contributing the `Clone repository` item to the host-owned Explorer `New` menu

### Plugin Registration

According to [git-tool-button config](../../../IDE-plugins/git-tool-button/config.json):

- `pluginCategory`: `application`
- `id`: `git`
- `location`: `file-exp:toolbar`
- `component`: `git-tool-button`

According to [git-menu-contributions config](../../../IDE-plugins/git-menu-contributions/config.json):

- `pluginCategory`: `application`
- `contributionType`: `menu`
- `id`: `git`
- `location`: `file-exp:context-menu:file`, `file-exp:context-menu:directory`, `file-exp:new-menu`
- `menuModule`: `menu-contributions.js`

According to [git-clone-repository config](../../../IDE-plugins/git-clone-repository/config.json):

- `pluginCategory`: `application`
- `contributionType`: `menu`
- `id`: `git-clone`
- `location`: `file-exp:new-menu`
- `menuModule`: `menu-contributions.js`

### Dependency Graph

The public plugin mounts and coordinates dependent components such as:

- `git-commit-modal`
- `git-repo-tree`
- `git-commit-actions`
- `git-commit-body`
- `git-credentials-prompt`
- `git-diff-viewer`
- `git-conflict-helper`

### Ownership Rules

Explorer owns:

- the toolbar slot
- the rendered context menu and `New` menu surfaces
- the current host context
- generic page refresh events

The Git plugin owns:

- repository selection
- stage/unstage state
- commit, pull, push, and sync flows
- Git authentication prompts
- conflict resolution user interface (UI)
- menu action semantics such as `Add new repository` and `Clone repository` in the host-owned Explorer `New` menu
- menu action semantics such as `Add to .gitignore` and `Remove from .gitignore`
- direct ignore actions in `git-commit-modal`, without a separate pattern-editing prompt
- AI commit-message generation with a modal-local busy overlay that keeps the Git content visible, prevents duplicate generation requests, and clears after either success or failure
- compact workspace repository discovery followed by per-repository status loading for dirty repositories whose change trees are expanded

The commit modal may expand dirty repositories automatically. A repository whose quick overview status is unavailable is also expanded and verified through the detailed status path instead of being presented as clean. Expansion through either the disclosure control or repository name triggers a dedicated `git_status` request when the repository detail is not cached. At most four repository status requests run concurrently, repeated expansion reuses the cached result, Refresh invalidates that cache, and a repository-local loading or error state remains visible while its detail is unavailable.

For ignore actions in Explorer context menus, the owning Git behavior is:

- `Add to .gitignore` appends the selected file or directory pattern to the repository `.gitignore`
- if the target is already tracked, `Add to .gitignore` removes it from the Git index, including cases where the index contains staged content that diverges from both `HEAD` and the worktree
- `Remove from .gitignore` removes the matching ignore rule and restores tracking when possible
- the file remains on disk in both cases

For the host-owned Explorer `New` menu, the owning Git behavior is:

- `Add new repository` uses the current Explorer directory as the parent path and opens a repository creation modal
- the Explorer global loader is shown from the menu action until the repository modal is rendered, and again after the modal closes until the repository operation and directory refresh complete and the new directory is visible in the Explorer tree
- the add modal lists the available GitHub organizations and, on selection, fills an editable remote URL with the selected organization URL
- outside a Git worktree, the add flow resolves from the remote: a GitHub repository URL, or a selected owner combined with the repository name, creates the remote through `git_create_github_repository`; any other remote URL initializes a local repository through `git_init_repository`
- `Clone repository` uses the current Explorer directory as the parent path and clones a selected GitHub repository, or a manual remote URL, into a new child directory
- inside a Git worktree, both the add and clone entries open an explicit `Add Git submodule` mode for an existing GitHub repository or a manual remote URL
- submodule mode accepts an editable local directory name, runs against the nearest enclosing repository, and refreshes Explorer after success
- creating or cloning an independent nested repository is forbidden; callers must use `git_submodule_add`
- submodule addition follows standard Git staging behavior: `.gitmodules` and the gitlink are staged, but no commit or push is automatic
- GitHub repository creation is unavailable in submodule mode because a new empty repository has no checkoutable commit
- GitHub repository remotes are stored in canonical clone form, such as `https://github.com/owner/name.git`
- manual initialization and clone flows reject a canonical remote that is already configured by another repository in the workspace, report the existing path, and create no target directory; equivalent GitHub HTTPS and SSH URLs count as the same remote
- if a later push needs to create a missing GitHub remote repository, Git authentication must be requested before the GitHub create call is attempted
- GitHub remote creation must target the owner encoded in the remote URL: use the authenticated user's repository endpoint only when that owner matches the authenticated login, otherwise use the organization repository endpoint for that owner

### Behavioral Specification

1. Explorer mounts toolbar plugins and resolves menu contributions for host-owned menu surfaces.
2. Git UI components or Git menu modules read the current Explorer context.
3. The Git integration calls `gitAgent` over Model Context Protocol (MCP) for repository operations.
4. Credentials UI may capture a manual token or start GitHub device flow, but the token itself is persisted server-side in DPU Secrets.
5. Explorer refreshes its visible state after Git operations complete.

### Interaction Model

The plugin follows the Explorer presenter model and uses WebSkel as the UI framework.

- Click actions are declared with `data-local-action` and dispatched through presenter methods.
- Form-oriented events that WebSkel does not dispatch natively, such as `input`, `change`, and selected `keydown` flows, are handled through delegated listeners attached once at component root level.
- The plugin must not bind listeners repeatedly to individual controls during rerender cycles.
- Pointer-drag and scroll synchronization behaviors may still use direct DOM listeners because they model low-level browser interaction rather than presenter actions.

### Related Specs

- [DS000-vision](specsLoader.html?spec=DS000-vision.md)

## Conclusion

gitAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
