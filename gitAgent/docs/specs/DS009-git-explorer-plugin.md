---
title: DS009-git-explorer-plugin
summary: Users inspect changes, stage files, commit, synchronize, and resolve conflicts from the workspace shell.
---

# DS009-git-explorer-plugin

## Introduction

This specification defines the Git plugin surfaces, repository workflows, and ownership boundary between Explorer and the Git agent.

## Core Content



### Summary

Git integrates with Explorer through three application plugin surfaces:

- `git-tool-button`, mounted in `file-exp:toolbar`
- `git-menu-contributions`, contributing the `Add new repository` and `.gitignore` items to host-owned Explorer menus
- `git-clone-repository`, contributing the `Clone repository` item to the host-owned Explorer `New` menu

### Plugin Registration

According to [git-tool-button config](../IDE-plugins/git-tool-button/config.json):

- `pluginCategory`: `application`
- `id`: `git`
- `location`: `file-exp:toolbar`
- `component`: `git-tool-button`

According to [git-menu-contributions config](../IDE-plugins/git-menu-contributions/config.json):

- `pluginCategory`: `application`
- `contributionType`: `menu`
- `id`: `git`
- `location`: `file-exp:context-menu:file`, `file-exp:context-menu:directory`, `file-exp:new-menu`
- `menuModule`: `menu-contributions.js`

According to [git-clone-repository config](../IDE-plugins/git-clone-repository/config.json):

- `pluginCategory`: `application`
- `contributionType`: `menu`
- `id`: `git-clone`
- `location`: `file-exp:new-menu`
- `menuModule`: `menu-contributions.js`

### Dependency Graph

The public plugin mounts and coordinates dependent components such as:

- `git-panel`
- `git-repo-tree`
- `git-commit-actions`
- `git-commit-body`
- `git-credentials-prompt`
- `git-diff-viewer`
- `git-conflict-helper`

### Ownership Rules

Explorer owns:

- the toolbar slot
- the shared expanded modal, including fullscreen, resize, and close controls
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
- direct ignore actions in `git-panel`, without a separate pattern-editing prompt
- AI commit-message generation with a panel-local busy overlay that keeps the Git content visible, prevents duplicate generation requests, and clears after either success or failure
- compact workspace repository discovery followed by per-repository status loading for dirty repositories whose change trees are expanded

