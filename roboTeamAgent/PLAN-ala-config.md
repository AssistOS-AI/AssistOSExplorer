# Plan: configurația ALA din home-ul robotului, fără config per tură

Stare: **plan, neimplementat**. Repo-uri afectate: `AdvancedLanguageAgent` (ALA) și `AchillesCLI/roboTeamAgent`. Ploinky nu este afectat.

## Obiectiv

- ALA citește agentul de cod, modelul și efortul din `.ala/config.json` din home-ul robotului; roboteam nu mai scrie un `config.json` temporar la fiecare tură și nu mai trimite `--config`.
- Agentul de cod ales pentru un robot se salvează în același config, la fel ca modelul.
- Prioritatea agenților și websearch nu mai sunt configurabile.

## 1. ALA

### 1.1 Formatul config-ului (`<home>/.ala/config.json`)

```json
{
  "codingAgent": "opencode",
  "models": { "opencode": "opencode/big-pickle", "codex": "gpt-5.5" },
  "efforts": { "codex": "high" }
}
```

- `codingAgent`: agentul implicit (`codex`, `opencode` sau `pi`); opțional.
- `models`: câte un model per agent de cod; opțional pentru fiecare agent.
- `efforts`: câte un efort per agent, doar pentru agenții care au model configurat (regula de validare existentă).
- Config-ul nu are câmp de versiune. Dispar `version`, `codingAgents.priority` și `codingAgents.websearch`. Nu există cod de migrare sau compatibilitate cu formatul vechi; un config cu alt format este respins cu un mesaj clar.
- Locația rămâne: `--config <fișier>` explicit pentru apeluri manuale, altfel `ALA_CONFIG_PATH`, altfel `HOME` (cu `--home`, HOME este home-ul dat).

### 1.2 Alegerea agentului de cod

- Ordinea: `--ca <nume>` dacă este dat, altfel `codingAgent` din config, altfel primul agent disponibil în ordinea fixă `codex → opencode → pi`.
- Se elimină `ALA_CODING_AGENT_PRIORITY` și orice prioritate configurabilă.
- `--session-id` nu mai cere `--ca`; agentul se rezolvă după regula de mai sus. La `--resume-session`, conversația rămâne pe agentul salvat în transcript; un `--ca` sau un `codingAgent` diferit nu o mută pe alt agent (comportamentul „pinned” existent).
- Agentul rezolvat trebuie să fie instalat; altfel eroarea existentă „Coding agent is not available”.

### 1.3 Modelul și efortul

- Implicit: `models[agent]` și `efforts[agent]` din config.
- `--model <nume>` rămâne ca suprascriere pentru o singură rulare; nu modifică config-ul. Cu `--model` diferit de cel din config, efortul din config nu se aplică (regula existentă din roboteam, mutată în ALA).

### 1.4 Websearch

- Mereu pornit pentru toți agenții care îl suportă.
- Se elimină opțiunea `--websearch [on|off]`, comanda interactivă `/websearch` și câmpul din config.

### 1.5 Comenzi interactive

- `/agent <nume> model <model|default>` scrie în `models` (ca acum).
- Comandă nouă `/agent use <codex|opencode|pi>` care scrie `codingAgent`.
- `/agent list` arată și agentul implicit.

### 1.6 Teste și documentație

- Teste pentru: rezolvarea agentului (`--ca` > config > ordine fixă), modelul și efortul din config, `--model` ca suprascriere, respingerea unui config în format vechi, websearch mereu activ, `/agent use`.
- Actualizare `AGENTS.md`, `README.md`, `docs/commands.html`, spec-urile afectate.

## 2. roboTeamAgent

### 2.1 Tura (copilot `alaEngine.mjs`)

- Nu mai scrie `turns/.../config.json` și nu mai trimite `--config` și `--ca`; în folderul turei rămân `prompt.txt` și `user.txt`.
- Trimite `--model` doar când execuția cere explicit alt model (`execution.model`, de ex. `request.model` la task-urile de robot).
- `--home` rămâne home-ul robotului, de unde ALA citește config-ul.
- Agentul afișat în webchat și verificările de reluare se iau din config-ul robotului și din transcriptul ALA.

### 2.2 Model și efort din webchat

- `/model` salvează modelul și efortul în `.ala/config.json` din home-ul robotului (ca acum, prin `saveConfig` din ALA).
- Se elimină modelele și prioritatea din `.roboteam/settings.json` (`codingAgents`); modelul are o singură sursă: config-ul robotului.

### 2.3 Crearea robotului și schimbarea agentului

- La crearea robotului se scrie în config-ul ALA din home `codingAgent: "opencode"` și `models.opencode: "opencode/big-pickle"` (extinderea `agent-model-config.mjs`, apelat deja la pregătirea home-ului).
- La schimbarea agentului din dashboard (`PATCH /api/robots/:id/coding-agents`) se scrie noul agent în `codingAgent`; `models` și `efforts` rămân, deci fiecare agent își păstrează modelul ales.
- `robot.codingAgents` rămâne în recordul robotului, pentru că pe baza lui se instalează binarele agenților. Ambele se scriu la fiecare schimbare, ca să rămână sincronizate.

### 2.4 Roboții existenți

- Fără cod de migrare. La implementare rescriu manual, o singură dată, `.ala/config.json` din home-ul fiecărui robot existent (`.data/roboTeamAgent/robots/*/home/.ala/config.json`) în formatul nou: `codingAgent` din `robot.codingAgents`, `models` și `efforts` păstrate, restul eliminat.

### 2.5 Teste și documentație

- Actualizare teste pentru engine, webchat model, crearea robotului și schimbarea agentului.
- Documentație: `operations.html` (configurarea agentului și a modelului, tabelul `.roboteam` fără `config.json` în `turns/`), DS004, DS006, README-uri.

## 3. De știut

- O conversație începută cu un agent rămâne pe acel agent. Dacă robotul trece pe alt agent și binarul vechi nu mai este instalat, conversația veche nu mai poate fi continuată (comportament existent și astăzi).
- Modelul și efortul sunt per robot: comune tuturor conversațiilor și folderelor robotului.
