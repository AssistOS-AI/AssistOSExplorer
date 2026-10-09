---
title: DS013-web-cli-chat
summary: Defines the DS013-web-cli-chat contract for WebAssist.
---

# DS013-web-cli-chat

## Introduction

This specification defines the active DS013-web-cli-chat contract for WebAssist.

## Core Content

### DS010 - web-assist-chat

### Goal
Define the active plugin contract for the Web CLI chat integration.

### Plugin Identity
- **Plugin folder**: `webAssist/IDE-plugins/web-assist-chat/`
- **Config id**: `webassist-chat`
- **Component**: `web-assist-chat`
- **Presenter**: `WebAssistChat`
- **Type**: `global`
- **Settings component**: `webassist-settings`

### Runtime Surface
- Chat UI is served through:
  - `web-assist-chat.html`
  - `web-assist-chat.css`
  - `web-assist-chat.js`
- Settings generates Preview and iframe snippets targeting `web-assist-chat.html`.
- Iframe UX is launcher-based:
  - initial state is closed (chat icon visible),
  - click icon opens chat panel,
  - close button (`X`) in header closes panel.

### Runtime Contract
- MCP endpoint: `/webAssist/mcp` (always; no token-based routing)
- Tools:
  - `web_cli_chat` with `{ siteId, message, sessionId?, sessionSecret?, json: true }`
  - `web_cli_history` with `{ siteId, sessionId, sessionSecret? }`
- The session secret is stored in `localStorage` beside the session id (`webassist-chat:sessionSecret:<siteId>`) and sent with both tools.
- `web-assist-chat.js` handles:
  - message parsing/sanitization,
  - session persistence,
  - history hydration,
  - typing/send UI behavior.

### MCP Client
- Client module: `/MCPBrowserClient.js`
- Loaded dynamically via `import()`
- Calls `callTool()` for chat and history operations
- Parses only the stdout block of tool responses as JSON to extract response text, `sessionId` and `sessionSecret`; raw tool text is never rendered

### Session Data Layout
- Session profile: `sessions/<sessionId>-profile.md` — profile details and contact information
- Session history: `sessions/<sessionId>-history.md` — conversation transcript
- History is appended automatically by the runtime after each turn, independent of the `webassist-session` skill

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
