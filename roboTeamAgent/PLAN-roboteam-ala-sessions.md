# Plan: conversațiile salvate de ALA, `.achilles-cli` → `.roboteam`

Stare: **plan, neimplementat**. Repo-uri afectate: `AdvancedLanguageAgent` (ALA) și `AchillesCLI/roboTeamAgent`. Ploinky nu este afectat (nu citește `.achilles-cli` și primește conversația de la copilot în același format).

## Obiectiv

- ALA este **singurul** care scrie și citește textul conversațiilor: mesajul userului, mesajele intermediare ale coding agents (ce se vede azi în „View Thinking”) și răspunsul final.
- Conversațiile se salvează **append-only, JSONL**, în folderul de lucru, în `.roboteam/.ala`.
- Configurația ALA (prioritate coding agents, model, effort, websearch) rămâne în home-ul agentului/robotului, în `.ala/config.json`.
- Roboteam (copilot + server) se ocupă de tot restul: metadatele sesiunii, atașamente, setări, task-uri, workflows, roboflow, skill-uri.
- O sesiune ALA corespunde 1:1 unei sesiuni roboteam (același `sessionId`).
- `.achilles-cli` devine `.roboteam` (redenumire). Fără migrare; datele vechi se șterg.

## Structura pe disc

```
<home agent/robot>/.ala/
  config.json                      # config ALA (ALA_CONFIG_PATH, neschimbat)

<folder de lucru>/.roboteam/       # creat de roboteam
  .gitignore                       # conține "*"
  .ala/                            # ALA_SESSIONS (setat de roboteam), scris doar de ALA
    sessions/<sessionId>.jsonl     # conversația user ↔ LLM, append-only
    sessions/<sessionId>.jsonl.lock
    pi/                            # sesiunile native pi (azi <cwd>/.ala-pi-sessions)
  sessions/<sessionId>.json        # metadatele roboteam ale sesiunii (fără mesaje)
  settings.json                    # model, permissions, disabledSkills, currentSessionId
  history                          # istoricul REPL
  tasks/ locks/ repos/ roboflow/ roboflow-generation/
  turns/                           # fișiere temporare per tură (azi ala/turns)
```

## 1. ALA (AdvancedLanguageAgent)

### 1.1 Variabila `ALA_SESSIONS`
- Indică folderul `.ala` în care se scriu sesiunile (roboteam o setează la `<cwd>/.roboteam/.ala`).
- Dacă lipsește, default: `<cwd>/.ala` (cwd = parametrul `--cwd` dat la ALA).
- ALA creează `sessions/` și `pi/` cu mod 0700, fișierele cu 0600.
- `ALA_CONFIG_PATH` rămâne cum e pentru config (nu se adaugă altă variabilă).
- `<home>/.ala/sessions/` nu se mai folosește deloc.

### 1.2 Formatul `sessions/<id>.jsonl`
O linie = un eveniment, scris o singură dată, niciodată rescris. Fiecare linie are `seq` (crescător), `type`, `at` (ISO) și `turnId` unde e cazul.

| type | conținut |
|---|---|
| `session` | `id`, `createdAt`, `agent` (codex/opencode/pi) — prima linie |
| `user` | `text`: textul exact scris de user (fără atașamente, care sunt ale roboteam) |
| `agent-message` | mesaje intermediare ale coding agent: `outputKind` (`assistant`/`output`), `outputId`, `text` |
| `tool` | evenimente `agentlib-tool` (`tool`, `reason`) |
| `final` | răspunsul final (= stdout ALA) |
| `turn-end` | `status` (`completed`/`failed`/`interrupted`), `durationMs` |
| `continuation` | pointerul la sesiunea nativă (codex `threadId`, opencode `sessionId`, pi `sessionId`+`sessionFile`); la citire contează ultima linie |

- Mesajele trimise în timpul turei (`--control-stdin`) se scriu tot ca `user`, cu `displayText` venit în recordul de control.
- `continuation` înlocuiește `<home>/.ala/sessions/<id>.json`; `--resume-session` îl citește din JSONL.
- Verificarea la resume se reduce la `sessionId` + `agent` (fără comparare de căi `home`/`workspace`).

### 1.3 Parametri noi CLI
- `--user-message-file <path>`: textul brut al userului, separat de promptul împachetat din `--taskFile` (care conține system prompt, skill, catalog etc.). Dacă lipsește, ALA înregistrează conținutul `--taskFile`.
- `--turn-id <id>`: id-ul turei, folosit de roboteam pentru a lega metadatele (atașamente, task-uri pornite) de tură.

