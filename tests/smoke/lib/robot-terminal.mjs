import crypto from 'node:crypto';

import { smokeConfig } from './config.mjs';

// Helpers for driving a RoboWork robot terminal through the same HTTP routes the RoboTeam UI uses
// (roboTeamAgent/public/terminal.js): prepare the profile, discover the writable RoboWork row, create a WebTTY session
// from its launch handle, read the SSE output stream and write input. No file inside the container is read or mutated
// directly. Everything here runs in the signed-in page so the Router's session and CSRF cookies apply.

const ROBOTEAM_BASE = '/base-agent-additional-server/roboTeamAgent/3001';
const ROBOWORK_PROFILES = '/base-agent-additional-server/roboWorkAgent/3001/api/terminal-profiles';
// Text that shows a coding agent could not run a helper binary or enter its sandbox. Applied to whitespace-free text.
export const NATIVE_FAILURE = /failedto(?:invoke|record|spawn)|Nosuchfileordirectory|commandnotfound|ENOENT|EACCES|bwrap:/iu;
// True when some line of the capture is exactly the token (the model's whole reply), not merely a text containing it.
export function hasTokenLine(text, token) {
  return stripAnsi(text).split('\n').some((line) => line.trim() === token);
}

// How an OpenCode turn through the Soul Gateway ended. Only an upstream rate-limit or quota answer proves the request
// reached the gateway and was refused by the free provider; every other outcome (no output, a timeout, a connection or
// authentication error, any other HTTP status) means the route itself is broken and must fail the suite.
export function classifySoulAttempt(text, token) {
  if (hasTokenLine(text, token)) return 'answered';
  const plain = stripAnsi(text);
  if (/Soul Gateway request failed \((?:HTTP )?(?:429|402)\)|\brate[- ]?limit(?:ed)?\b|\bquota\b|too many requests/iu.test(plain)) return 'rate-limited';
  return 'broken';
}

const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