The Git panel may expand dirty repositories automatically. A repository whose quick overview status is unavailable is also expanded and verified through the detailed status path instead of being presented as clean. Expansion through either the disclosure control or repository name triggers a dedicated `git_status` request when the repository detail is not cached. At most four repository status requests run concurrently, repeated expansion reuses the cached result, Refresh invalidates that cache, and a repository-local loading or error state remains visible while its detail is unavailable.

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
3. The Git integration calls [`gitAgent`](wiki.html#definition-gitagent) over [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) for repository operations.
4. Credentials UI may capture a manual token or start GitHub device flow, but the token itself is persisted server-side in DPU Secrets.
5. Explorer refreshes its visible state after Git operations complete.

GitHub Authentication is a direct device flow without Save or Cancel controls. Selecting GitHub or opening the Authentication tab with GitHub selected shows the existing connection or immediately prepares a device code and polls the existing authorization flow. Successful approval activates the server-side DPU token directly and remembers the GitHub method. Existing valid codes resume polling rather than creating a second authorization. Clear Stored credentials and Disconnect act immediately in GitHub mode; after successful removal, the open panel prepares a fresh code if GitHub is configured. A failed removal preserves the existing connection and does not start a new flow. Panel closure ignores late UI responses but cannot undo authorization already submitted to the server.

After GitHub approval, missing identity fields are filled from the profile where available. Valid name/email edits apply locally on field blur in GitHub mode, without changing Git config. Missing or invalid identity keeps Git operations gated; a pending operation resumes only once identity is valid. Direct GitHub completion never saves Preferences or submits a manual token draft. Switching to Token stops polling in this panel; a late GitHub response must not apply the Token draft or resume its pending operation.

GitHub Disconnect displays a status spinner immediately, first with Disconnecting GitHub and then Preparing GitHub sign-in while requesting a fresh device code. The indicator ends when the request completes or fails, rather than after a timer. Duplicate Disconnect/Clear actions are disabled during this transition. Device-code preparation on initial sign-in uses the same indicator; once the code is ready the status changes to Complete sign-in in GitHub. The spinner respects reduced-motion preferences and the status is announced through a polite live region.

Token Authentication retains Save and Cancel. Identity, a newly entered manual token, method selection and Clear Stored credentials remain drafts until Save. Typing or blurring a Token field never stores or activates it. Cancel discards the draft and restores saved identity and method without deleting or replacing active credentials. Save validates the draft before persisting it. A failed token update or credential deletion leaves saved identity and method unchanged; manual replacement does not delete the previous token first.

A staged Token removal is confined to Token mode. Switching to GitHub discards that removal draft without deleting the stored token, and the GitHub presenter must never hide a server-returned code or error behind the Token Save/Cancel message. A begin response must contain either an active GitHub session or a usable device code and verification URI; otherwise the panel shows an explicit sign-in preparation error with retry guidance, stops its spinner, and does not remain silently idle.

Preferences retains its own Save and Cancel controls regardless of authentication method. Preferences Save persists only preferences and never applies an unsaved Token or pending credential removal.

Successful GitHub authentication keeps the credentials container open, including when it was first displayed by the credentials gate. GitHub Authentication provides a Close button instead of Save/Cancel. Close dismisses the credentials container and abandons unsaved preferences or identity drafts; it does not disconnect or undo the saved GitHub session. It also stops panel-owned polling and ignores late UI responses if clicked while authorization is pending. Token and Preferences retain their existing Save/Cancel behavior.

### Commit Selection And Completion

Commit and Commit & Push must capture the selected files, folder prefixes and exclusions when the user starts the action. After remote preparation, they must await a complete `git_status` response for each selected repository before staging any files. A compact overview, cached display rows or a background status request must not decide the operation's input. A missing, incomplete or failed status response stops the commit and preserves the selection and draft. Full status, including files beyond the display row limit, is intersected with the captured selection; ignored-only paths are excluded. Sync uses this same selection rule.

The operation must stage the resolved selection, await the staged status, create the commit and then push when requested. Presenter closure before a pending preparation response returns must prevent new stage, commit or push operations. Already submitted Git operations remain server-owned. This ordering uses completion of the actual requests, without an added timeout, polling or artificial delay. The existing Git command deadlines remain unchanged.

For manual Commit and Commit & Push, no selected changes means no commit and no push; the panel must state this outcome and retain the selection and commit draft. Failures and aborted operations must not clear that input. A successful batch clears only the repositories that actually committed; skipped repositories retain their selection and the draft. The completion summary reports only completed Git operations. A fetch-only remote check, an up-to-date branch, a missing upstream or an unborn branch must not increment the pull count. Completing an existing merge is reported separately from executing a pull.

### Interaction Model

The plugin follows the Explorer presenter model and uses WebSkel as the UI framework.

Conflict color has priority in the Git changes tree: a row marked `is-conflicted` remains red (`#DB5C5C`) even when it also carries modified, new, untracked, ignored or deleted classes. Other status-color rules must exclude conflicted rows.

Repository Visibility is a settings draft confined to the credentials dialog. Toggling Show agent repositories changes the checkbox and dialog's repository choices without changing the Git changes list, persisting the preference or notifying other panels. The Git changes list, including background refreshes, uses the saved visibility until Save persists the preference and applies it to the panel. Cancel restores the saved checkbox and leaves the Git changes list unchanged, including when the saved preference is enabled. An unsuccessful Save leaves the saved preference and Git changes list unchanged.

- Click actions are declared with `data-local-action` and dispatched through presenter methods.
- Form-oriented events that WebSkel does not dispatch natively, such as `input`, `change`, and selected `keydown` flows, are handled through delegated listeners attached once at component root level.
- The plugin must not bind listeners repeatedly to individual controls during rerender cycles.
- Pointer-drag and scroll synchronization behaviors may still use direct DOM listeners because they model low-level browser interaction rather than presenter actions.

### Related Specs

- [DS000-vision](specsLoader.html?spec=DS000-vision.md)

[gitAgent](wiki.html#definition-gitagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
