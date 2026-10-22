# Plan: Claude Code ca agent de cod în ALA și RoboTeam

Stare: **implementat**. Repo-uri: `AdvancedLanguageAgent` (ALA) și `AchillesCLI/roboTeamAgent`. Ploinky nu e afectat.

Verificat local cu `claude` 2.1.287 (cont autentificat) și pachetul npm `@anthropic-ai/claude-code` 2.1.289. Toate funcțiile de mai jos au fost testate practic, cu apeluri reale (model `haiku`).

## 1. Ce se poate face, funcție cu funcție

| Funcție ALA | Cum se face cu Claude Code | Testat |
|---|---|---|
| Descoperire binar | `CLAUDE_BIN`, apoi `~/.local/bin/claude`, apoi `PATH` | — |
| Instalare comună tuturor roboților | tool cache RoboTeam, pachetul npm `@anthropic-ai/claude-code` (conține binarul nativ), ca la codex/opencode/pi | `npm view` ✅ |
| Rulare headless | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | ✅ |
| Promptul turei | mesaj `{"type":"user","message":{"role":"user","content":"..."}}` pe stdin | ✅ |
| Text intermediar (View Thinking) | `stream_event` `text_delta` → `assistant` (outputId = id-ul mesajului `msg_...`); mesajele `tool_use` / `tool_result` → `output` | ✅ |
| Răspuns final | mesajul `result` (câmpurile `result`, `session_id`, `is_error`) | ✅ |
| Continuarea sesiunii | prima tură `--session-id <uuid>` (ales de ALA), apoi `--resume <uuid>`; agentul își amintește turele anterioare. Continuarea în transcript: `{sessionId}` | ✅ |
| Starea nativă | `CLAUDE_CONFIG_DIR=<home>/.claude` — tot ce scrie Claude (sesiuni, `.claude.json`, credențiale) stă acolo; rădăcina poate fi read-only | ✅ |
| Mesaje live în timpul turei | mesaje `user` suplimentare pe stdin: Claude le pune la coadă și le procesează imediat după tura curentă, în același proces (al doilea `result`) → ALA raportează `delivered` și termină tura după ultimul `result` | ✅ |
| Pauză / oprire | SIGINT/SIGTERM; există și cererea de control `interrupt` | — |
| `full-access` | `--permission-mode bypassPermissions` + `IS_SANDBOX=1` (vezi mai jos) | ✅ |
| `ask-for-approval` (Allow/Deny în webchat) | `--permission-mode default --permission-prompt-tool stdio`: Claude trimite `control_request` cu `subtype: can_use_tool` (`tool_name`, `input`, `display_name`), ALA răspunde `control_response` cu `behavior: allow` (+ `updatedInput`) sau `deny` | ✅ |
| Servere MCP (browser, computer use) | `--mcp-config '{"mcpServers":{"<nume>":{"type":"http","url":"..."}}}' --strict-mcp-config` → Claude intră în lista agenților GUI | sintaxă din docs |
| Lista dinamică de modele (`/model`) | cererea de control `initialize` întoarce modelele contului (`value`, `displayName`, `description`, `supportedEffortLevels`), ex. `opus`, `fable`, `sonnet`, `haiku` | ✅ |
| Efort | `--effort low\|medium\|high\|xhigh\|max`, validat cu `supportedEffortLevels` din `initialize` | ✅ (lista) |
| Websearch mereu activ | `WebSearch` / `WebFetch` sunt active implicit, fără flag | — |
| Sandbox bwrap | rădăcina read-only, doar `<home>/.claude` scriptibil, `DISABLE_AUTOUPDATER=1`, rețea | ✅ |

**Root**: în containerul robotului ALA rulează ca root, iar sandbox-ul păstrează uid 0. Ca root, Claude refuză `bypassPermissions` („cannot be used with root/sudo privileges”). Cu `IS_SANDBOX=1` pornește normal — testat. ALA setează variabila, pentru că agentul rulează oricum în sandbox-ul bwrap.

**Protocol**: cererile de control (`initialize`, `can_use_tool`, `interrupt`) nu sunt descrise în documentația CLI; sunt protocolul pe care Agent SDK îl folosește peste CLI. Funcționează în versiunea testată; ALA verifică o versiune minimă și răspunsul la `initialize`, ca să eșueze clar dacă protocolul se schimbă.

## 2. Ce NU se poate

- **Soul Gateway** (compatibil OpenAI) nu poate fi folosit de Claude Code, care vorbește doar API-ul Anthropic. Claude rulează cu contul Claude al userului.

## 3. Decizii

1. **Autentificare**: userul deschide Terminalul robotului, rulează `claude` și se loghează normal. RoboTeam doar instalează Claude Code și setează `CLAUDE_CONFIG_DIR=<home robot>/.claude` în shell-ul robotului, ca loginul să ajungă unde citește ALA.
2. **Binar comun**: Claude Code e instalat o singură dată în tool cache și folosit de toți roboții, ca codex/opencode/pi.
3. **Modele**: lista dinamică prin `initialize`.
4. **Ordine de rezervă**: `codex → opencode → pi → claude`.

## 4. Implementare ALA

1. Lista agenților (`discovery.mjs`, `config.mjs`, `arguments.mjs`, `cli.mjs`, `service.mjs`): `claude`, ultimul.
2. `coding-agents/claude.mjs`: runner live cu un proces `claude -p` stream-json per tură:
   - prompt pe stdin; `--session-id` / `--resume`; `--model`, `--effort`; `--mcp-config` + `--strict-mcp-config`;
   - parsare `stream_event` / `assistant` / `user` (tool_result) / `result` în `onVisibleText` și rezultat final;
   - `setMessageHandler`: mesajele live se scriu pe stdin (`delivered`), tura se termină după ultimul `result` și închiderea stdin;
   - `continuation: {sessionId}` salvată imediat după `system/init`.
3. Aprobări: puntea `can_use_tool` ↔ `permissionRequests.request(...)` ↔ `control_response`.
4. Listare modele: proces scurt `claude -p --input-format stream-json --output-format stream-json`, cererea `initialize`, apoi închidere — fără apel la model.
5. `sandbox.mjs`: `CLAUDE_CONFIG_DIR`, `IS_SANDBOX=1`, `DISABLE_AUTOUPDATER=1`, `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` în allowlist (pentru cine le folosește), `<home>/.claude` scriptibil.
6. Verificare versiune minimă (2.1.x) și a protocolului `initialize`.
7. Teste cu un `claude` fals care emite stream-json și cereri de control; documentație ALA.

## 5. Implementare RoboTeam

1. `server/coding-agents.mjs`: `claude` în `CODING_AGENT_NAMES` (ultimul) și în `GUI_CODING_AGENTS`.
2. `server/tool-cache.mjs`: pachetul `@anthropic-ai/claude-code`, executabil `claude`.
3. Dashboard (`public/skills-dialog.js`, `public/app.js`): opțiunea „Claude Code”.
4. `robot-shell.mjs`, `alaEngine.mjs` (`nativeEnvironment`), `copilot-context.mjs`: `CLAUDE_CONFIG_DIR=<home>/.claude`, `CLAUDE_BIN`, folderul `.claude` creat în home-ul robotului.
5. `alaEngine.mjs`: validarea continuării pentru `claude` (`sessionId`), `/model` cu lista dinamică.
6. `agent-model-config.mjs`: fără model implicit pentru Claude (Claude își alege singur modelul implicit).
7. Teste și documentație (cum se loghează userul în robot).
