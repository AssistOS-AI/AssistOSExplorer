import fs from 'node:fs';

import { test, expect } from '../lib/fixtures.mjs';
import { signIn } from '../lib/auth.mjs';
import { smokeArtifactPath, smokeConfig } from '../lib/config.mjs';
import { findSecretLeaks } from '../lib/security.mjs';
import { NATIVE_FAILURE, classifySoulAttempt, createRobot, deleteRobot, hasTokenLine, openRobotShell } from '../lib/robot-terminal.mjs';

// Proves that each coding agent a RoboTeam robot can use (Codex, OpenCode, Pi, Claude Code) starts and answers inside the
// robot's Bubblewrap terminal sandbox, using the runtime image's own /usr. It drives the same routes as the RoboTeam "Open
// terminal" button (lib/robot-terminal.mjs) against a run-owned robot that is deleted afterwards, and never touches
// the `default` robot. Run it with `npm run test:robot-coding-agents`.
//
// Credentials: nothing here needs a provider login except the optional turns. A turn without its credential is
// skipped with the reason in the report; the credential is read from the environment, typed with the terminal's echo
// off and never written to the evidence. Codex also needs a login for its background app-server (the code path that
// shells out to `ps`), so that probe signs Codex in with a synthetic API key that no provider accepts; the key
// exists only in the run-owned robot's home and is removed with the robot.

const ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_ROBOT_CODING_AGENTS || '').trim());
const AGENTS = ['codex', 'opencode', 'pi', 'claude'];
const FREE_SOUL_MODEL = 'soul-gateway/openrouter-free/nvidia/nemotron-3-ultra-550b-a55b:free';
// OpenCode's own hosted free model needs no credential and is not local inference.
const OPENCODE_FREE_MODEL = 'opencode/glm-5.3-flash-free';
const SYNTHETIC_CODEX_KEY = 'sk-e2e-synthetic-not-a-real-key-0000';

// `ps` was observed failing a coding agent; the other required entries are baseline tools every robot needs. A missing
// required binary fails the suite. The advisory entries are reported with their reason and do not fail it, because no
// run of an agent was observed to need them.
const REQUIRED_BINARIES = Object.freeze([
  { name: 'ps', evidence: 'OBSERVED: Codex TUI "failed to record pid-managed app-server process ... failed to invoke ps ... No such file or directory"; Claude Code also contains `ps -o` calls (source strings, not observed)' },
  { name: 'git', evidence: 'baseline tool: coding agents run git in the workspace (not individually observed)' },
  { name: 'rg', evidence: 'baseline tool: OpenCode skill, glob and grep tools need ripgrep (Dockerfile comment; not individually observed)' },
  { name: 'curl', evidence: 'baseline tool: used by the image checks and agent shell tools (not individually observed)' },
  { name: 'bash', evidence: 'baseline tool: robot shell login and agent shell tools' },
]);
const ADVISORY_BINARIES = Object.freeze([
  { name: 'fd', reason: 'Pi find tool and @file completion call ensureTool("fd"), which downloads it from GitHub when it is absent (a run sets PI_OFFLINE=1, so its find tool then has no fd)' },
  { name: 'pgrep', reason: 'process lookup used by shell scripts and by the procps-ng package that also provides ps' },
  { name: 'pkill', reason: 'same package as ps; agents cannot stop stray processes by name without it' },
  { name: 'which', reason: 'Pi and tool scripts resolve executables with it; bash has `command -v` instead' },
  { name: 'tput', reason: 'terminal capability queries by shell scripts and TUI helpers' },
  { name: 'clear', reason: 'commonly typed in a terminal; provided by ncurses' },
  { name: 'infocmp', reason: 'terminfo inspection; provided by ncurses' },
  { name: 'lsof', reason: 'Claude Code only suggests `lsof -ti:<port>` in an OAuth port-in-use error message' },
  { name: 'script', reason: 'pseudo-terminal recording used by some agent tools' },
  { name: 'file', reason: 'content-type detection by shell tools' },
  { name: 'hostname', reason: 'Claude Code contains a `hostname -s` call (source string, not observed)' },
  { name: 'zip', reason: 'archive creation by skills' },
  { name: 'patch', reason: 'applying diffs outside git' },
  { name: 'make', reason: 'building native npm add-ons and projects' },
]);