### 1.4 Lock
- Rămâne lock-ul existent per sesiune (`<id>.jsonl.lock`), care împiedică două procese ALA să scrie simultan în aceeași sesiune (ex. două tab-uri care continuă aceeași conversație).
- În lock se adaugă hostname-ul, ca un lock creat din alt container să nu fie considerat abandonat doar pentru că pid-ul nu există local.

### 1.5 Reader exportat
- `package.json` primește `exports: { "./transcript": "./src/transcript.mjs" }`.
- `readSession(alaDir, id)` → ture reconstruite: `[{ turnId, user, agentMessages[], final, status, durationMs }]` + `continuation` + `createdAt`/`updatedAt`/`title` (primul mesaj user).
- `readSessionSummary(alaDir, id)` → doar `createdAt`, `updatedAt`, `title` (citește începutul fișierului + mtime), pentru lista de sesiuni.
- `readTurn(alaDir, id, turnId)` → pentru „View Thinking”.
- Roboteam importă reader-ul prin `alaInstallation.mjs` (mecanismul de import existent).

### 1.6 Alte modificări ALA
- Sesiunile pi: din `<workspace>/.ala-pi-sessions` în `<ALA_SESSIONS>/pi/`.
- Teste noi: scriere/append, resume din `continuation`, reader, default fără `ALA_SESSIONS`, lock cu alt hostname.

## 2. roboTeamAgent

### 2.1 Redenumire `.achilles-cli` → `.roboteam`
- Constanta din `copilot/src/lib/storage/privateDataRoot.mjs` și copiile hardcodate: `copilot/src/lib/constants.mjs`, `copilot/src/lib/execution/alaEngine.mjs` (`--ignore`), `copilot/src/lib/webchat/webchatTurnLog.mjs`, `copilot/src/lib/webchat/webchatWorkspaceFiles.mjs`, `server/roboflow/task-flow-store.mjs`, `server/roboflow/roboflow-service.mjs`, fixture-ul de test.
- `.roboteam/.gitignore` cu `*`, creat la crearea folderului.
- Teste și documentație actualizate.

### 2.2 Pornirea ALA
- **Webchat/REPL** (`alaEngine.mjs`): setează `ALA_SESSIONS=<cwd>/.roboteam/.ala`, scrie `--user-message-file`, trimite `--turn-id`. Folderul temporar per tură: `.roboteam/turns/`.
- **REPL standalone** (fără RoboTeam): config ALA în `~/.ala/config.json` (HOME-ul userului), conversațiile în `<cwd>/.roboteam/.ala`. Dispare home-ul implicit `.achilles-cli/ala/home`.
- **Task-urile roboților** (`server/runtime-manager.mjs`): setează `ALA_SESSIONS=<cwd>/.roboteam/.ala` (cwd e montat în container la aceeași cale ca pe disk, deci calea e aceeași pentru server și container). Config-ul rămâne în home-ul robotului. Pentru task-uri, echivalentul roboteam al sesiunii este recordul de task existent; nu se creează `.roboteam/sessions/<id>.json`.

### 2.3 Metadatele sesiunii roboteam: `.roboteam/sessions/<id>.json`
Același `sessionId` ca sesiunea ALA (1:1). Conține tot ce nu e mesaj user ↔ LLM:
- `createdAt`, `cwd`, robotul/backend-ul legat (`engine` fără câmpurile de text);
- politica de skill-uri: `skillPolicyRef`, `skillSelection`, `skillExecution`, `previousSkillExecution`;
- atașamentele și referințele, per `turnId`;
- indexul de rezumate: `summaryRefs`, `summaryIndexVersion`.

Fișierul e mic și se scrie atomic (temp + rename), ca acum, sub lock-ul de workspace existent.

