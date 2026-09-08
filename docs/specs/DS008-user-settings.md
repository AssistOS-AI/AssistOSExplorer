---
title: DS008-user-settings
summary: Defines user preferences, workspace integration controls, avatar configuration, and administrator-only settings surfaces.
---

# DS008 User Settings

## Introduction

Explorer exposes settings surfaces for preferences and enabled integrations without allowing browser state to become the source of authority.

## Core Content

The Settings modal must expose the confirmed My Account, Agents, Plugins, Copilot, Keymap, Editor, Theme, Avatar, and administrator-only Administration surfaces. Settings controls must use shared WebSkel and Explorer UI components and must present loading, error, empty, and disabled states consistently.

My Account embeds the account provider’s Profile, User Management, Billing, and Applications controls, retaining their existing authorization. The former UserPersisto settings entry is labeled My Account and opens this tab instead of a separate modal. Leaving the tab or closing Settings clears transient enrollment and application secrets. The standalone authenticated account dashboard remains available to accounts without Explorer access.

Agent settings must be discovered from enabled agent manifests and loaded only when available to the current account. Plugin settings must use the Explorer settings contract, persist workspace plugin state only at `.data/explorer/plugin-settings.json`, and honor the application plugin whitelist. Agent-avatar overrides must persist only at `.data/explorer/avatar-overrides.json`. Copilot skill toggles in the Settings modal are temporary browser state and must not be presented as persisted manifest configuration. The Copilot catalog must come directly from the public `list_achilles_skills` MCP tool owned by AchillesCLI; Explorer must not import AchillesCLI discovery modules or depend on its dependency layout.

Keymap settings must support the declared file search, content search, replace, save, autocomplete, and Settings actions, including clearing individual shortcuts and restoring defaults. Theme settings must apply the supported global light or dark theme. Editor settings must keep auto-save disabled by default, apply a configurable idle interval when enabled, and preserve the external-change conflict check before saving.

Avatar settings must require authenticated access and must use the configured AxiFace integration contract. The profile avatar is browser-owned preference state. Its `expressionMode` is either `audio` or `manual` and defaults to `audio`; the shared avatar form exposes this as the automatic voice-adaptation control and disables the manual emotion selector while it is active. Choosing a WebMeet quick emotion switches the browser-scoped override to `manual`. Explorer stores and validates this preference but does not analyze microphone media; the active WebMeet browser owns local analysis and transient room projection. Agent-avatar overrides must remain unavailable unless the authenticated user has management authority. Explorer must validate returned agent configuration before rendering it and must keep a failed external avatar integration from blocking normal workspace navigation.

Explorer preinstall generates the public AxiFace pack catalog at `explorer/shared/generated/axi-face-packs.json`, an explicitly ignored Explorer asset. Explorer and WebMeet load it through `/explorer/shared/generated/axi-face-packs.json`. Pack manifests and rendering assets retain their `/explorer/shared/vendor/axi-face/` URLs. Catalog generation must leave the selected AxiFace source checkout unchanged, including when `AXIFACE_REPO_PATH` selects an external checkout; it must not generate `packs/index.json` or change ignore rules inside AxiFace.

Administrative settings must remain hidden from non-administrators. Administrative operations, including DPU data sources, must request data through the owning agent's authorized tools; the client must not reproduce administrative authorization rules or embed secrets in browser-visible configuration.

Explorer Administration loads the provider-backed users API. Registration, browser credentials, and account policy belong to UserPersisto; there is no Ploinky local login-branding component or request to the retired `/api/agents/<agent>/settings` route.

Explorer user mutations must refresh the authenticated session proof before each attempt. On the local control origin, they must send the exact-origin `adminControl` CSRF token in `x-ploinky-csrf-token`. On a public agent origin, Explorer must verify that the router's `browserMutation` metadata matches the current origin and target agent, then perform an authorized user-list read to refresh the dedicated HttpOnly, SameSite Strict user-administration cookie. Public mutations send credentials so the router can validate that cookie against the session, origin, agent route, and current generation. Browser code must not read the cookie or substitute a local-control proof on a public origin. A malformed local-control proof must fail without falling back to public administration. Ordinary settings reads do not request a separate proof. A mutation rejected with `csrf_invalid` or `browser_csrf_invalid` may refresh its proof and retry exactly once; other authorization failures are final. This public flow is specific to user administration and does not enable local-only runtime controls.

Administration user forms require email but allow an empty username and display name. Rows preserve these optional stored values instead of filling them with an email-derived label. Saving a role change for an email-only account must leave its username and display name empty unless the administrator explicitly edits them.

Administration loading, success, and error messages must remain visible inside the Settings modal and retain their live-region semantics, independently of other Explorer status styles.

## Conclusion

Settings improve the workspace experience while configuration authority remains with the configured service or owning agent.