// The shell concatenates adjacent quoted strings, so the model receives the whole token while the terminal's echo of
// the command never contains it.
function splitToken(token) {
  const middle = Math.floor(token.length / 2);
  return `${token.slice(0, middle)}""${token.slice(middle)}`;
}

function runName() {
  return `rca-${smokeConfig.runId}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-').slice(0, 40);
}

test.describe('Robot coding agents in the terminal sandbox', () => {
  test.skip(!ENABLED, 'Run with npm run test:robot-coding-agents (SMOKE_ROBOT_CODING_AGENTS=1).');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let context;
  let page;
  let robot;
  let shell;
  const evidence = { robotName: '', agents: Object.fromEntries(AGENTS.map((name) => [name, { probes: {}, turn: null }])), binaries: {} };

  async function sh(command, options) {
    // The capture begins with the terminal's echo of the command, so every assertion below uses text the command itself
    // does not contain (reply tokens are typed split in two).
    const result = await shell.run(command, options);
    return { code: result.code, timedOut: Boolean(result.timedOut), text: result.text.trim() };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(480_000);
    context = await browser.newContext({ baseURL: smokeConfig.baseURL });
    page = await context.newPage();
    await signIn(page, smokeConfig.primaryUser, '/explorer/index.html');
    robot = await createRobot(page, runName(), AGENTS);
    evidence.robotName = robot.name;
    expect(robot.codingAgents).toEqual(AGENTS);
    shell = await openRobotShell(page, robot.id);
    // Let the login shell print its first prompt.
    await expect.poll(async () => (await sh('echo ready')).text, { timeout: 60_000 }).toContain('ready');
  });

  test.afterAll(async ({}, testInfo) => {
    try {
      const payload = JSON.stringify(evidence, null, 2);
      expect(findSecretLeaks(payload), 'secret values leaked into the evidence').toEqual([]);
      fs.writeFileSync(smokeArtifactPath('robot-coding-agents-evidence.json'), payload, { mode: 0o600 });
      await testInfo.attach('robot-coding-agents-evidence.json', { body: Buffer.from(payload), contentType: 'application/json' });
    } finally {
      const failures = [];
      await shell?.close().catch((error) => failures.push(error));
      if (robot) await deleteRobot(page, robot.id).catch((error) => failures.push(error));
      await context?.close().catch((error) => failures.push(error));
      if (failures.length) throw new AggregateError(failures, 'Robot coding-agent cleanup failed.');
    }
  });

  test('the terminal runs in the Bubblewrap sandbox with the robot home and a private /proc', async () => {
    const result = await sh('echo "home=$HOME"; echo "uid=$(id -u)"; echo "pid=$(grep ^Pid: /proc/self/status | cut -f2)"; echo "tools=$(ls /data/tool-cache/shell-selections/shell/bin | tr "\\n" " ")"');
    expect(result.code).toBe(0);
    expect(result.text).toContain(`home=/home/${robot.id}`);
    // A private PID namespace numbers the shell's children from a small value, unlike the container's own /proc.
    expect(Number(/pid=(\d+)/u.exec(result.text)?.[1])).toBeLessThan(1000);
    for (const name of AGENTS) expect(result.text, `${name} must be selected for the robot`).toMatch(new RegExp(`\\b${name}\\b`, 'u'));
  });

  test('the image provides the binaries the coding agents execute', async () => {
    const names = [...REQUIRED_BINARIES, ...ADVISORY_BINARIES].map((entry) => entry.name);
    const result = await sh(`for b in ${names.join(' ')}; do p=$(command -v $b) && echo "OK $b" || echo "MISS $b"; done`);
    expect(result.code).toBe(0);
    for (const name of names) evidence.binaries[name] = new RegExp(`^OK ${name}$`, 'mu').test(result.text) ? 'present' : 'missing';
    const advisory = ADVISORY_BINARIES.filter((entry) => evidence.binaries[entry.name] === 'missing');
    test.info().annotations.push({ type: 'advisory-missing', description: advisory.map((entry) => `${entry.name} (${entry.reason})`).join('; ') || 'none' });
    // `ps` must work, not only exist: Codex asks it for a process start time, and procps-ng needs a readable /proc.
    const functional = await sh('[ "$(ps -o pid= -p $$ | tr -d " ")" = "$$" ] && ps -o lstart= -p $$ | grep -q . && echo PS_FUNCTIONAL""_OK');
    evidence.binaries.psFunctional = /^PS_FUNCTIONAL_OK$/mu.test(functional.text) ? 'works' : 'broken';
    expect(evidence.binaries.psFunctional, '`ps -o pid= -p $$` and `ps -o lstart=` must work in the sandbox').toBe('works');
    const missing = REQUIRED_BINARIES.filter((entry) => evidence.binaries[entry.name] === 'missing');
    expect(missing.map((entry) => `${entry.name}: ${entry.evidence}`), 'binaries the agents execute are missing from the robot sandbox').toEqual([]);
  });

  test.describe('Codex', () => {
    test('starts, reports its login state and answers the app-server protocol', async () => {
      const probes = evidence.agents.codex.probes;
      const version = await sh('codex --version');
      expect(version.text).toMatch(/^codex-cli \d+\.\d+\.\d+/mu);
      probes.version = /codex-cli \S+/u.exec(version.text)[0];
      const login = await sh('codex login status 2>&1');
      expect(login.text).toMatch(/Not logged in|logged in|API key configured/iu);
      probes.loginStatus = /Not logged in|API key configured|logged in/iu.exec(login.text.split('\n').slice(1).join('\n'))?.[0] ?? 'unrecognised';
      // The protocol the runs use: initialize, then a model list. No model is invoked.
      const handshake = await sh(`(printf '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"rca","version":"1"}}}\\n'; sleep 3; printf '{"method":"initialized","params":{}}\\n{"id":2,"method":"model/list","params":{"cursor":null,"limit":1}}\\n'; sleep 6) | timeout 25 codex app-server --stdio 2>&1 | cut -c1-200`, { timeout: 60_000 });
      expect(handshake.text).toMatch(/"id":1,"result":\{"userAgent":"rca\//u);
      expect(handshake.text).toMatch(/"id":2,"result":\{"data":\[/u);
      probes.appServerProtocol = 'initialize and model/list answered';
    });

    test('opens its interactive client, which starts the background app-server through ps', async () => {
      const login = await shell.run(`printf '%s' ${SYNTHETIC_CODEX_KEY} | codex login --with-api-key 2>&1 | tail -n 1`, { label: 'login' });
      expect(login.text).toContain('API key saved');
      // The client is suspended (Ctrl-Z) instead of closed, so what it started is inspected while it is alive. On a
      // fresh robot it first installs the daemon release under ~/.codex, which takes several seconds after the
      // composer appears, and a stopped client starts nothing more, so it is given 15 s before it is suspended.
      const tui = await shell.interactive('codex', { ready: /AskCodex/iu, failure: NATIVE_FAILURE, timeout: 40_000, settle: 15_000, suspend: true });
      evidence.agents.codex.probes.interactiveClient = tui.outcome;
      try {
        expect(tui.compact, 'Codex must start its background app-server without a missing-binary error').not.toMatch(NATIVE_FAILURE);
        expect(tui.outcome).toBe('ready');
        // Positive proof: the background app-server is a live process that `ps` lists, and the pid file whose start-time
        // record is the step that needs `ps` exists and is not empty.
        const probe = await sh('ps -eo pid=,ppid=,args= | grep -E "[c]odex.*app-server"; test -s ~/.codex/app-server-daemon/daemon.pid && echo DAEMON""_PID_FILE_PRESENT', { timeout: 30_000 });
        const rows = probe.text.split('\n').filter((line) => /^\s*\d+\s+\d+\s+\S*codex\S*\s+app-server/u.test(line) || /^\s*\d+\s+\d+\s+\S*\.codex\/\S*\/codex app-server/u.test(line));
        const pidFile = /^DAEMON_PID_FILE_PRESENT$/mu.test(probe.text);
        evidence.agents.codex.probes.daemonRunning = rows.length > 0 && pidFile;
        evidence.agents.codex.probes.daemonProcesses = rows.length;
        evidence.agents.codex.probes.daemonPidFile = pidFile;
        expect(rows.length, `a "codex app-server" process must be running while the client is up: ${probe.text.slice(-400)}`).toBeGreaterThan(0);
        expect(pidFile, 'the app-server daemon pid file must have been written').toBe(true);
      } finally {
        // End the stopped client and the daemon it started, whatever the outcome.
        await sh('kill -KILL %1 2>/dev/null; wait 2>/dev/null; kill $(cat ~/.codex/app-server-daemon/daemon.pid 2>/dev/null) 2>/dev/null; codex app-server daemon stop >/dev/null 2>&1; true', { timeout: 40_000 }).catch(() => {});
      }
    });

    // Recorded negative control: the same client with `ps` hidden from PATH must fail with the exact error the
    // detector looks for, so a pass of the test above cannot come from a detector that cannot fail. It also proves
    // that this Codex build reaches the ps code path at all.
    test('the Codex client fails when ps is hidden from PATH (negative control)', async () => {
      const tui = await shell.interactive('env PATH=/data/tool-cache/shell-selections/shell/bin:/usr/local/bin codex',
        { ready: /AskCodex/iu, failure: NATIVE_FAILURE, timeout: 40_000, settle: 4_000 });
      evidence.agents.codex.probes.negativeControl = tui.outcome;
      expect(tui.outcome, 'with ps hidden the client must report the missing binary').toBe('failure');
      expect(tui.compact).toMatch(/failedtoinvokeps/iu);
      await sh('codex app-server daemon stop >/dev/null 2>&1; codex logout >/dev/null 2>&1; true', { timeout: 30_000 });
    });

    test('answers one real turn', async () => {
      const key = process.env.SMOKE_ROBOT_CODEX_API_KEY || '';
      const reason = 'SMOKE_ROBOT_CODEX_API_KEY is not set; Codex has no keyless route, so no Codex turn was attempted.';
      evidence.agents.codex.turn = key ? 'attempted' : `skipped: ${reason}`;
      test.skip(!key, reason);
      await shell.readSecret('RCA_KEY', key);
      try {
        const turn = await sh('printf "%s" "$RCA_KEY" | codex login --with-api-key >/dev/null 2>&1; unset RCA_KEY; codex exec --skip-git-repo-check --sandbox danger-full-access --output-last-message ~/codex-last.txt "Reply with exactly this token and nothing else: ' + splitToken('RCA_CODEX_OK') + '" >/dev/null 2>&1; cat ~/codex-last.txt; rm -f ~/codex-last.txt; codex logout >/dev/null 2>&1', { timeout: 180_000 });
        expect(hasTokenLine(turn.text, 'RCA_CODEX_OK'), `Codex did not answer with the token: ${turn.text.slice(-200)}`).toBe(true);
        evidence.agents.codex.turn = 'answered';
      } finally {
        // The credential and the answer file never outlive the test, whatever its outcome.
        await sh('unset RCA_KEY; rm -f ~/codex-last.txt; codex logout >/dev/null 2>&1; true', { timeout: 30_000 }).catch(() => {});
      }
    });
  });

  test.describe('OpenCode', () => {
    test('starts, lists its models and serves its authenticated HTTP API', async () => {
      const probes = evidence.agents.opencode.probes;
      const version = await sh('opencode --version');
      expect(version.text).toMatch(/\d+\.\d+\.\d+/u);
      probes.version = /\d+\.\d+\.\d+/u.exec(version.text.split('\n').slice(1).join('\n'))?.[0] ?? 'unrecognised';
      const models = await sh('opencode models 2>&1', { timeout: 90_000 });
      expect(models.text).toContain(OPENCODE_FREE_MODEL);
      probes.soulGatewayModels = /^soul-gateway\//mu.test(models.text);
      // The robot must have its Soul Gateway provider and the free OpenRouter route the turn below asks for.
      expect(probes.soulGatewayModels, 'the robot OpenCode must list soul-gateway models').toBe(true);
      expect(models.text, 'the free OpenRouter route must be listed through the Soul Gateway').toContain(FREE_SOUL_MODEL);
      // The server ALA starts for a run: loopback, basic-auth, health endpoint.
      const server = await sh('OPENCODE_SERVER_USERNAME=u OPENCODE_SERVER_PASSWORD=p timeout 40 opencode serve --hostname 127.0.0.1 --port 0 > ~/oc.log 2>&1 & sleep 15; url=$(grep -o "http://127.0.0.1:[0-9]*" ~/oc.log | head -n 1); echo "URL=$url"; curl -s -m 5 -u u:p "$url/global/health"; echo; kill %1; wait', { timeout: 90_000 });
      expect(server.text).toMatch(/"healthy":true/u);
      probes.serveHealth = 'healthy';
    });

    test('answers one real turn', async () => {
      // The Soul Gateway free OpenRouter route must be reachable. It may be refused by the free provider's rate limit
      // or quota (HTTP 429/402, which proves the request reached the gateway); only then does the turn use OpenCode's
      // hosted free model, so the suite still proves a real answer. Any other Soul outcome fails the suite.
      const token = 'RCA_OPENCODE_OK';
      const ask = (model) => sh(`cd ~ && timeout 75 opencode run -m ${model} "Reply with exactly this token and nothing else: ${splitToken(token)}" 2>&1 | tail -n 8`, { timeout: 100_000 });
      const soul = await ask(FREE_SOUL_MODEL);
      const soulOutcome = classifySoulAttempt(soul.text, token);
      const turn = { soul: { model: FREE_SOUL_MODEL, outcome: soulOutcome, detail: soulOutcome === 'answered' ? '' : soul.text.replace(/\s+/gu, ' ').slice(-200) }, hosted: null, answeredBy: null };
      evidence.agents.opencode.turn = turn;
      if (soulOutcome === 'answered') {
        turn.answeredBy = FREE_SOUL_MODEL;
        return;
      }
      expect(soulOutcome, `the Soul Gateway route is broken (neither an answer nor a rate-limit/quota refusal): ${turn.soul.detail}`).toBe('rate-limited');
      const hosted = await ask(OPENCODE_FREE_MODEL);
      const hostedAnswered = hasTokenLine(hosted.text, token);
      turn.hosted = { model: OPENCODE_FREE_MODEL, answered: hostedAnswered, detail: hostedAnswered ? '' : hosted.text.replace(/\s+/gu, ' ').slice(-200) };
      if (hostedAnswered) turn.answeredBy = OPENCODE_FREE_MODEL;
      expect(hostedAnswered, `OpenCode produced no answer: ${JSON.stringify(turn)}`).toBe(true);
    });
  });

  test.describe('Pi', () => {
    test('starts, lists models and answers its RPC protocol', async () => {
      const probes = evidence.agents.pi.probes;
      const version = await sh('pi --version');
      expect(version.text).toMatch(/\d+\.\d+\.\d+/u);
      probes.version = /\d+\.\d+\.\d+/u.exec(version.text.split('\n').slice(1).join('\n'))?.[0] ?? 'unrecognised';
      const list = await sh('timeout 60 pi --list-models > ~/pi-models.txt 2>&1; rc=$?; head -n 5 ~/pi-models.txt; echo "PI_LIST_RC=$rc"', { timeout: 90_000 });
      expect(list.text, '`pi --list-models` must exit normally, not time out').toMatch(/PI_LIST_RC=0/u);
      expect(list.text.replace(/\s+/gu, '')).not.toMatch(NATIVE_FAILURE);
      // The mode the runs use: one RPC request, no model call.
      const rpc = await sh(`(printf '{"type":"get_state"}\\n'; sleep 8) | timeout 25 pi --mode rpc --no-session --no-extensions --no-skills 2>&1 | cut -c1-200 | head -n 3`, { timeout: 60_000 });
      expect(rpc.text).toMatch(/"command":"get_state","success":true/u);
      probes.rpcProtocol = 'get_state answered';
    });

    test('answers one real turn', async () => {
      const reason = 'Pi has no keyless route and this suite injects no Pi provider credential; no Pi turn was attempted.';
      evidence.agents.pi.turn = `skipped: ${reason}`;
      test.skip(true, reason);
    });
  });

  test.describe('Claude Code', () => {
    test('starts, reports its login state and answers the stream-json control protocol', async () => {
      const probes = evidence.agents.claude.probes;
      const version = await sh('claude --version');
      expect(version.text).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)/mu);
      probes.version = /\d+\.\d+\.\d+ \(Claude Code\)/u.exec(version.text)[0];
      const status = await sh('claude auth status 2>&1');
      expect(status.text).toMatch(/"loggedIn":\s*(?:true|false)/u);
      probes.loginStatus = /"loggedIn":\s*true/u.test(status.text) ? 'logged in' : 'not logged in';
      const control = await sh(`(printf '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}\\n'; sleep 8) | timeout 25 claude -p --input-format stream-json --output-format stream-json --verbose 2>&1 | cut -c1-200 | head -n 3`, { timeout: 60_000 });
      expect(control.text).toMatch(/"type":"control_response","response":\{"subtype":"success","request_id":"r1"/u);
      probes.controlProtocol = 'initialize answered';
    });

    test('opens its interactive client', async () => {
      const tui = await shell.interactive('claude', { ready: /WelcometoClaudeCode|Choosethetextstyle|Let'sgetstarted|Paste.*code|Selectlogin/iu, failure: NATIVE_FAILURE, timeout: 40_000, settle: 2_000 });
      evidence.agents.claude.probes.interactiveClient = tui.outcome;
      expect(tui.compact).not.toMatch(NATIVE_FAILURE);
      expect(tui.outcome).toBe('ready');
    });

    test('answers one real turn', async () => {
      const key = process.env.SMOKE_ROBOT_CLAUDE_API_KEY || '';
      const reason = 'SMOKE_ROBOT_CLAUDE_API_KEY is not set; Claude Code has no keyless route, so no Claude turn was attempted.';
      evidence.agents.claude.turn = key ? 'attempted' : `skipped: ${reason}`;
      test.skip(!key, reason);
      await shell.readSecret('ANTHROPIC_API_KEY', key);
      await sh('export ANTHROPIC_API_KEY');
      const turn = await sh('claude -p "Reply with exactly this token and nothing else: ' + splitToken('RCA_CLAUDE_OK') + '" --permission-mode bypassPermissions 2>&1 | tail -n 10; unset ANTHROPIC_API_KEY', { timeout: 180_000 });
      expect(hasTokenLine(turn.text, 'RCA_CLAUDE_OK'), `Claude Code did not answer with the token: ${turn.text.slice(-200)}`).toBe(true);
      evidence.agents.claude.turn = 'answered';
    });
  });
});