### 2.4 Conversațiile nu mai sunt scrise de roboteam
- `conversationSessionStore.mjs` nu mai scrie `messages[]`; devine store doar pentru metadatele de la 2.3.
- Lista de sesiuni = fișierele din `.roboteam/sessions/` (deci doar sesiunile roboteam, nu și sesiunile ALA ale task-urilor de robot), cu titlul și datele luate din `readSessionSummary`. O sesiune nouă, fără nicio tură, apare cu titlu implicit.
- Încărcarea unei sesiuni = turele ALA (`readSession`) + atașamentele/referințele din metadate, potrivite după `turnId`. Formatul trimis la webchat (envelope-ul sesiunii) rămâne același, deci ploinky nu se schimbă.
- `/session new|resume`, `currentSessionId` în `settings.json` funcționează ca acum.
- Comenzile `/` (ex. `/tasks`) nu trec prin ALA și nu se salvează în conversație; `/tasks` afișează task-urile din folderul de lucru.
- Cardurile de task din chat se reconstruiesc din recordurile de task (`tasks/<id>/task.json` au deja `sessionId` și `turnId`), afișate după tura care le-a pornit.
- Link-ul „View Thinking” nu mai e lipit în textul răspunsului; se generează la afișare din `turnId`. Ruta din `server/http-server.mjs` citește prin `readTurn`.
- `webchatTurnLog.mjs` și `logs/<sessionId>/<messageId>.log` dispar (mesajele intermediare sunt în JSONL-ul ALA).

### 2.5 Rezumate (`server/impact-summaries.mjs`)
- `summaryLogRefs` cu offset-uri în `.log` devin intervale de `seq` din JSONL-ul ALA.
- Indexul de rezumate (`summaryRefs`) rămâne în metadatele de la 2.3.

### 2.6 Alți cititori de actualizat
- `server/project-storage.mjs` (`findProjectRecord` pentru `sessions/<id>.json`).
- `server/live-skill-catalog.mjs:324` (readdir pe `sessions/` pentru GC catalog).
- `server/skill-policy.mjs`, `server/skill-catalog-api.mjs`, `copilot/src/lib/skills/robotSkillCatalog.mjs` (politica de skill-uri per sesiune).
- `copilot/src/mcp/list-slash-commands.mjs`, `copilot/src/repl/REPLSession.mjs`, `copilot/src/lib/webchat/webchatRuntime.mjs`, `copilot/src/lib/webchat/webchatSessionState.mjs`, `copilot/src/index.mjs`.

### 2.7 Ștergerea datelor vechi (o singură dată, la pornire)
- `<home robot>/.ala/sessions/` pentru fiecare robot.
- `<folder>/.achilles-cli/` și `<folder>/.ala-pi-sessions/` pentru fiecare proiect înregistrat (registry din `project-storage`). Confirmat: se șterg și task-urile, log-urile și output-urile roboflow vechi.
- Pornirea se marchează cu un fișier marker, ca ștergerea să ruleze o singură dată.

## 3. Permisiuni / vizibilitate
- Containerele roboților rulează cu `PUID=0` sub podman rootless, deci fișierele scrise de ALA în `.roboteam/.ala` ar trebui să aparțină uid-ului care rulează roboteam și să poată fi citite de server. De verificat la implementare cu un test end-to-end (task robot → citire transcript din server).
- Roboteam e agent activat global, deci `.roboteam` din orice folder de lucru trebuie să fie citibil de procesul roboteam; modurile 0700/0600 sunt ok cât timp proprietarul e același uid.

## 4. Ordinea implementării
1. ALA: `ALA_SESSIONS`, scriere JSONL, `continuation` în JSONL, parametrii noi, reader, lock, teste.
2. roboTeamAgent: redenumirea `.roboteam` + `.gitignore`.
3. roboTeamAgent: store-ul de metadate (2.3), setarea `ALA_SESSIONS` (webchat, REPL, roboți) și citirea conversațiilor prin reader.
4. roboTeamAgent: „View Thinking”, rezumate, cititorii din 2.6.
5. Ștergerea datelor vechi, verificarea permisiunilor, teste, documentație (DS003, DS006, DS007, README-uri).

## 5. Decizii luate
- `.roboteam/.ala` (cu punct) pentru conversații; `ALA_SESSIONS` opțional, default `<cwd>/.ala`.
- `ALA_CONFIG_PATH` rămâne pentru config, care stă în home-ul agentului.
- „View Thinking” = mesajele intermediare ale coding agents, salvate de ALA.
- Atașamentele și celelalte metadate non-mesaj sunt ale roboteam, în `.roboteam/sessions/<id>.json`, relație 1:1 cu sesiunea ALA.
- Comenzile `/` nu se salvează în conversație.
- REPL standalone: config în `~/.ala`, conversații în `<cwd>/.roboteam/.ala`.
- Fără migrare; datele vechi se șterg.

## 6. Întrebări deschise
Niciuna în acest moment.