/* eslint-disable no-control-regex */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]|\u001b[78]/gu;
export function stripAnsi(text) {
  return String(text).replace(ANSI, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

// A mutation against the WebTTY or RoboWork routes: the browser CSRF cookie goes in the proof header.
export async function browserMutation(page, pathname, { method = 'POST', body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const csrf = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('ploinky_browser_csrf='))?.slice('ploinky_browser_csrf='.length) || '';
    const response = await fetch(requestPath, {
      method: requestMethod,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Ploinky-Browser-CSRF-Token': csrf },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* the caller reports the raw text */ }
    return { status: response.status, payload, text };
  }, { requestPath: pathname, requestMethod: method, requestBody: body });
}

// A RoboTeam mutation, with the administrator mutation proof the model setup helper uses.
export async function roboTeamMutation(page, method, subpath, data) {
  const token = await page.request.get('/auth/token?mutationRoute=roboTeamAgent', { maxRedirects: 0 });
  if (token.status() !== 200) throw new Error(`RoboTeam mutation proof failed: HTTP ${token.status()}`);
  const { browserMutation: proof } = await token.json();
  const response = await page.request.fetch(`${ROBOTEAM_BASE}${subpath}`, {
    method, maxRedirects: 0, data,
    headers: { origin: proof.origin, 'x-ploinky-browser-csrf-token': proof.csrfToken },
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* raw text is reported */ }
  return { status: response.status(), payload, text };
}

export async function listRobots(page) {
  const response = await page.request.get(`${ROBOTEAM_BASE}/api/robots`, { maxRedirects: 0 });
  if (response.status() !== 200) throw new Error(`Robot inventory failed: HTTP ${response.status()}`);
  const payload = await response.json();
  return payload;
}

export async function createRobot(page, name, codingAgents) {
  const result = await roboTeamMutation(page, 'POST', '/api/robots', { name, codingAgents });
  if (result.status !== 201 || !ROBOT_ID.test(result.payload?.robot?.id || '')) {
    throw new Error(`Robot create failed: HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  return result.payload.robot;
}

// A robot that is still stopping answers 409; the delete is retried a bounded number of times, then reported.
export async function deleteRobot(page, robotId, { attempts = 6, delayMs = 5_000 } = {}) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await roboTeamMutation(page, 'POST', '/api/control', { operation: 'robot-delete', robotId });
    if (result.status === 200) return result.payload;
    if (result.status !== 409 || attempt === attempts) break;
    await page.waitForTimeout(delayMs);
  }
  throw new Error(`Robot delete failed: HTTP ${result.status} ${result.text.slice(0, 300)}`);
}

async function prepareProfile(page, profileId, { deadline }) {
  for (;;) {
    const result = await browserMutation(page, `${ROBOWORK_PROFILES}/${encodeURIComponent(profileId)}/prepare`, { body: {} });
    if (result.status === 200 && typeof result.payload?.root === 'string') return result.payload;
    if (result.status !== 409 || Date.now() > deadline) {
      throw new Error(`Terminal profile prepare failed: HTTP ${result.status} ${result.text.slice(0, 300)}`);
    }
    await page.waitForTimeout(2_000);
  }
}

export class RobotShell {
  constructor(page, session, viewId, cleanupDiscovery) {
    this.page = page;
    this.session = session;
    this.viewId = viewId;
    this.closed = false;
    this.cleanupDiscovery = cleanupDiscovery;
  }

  async output() {
    return this.page.evaluate(() => window.__robotShellOutput || '');
  }

  async write(data) {
    const result = await browserMutation(this.page, `/webtty/sessions/${encodeURIComponent(this.session.id)}/input`, { body: { data } });
    if (result.status !== 200) throw new Error(`Terminal input failed: HTTP ${result.status} ${result.text.slice(0, 200)}`);
  }

  // Types one command line and waits for its unique completion marker. The shell's own echo shows the marker text
  // with a literal `$?`, so only the executed echo carries the numeric status.
  async run(command, { timeout = 60_000, label = 'cmd' } = {}) {
    const token = `${label.replace(/[^A-Za-z0-9]/gu, '')}${crypto.randomBytes(4).toString('hex')}`;
    const marker = new RegExp(`__RCA_${token}_RC=(\\d+)__`, 'u');
    const start = (await this.output()).length;
    await this.write(`${command}; echo "__RCA_${token}_RC=$?__"\r`);
    const deadline = Date.now() + timeout;
    for (;;) {
      const fresh = stripAnsi((await this.output()).slice(start));
      const match = marker.exec(fresh);
      if (match) return { code: Number(match[1]), text: fresh.slice(0, match.index) };
      if (Date.now() > deadline) return { code: null, text: fresh, timedOut: true };
      await this.page.waitForTimeout(150);
    }
  }

  // Reads a secret into a shell variable with the terminal's echo off: the key is written only after `read -s` has
  // printed its prompt, so it can never be echoed into the session's output replay.
  async readSecret(variable, secret, { timeout = 15_000 } = {}) {
    const prompt = `RCA_SECRET_PROMPT_${crypto.randomBytes(4).toString('hex')}`;
    const start = (await this.output()).length;
    await this.write(`read -rsp "${prompt.slice(0, 15)}""${prompt.slice(15)}: " ${variable}\r`);
    const deadline = Date.now() + timeout;
    while (!new RegExp(`${prompt}: `, 'u').test(stripAnsi((await this.output()).slice(start)))) {
      if (Date.now() > deadline) throw new Error('The secret prompt did not appear; the key was not written.');
      await this.page.waitForTimeout(100);
    }
    await this.write(`${secret}\r`);
  }

  // Types a command without a completion marker (a full-screen program), waits until `ready` or `failure` matches the
  // whitespace-free text it printed or the timeout passes, then interrupts it and waits for the prompt again. The text is
  // compacted because a TUI positions words with cursor movements, which leave no spaces after the escapes are removed.
  async interactive(command, { ready, failure, timeout = 25_000, settle = 0, suspend = false } = {}) {
    const start = (await this.output()).length;
    await this.write(`${command}\r`);
    const deadline = Date.now() + timeout;
    let compact = '';
    let outcome = 'timeout';
    for (;;) {
      compact = stripAnsi((await this.output()).slice(start)).replace(/\s+/gu, '');
      if (failure && failure.test(compact)) { outcome = 'failure'; break; }
      if (ready && ready.test(compact)) { outcome = 'ready'; break; }
      if (Date.now() > deadline) break;
      await this.page.waitForTimeout(200);
    }
    if (settle) {
      await this.page.waitForTimeout(settle);
      compact = stripAnsi((await this.output()).slice(start)).replace(/\s+/gu, '');
      if (outcome === 'ready' && failure && failure.test(compact)) outcome = 'failure';
    }
    await this.write('\u0003');
    await this.page.waitForTimeout(600);
    if (suspend) {
      // Ctrl-Z stops the foreground client and returns the prompt while the client and everything it started are still
      // alive, so the caller can inspect them. The caller must end the job (`kill -KILL %1`).
      await this.write('\u001a');
      await this.page.waitForTimeout(1_500);
    } else {
      await this.write('\u0003');
      await this.page.waitForTimeout(600);
      await this.write('\u0003');
      await this.page.waitForTimeout(800);
    }
    // A client may report its failure while it exits, so the whole capture is judged once more.
    compact = stripAnsi((await this.output()).slice(start)).replace(/\s+/gu, '');
    if (outcome === 'ready' && failure && failure.test(compact)) outcome = 'failure';
    return { outcome, compact };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.page.evaluate(() => { window.__robotShellSource?.close(); }).catch(() => {});
    const result = await browserMutation(this.page, `/webtty/sessions/${encodeURIComponent(this.session.id)}`, { method: 'DELETE' });
    if (![200, 404].includes(result.status)) throw new Error(`Terminal close failed: HTTP ${result.status}`);
  }
}

export async function openRobotShell(page, robotId, { cols = 200, rows = 50, prepareTimeout = 240_000, directory } = {}) {
  const profileId = `${robotId}.default`;
  const prepared = await prepareProfile(page, profileId, { deadline: Date.now() + prepareTimeout });
  if (prepared.id !== profileId) throw new Error('RoboWork returned an unexpected terminal profile.');
  const discovered = await browserMutation(page, '/webtty/target-discoveries', {
    body: { dir: directory ?? prepared.root, profile: { provider: 'roboWorkAgent', id: profileId } },
  });
  const discovery = discovered.payload?.discovery;
  if (discovered.status !== 201 || !discovery?.id) {
    throw new Error(`Terminal discovery failed: HTTP ${discovered.status} ${discovered.text.slice(0, 300)}`);
  }
  const cancel = () => browserMutation(page, `/webtty/target-discoveries/${encodeURIComponent(discovery.id)}`, { method: 'DELETE' }).catch(() => {});
  const rows_ = (discovery.targets || []).filter((target) => target.kind === 'agent'
    && target.detail === 'AchillesIDE/roboWorkAgent' && target.access === 'rw' && target.launch);
  if (rows_.length !== 1 || discovery.profile?.id !== profileId) {
    await cancel();
    throw new Error(`No unique writable RoboWork terminal row: ${JSON.stringify((discovery.targets || []).map(({ launch, ...rest }) => rest))}`);
  }
  const created = await browserMutation(page, '/webtty/sessions', {
    body: { launch: rows_[0].launch, cols, rows, closePolicy: 'stop' },
  });
  if (created.status !== 201 || !created.payload?.session?.id || !created.payload?.view?.id) {
    await cancel();
    throw new Error(`Terminal create failed: HTTP ${created.status} ${created.text.slice(0, 300)}`);
  }
  const shell = new RobotShell(page, created.payload.session, created.payload.view.id, cancel);
  await page.evaluate(({ sessionId, viewId }) => {
    window.__robotShellOutput = '';
    window.__robotShellExit = null;
    const source = new EventSource(`/webtty/sessions/${encodeURIComponent(sessionId)}/stream?view=${encodeURIComponent(viewId)}`);
    source.addEventListener('output', (event) => {
      try { window.__robotShellOutput += JSON.parse(event.data).data; } catch { /* ignore malformed frames */ }
    });
    source.addEventListener('reset', () => { window.__robotShellOutput = ''; });
    source.addEventListener('exit', (event) => { window.__robotShellExit = event.data; });
    window.__robotShellSource = source;
  }, { sessionId: shell.session.id, viewId: shell.viewId });
  return shell;
}

export const robotTerminalConfig = Object.freeze({ baseURL: smokeConfig.baseURL });
