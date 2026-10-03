import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

import { program, readRegistryAndRuntime, validateLiveSkillsRuntimeBinding } from './copilot-live-skills-runtime.mjs';

// Box exec-chain runner and the in-RoboTeam programs of the Codex-authenticated Copilot gate.
//   host -> podman exec -i --user podman <box> podman exec -i <roboTeam> node --input-type=module -e <program text>
// The program text carries only non-secret JSON arguments. Credential bytes travel on stdin only, so they can never
// appear in argv, in JavaScript source, or in a syntax-error or stack excerpt. Failure output is a code, never a message.

export const TEST_ROBOT_PREFIX = 'codex-auth-test-';

const PROGRAM_CODES = ['INVALID_ARGUMENT', 'ROBOT_NOT_FOUND', 'WRONG_ROBOT', 'UNSAFE_PATH', 'TARGET_EXISTS', 'PAYLOAD_TOO_LARGE',
  'WRITE_VERIFY_FAILED', 'BUSY', 'NOT_FOUND', 'REMOVE_MISMATCH', 'TRANSCRIPT_MISSING', 'MALFORMED'];

export class RuntimeProgramError extends Error {
  // `code` is a program code, or TIMEOUT, UNAVAILABLE or FAILED for a transport failure. The message is fixed.
  constructor(code) {
    super(`Codex runtime step failed: ${code}`);
    this.name = 'RuntimeProgramError';
    this.code = code;
  }
}

// Shared by every in-runtime program. It is serialized with the program text, so it references no module binding and
// imports its own builtins. `options` is only used by unit tests (fake /data and /proc, an fs spy, an injected stdin).
async function makeHelpers(options = {}) {
  const fs = options.fsApi || (await import('node:fs')).default;
  const { createHash } = await import('node:crypto');
  const dataRoot = options.dataRoot || '/data';
  const procRoot = options.procRoot || '/proc';
  const expectedUid = Number.isInteger(options.expectedUid) ? options.expectedUid : 0;
  const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
  const ROBOT_NAME = /^codex-auth-test-[A-Za-z0-9_-]{1,64}$/;
  const AUTH_LIMIT = 64 * 1024;
  const O = fs.constants;
  const fail = (code) => Object.assign(new Error(code), { code });
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const lstat = (file) => {
    try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw fail('UNSAFE_PATH'); }
  };
  // O_NOFOLLOW plus a stable fstat: a regular, single-link file of bounded size that did not change while it was read.
  const readNoFollow = (file, limit) => {
    let fd;
    try { fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK); } catch (error) {
      throw fail(error.code === 'ENOENT' ? 'NOT_FOUND' : 'UNSAFE_PATH');
    }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw fail('UNSAFE_PATH');
      const data = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (data.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('UNSAFE_PATH');
      return data;
    } finally { fs.closeSync(fd); }
  };
  const readJson = (file, limit = 1024 * 1024) => {
    const data = readNoFollow(file, limit);
    try { return JSON.parse(data.toString('utf8')); } catch { throw fail('MALFORMED'); }
  };
  const readStdin = async (limit) => {
    if (options.input !== undefined) {
      const bytes = Buffer.from(options.input);
      return { bytes: bytes.subarray(0, limit), exceeded: bytes.length > limit };
    }
    const chunks = [];
    let size = 0;
    let exceeded = false;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > limit) { exceeded = true; if (size > 4 * limit) break; } else chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), exceeded };
  };
  const validRobot = ({ robotId, robotName } = {}) => {
    if (typeof robotId !== 'string' || !ROBOT_ID.test(robotId) || typeof robotName !== 'string' || !ROBOT_NAME.test(robotName)) {
      throw fail('INVALID_ARGUMENT');
    }
    return { robotId, robotName };
  };
  // Steps 1 to 3 of the credential checks: identity of the robot, then every directory down to home/.codex.
  const checkRobot = (args) => {
    const { robotId, robotName } = validRobot(args);
    const robots = `${dataRoot}/robots`;
    const root = `${robots}/${robotId}`;
    const home = `${root}/home`;
    const codex = `${home}/.codex`;
    const robotsStat = lstat(robots);
    if (robotsStat === null || robotsStat.isSymbolicLink() || !robotsStat.isDirectory()) throw fail('UNSAFE_PATH');
    const rootStat = lstat(root);
    if (rootStat === null) throw fail('ROBOT_NOT_FOUND');
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw fail('UNSAFE_PATH');
    let metadata;
    try { metadata = readJson(`${root}/metadata.json`, 64 * 1024); } catch (error) {
      throw fail(error.code === 'NOT_FOUND' ? 'ROBOT_NOT_FOUND' : error.code === 'MALFORMED' ? 'WRONG_ROBOT' : error.code);
    }
    if (!metadata || metadata.schema !== 'roboteam-robot-v1' || metadata.id !== robotId || metadata.name !== robotName
      || JSON.stringify(metadata.codingAgents) !== '["codex"]') throw fail('WRONG_ROBOT');
    for (const directory of [home, codex]) {
      const stat = lstat(directory);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH');
    }
    const codexStat = lstat(codex);
    if (codexStat.uid !== expectedUid || (codexStat.mode & 0o077) !== 0) throw fail('UNSAFE_PATH');
    let real;
    try { real = fs.realpathSync(codex); } catch { throw fail('UNSAFE_PATH'); }
    if (real !== codex) throw fail('UNSAFE_PATH');
    return { robotId, robotName, root, home, codex, auth: `${codex}/auth.json`, config: `${codex}/config.toml` };
  };
  const commandLines = () => {
    const processes = [];
    for (const name of fs.readdirSync(procRoot)) {
      if (!/^[0-9]+$/.test(name)) continue;
      let raw;
      try { raw = fs.readFileSync(`${procRoot}/${name}/cmdline`); } catch { continue; }
      const args = raw.toString('utf8').split('\0');
      if (args.at(-1) === '') args.pop();
      processes.push({ pid: Number(name), args });
    }
    return processes;
  };
  const robotCli = (robotName) => commandLines().filter(({ args }) => args.some((arg) => arg.endsWith('robot-cli.mjs'))
    && (args.includes(`--robot=${robotName}`) || args.some((arg, index) => arg === '--robot' && args[index + 1] === robotName)));
  const environmentNames = (pid) => {
    let raw;
    try { raw = fs.readFileSync(`${procRoot}/${pid}/environ`); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail('MALFORMED');
    }
    return raw.toString('utf8').split('\0').filter(Boolean).map((entry) => entry.split('=', 1)[0]);
  };
  return { fs, dataRoot, procRoot, expectedUid, AUTH_LIMIT, fail, sha256, lstat, readNoFollow, readJson, readStdin, validRobot, checkRobot,
    commandLines, robotCli, environmentNames, ROBOT_ID };
}

// Lists every robot, and for test robots only whether a native credential file is present (an lstat, never a read).
export async function readRobotInventory({ prefix } = {}, options = {}) {
  const h = await makeHelpers(options);
  if (prefix !== 'codex-auth-test-') throw h.fail('INVALID_ARGUMENT');
  const robots = `${h.dataRoot}/robots`;
  const stat = h.lstat(robots);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw h.fail('UNSAFE_PATH');
  const result = [];
  for (const entry of h.fs.readdirSync(robots, { withFileTypes: true })) {
    if (!entry.isDirectory() || !h.ROBOT_ID.test(entry.name)) continue;
    let metadata = null;
    try { metadata = h.readJson(`${robots}/${entry.name}/metadata.json`, 64 * 1024); } catch { /* reported with a null name */ }
    const name = typeof metadata?.name === 'string' ? metadata.name : null;
    const codingAgents = Array.isArray(metadata?.codingAgents) ? metadata.codingAgents.filter((agent) => typeof agent === 'string') : null;
    const owned = name !== null && name.startsWith(prefix);
    result.push({ id: entry.name, name, codingAgents, codexAuthPresent: owned ? h.lstat(`${robots}/${entry.name}/home/.codex/auth.json`) !== null : null });
  }
  return { ok: true, robots: result };
}

// The Codex client RoboTeam resolves for robot CLIs, from the tool cache. Two sources, because they exist at different times:
//   - with a robot: the codex-only `shell-codex` selection (named `shell-<agents>` by RoboTeam's tool cache). It exists only after
//     a codex-only robot's CLI has started, so only step 7 of the run reads it;
//   - without a robot (preflight and the binding): `codex/current.json` and its generation, which RoboTeam's startup warm-up
//     writes for the all-agents bundle, so they exist on any deployed RoboTeam.
export async function readCodexClientIdentity({ robotId = null, robotName = null } = {}, options = {}) {
  const h = await makeHelpers(options);
  const withRobot = robotId !== null || robotName !== null;
  const robot = withRobot ? h.checkRobot({ robotId, robotName }) : null;
  const generations = `${h.dataRoot}/tool-cache/codex/generations/`;
  let generation;
  let announced = null;
  if (robot) {
    let real;
    try { real = h.fs.realpathSync(`${h.dataRoot}/tool-cache/shell-selections/shell-codex/bin/codex`); } catch { throw h.fail('NOT_FOUND'); }
    if (!real.startsWith(generations)) throw h.fail('MALFORMED');
    generation = real.slice(generations.length).split('/')[0];
  } else {
    const current = h.readJson(`${h.dataRoot}/tool-cache/codex/current.json`, 64 * 1024);
    if (current?.name !== 'codex' || typeof current.generation !== 'string') throw h.fail('MALFORMED');
    generation = current.generation;
    announced = current.versions?.codex;
  }
  if (!/^[0-9a-f]{64}$/.test(generation)) throw h.fail('MALFORMED');
  const directory = h.lstat(`${generations}${generation}`);
  if (directory === null || directory.isSymbolicLink() || !directory.isDirectory()) throw h.fail('MALFORMED');
  const packageJson = h.readJson(`${generations}${generation}/lib/node_modules/@openai/codex/package.json`, 256 * 1024);
  const version = packageJson?.name === '@openai/codex' ? packageJson.version : null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw h.fail('MALFORMED');
  const stamp = h.readJson(`${generations}${generation}/stamp.json`, 256 * 1024);
  if (stamp?.versions?.codex !== version || (announced !== null && announced !== version)) throw h.fail('MALFORMED');
  let cli = null;
  let codexConfigTomlPresent = null;
  if (robot) {
    const processes = h.robotCli(robot.robotName);
    let openaiBaseUrlSet = false;
    let openaiApiKeySet = false;
    for (const { pid } of processes) {
      const names = h.environmentNames(pid);
      if (names === null) continue;
      openaiBaseUrlSet ||= names.includes('OPENAI_BASE_URL');
      openaiApiKeySet ||= names.includes('OPENAI_API_KEY');
    }
    cli = { count: processes.length, openaiBaseUrlSet, openaiApiKeySet };
    codexConfigTomlPresent = h.lstat(robot.config) !== null;
  }
  return { ok: true, package: '@openai/codex', version, generation, cli, codexConfigTomlPresent };
}

// Credential bytes arrive on stdin. Nothing about them is ever printed.
export async function injectCodexAuth(args, options = {}) {
  const h = await makeHelpers(options);
  const robot = h.checkRobot(args);
  if (h.lstat(robot.config) !== null) throw h.fail('UNSAFE_PATH');
  if (h.lstat(robot.auth) !== null) throw h.fail('TARGET_EXISTS');
  const { bytes, exceeded } = await h.readStdin(h.AUTH_LIMIT);
  if (exceeded) throw h.fail('PAYLOAD_TOO_LARGE');
  if (bytes.length === 0) throw h.fail('INVALID_ARGUMENT');
  const O = h.fs.constants;
  let fd;
  try { fd = h.fs.openSync(robot.auth, O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NOFOLLOW, 0o600); } catch (error) {
    throw h.fail(error.code === 'EEXIST' ? 'TARGET_EXISTS' : 'UNSAFE_PATH');
  }
  const discard = () => { try { h.fs.unlinkSync(robot.auth); } catch { /* nothing to remove */ } };
  try {
    let offset = 0;
    while (offset < bytes.length) offset += h.fs.writeSync(fd, bytes, offset, bytes.length - offset);
    h.fs.fsyncSync(fd);
    h.fs.fchmodSync(fd, 0o600);
  } catch { discard(); throw h.fail('WRITE_VERIFY_FAILED'); } finally { h.fs.closeSync(fd); }
  try {
    const stat = h.fs.lstatSync(robot.auth);
    const written = h.readNoFollow(robot.auth, h.AUTH_LIMIT);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== h.expectedUid || (stat.mode & 0o777) !== 0o600 || written.length !== bytes.length
      || h.sha256(written) !== h.sha256(bytes)) throw h.fail('WRITE_VERIFY_FAILED');
    return { ok: true, size: bytes.length, mode: '600', nlink: 1 };
  } catch { discard(); throw h.fail('WRITE_VERIFY_FAILED'); }
}

// Returns the runtime credential file to the host. BUSY while an ALA process still has the robot home.
export async function readCodexAuthForCopyBack(args, options = {}) {
  const h = await makeHelpers(options);
  const robot = h.checkRobot(args);
  const busy = h.commandLines().some(({ args: argv }) => argv.some((arg, index) => (arg === '--home' && argv[index + 1] === robot.home)
    || arg === `--home=${robot.home}`));
  if (busy) throw h.fail('BUSY');
  const stat = h.lstat(robot.auth);
  if (stat === null) throw h.fail('NOT_FOUND');
  const bytes = h.readNoFollow(robot.auth, h.AUTH_LIMIT);
  return { ok: true, base64: bytes.toString('base64'), size: bytes.length, mode: (stat.mode & 0o777).toString(8) };
}

// Removes the runtime credential only when its bytes are the ones the host persisted. Idempotent.
export async function removeCodexAuth(args, options = {}) {
  const h = await makeHelpers(options);
  const robot = h.checkRobot(args);
  const { bytes } = await h.readStdin(1024);
  let request;
  try { request = JSON.parse(bytes.toString('utf8')); } catch { throw h.fail('INVALID_ARGUMENT'); }
  if (typeof request?.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(request.expectedSha256)) throw h.fail('INVALID_ARGUMENT');
  if (h.lstat(robot.auth) === null) return { ok: true, removed: false };
  if (h.sha256(h.readNoFollow(robot.auth, h.AUTH_LIMIT)) !== request.expectedSha256) throw h.fail('REMOVE_MISMATCH');
  h.fs.unlinkSync(robot.auth);
  return { ok: true, removed: true };
}

// Reads RoboTeam's session file and ALA's own transcript for the run folder. Never a credential file and never the
// retired robot-scoped session path. Only booleans and fixed fields are returned.
export async function readCodexTurnIdentity({ workspaceRoot, folder, robotId, completionToken } = {}, options = {}) {
  const h = await makeHelpers(options);
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/') || workspaceRoot === '/' || workspaceRoot.endsWith('/')
    || workspaceRoot.includes('\0') || /(?:^|\/)\.\.?(?:\/|$)/.test(workspaceRoot)
    || typeof folder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(folder)
    || typeof robotId !== 'string' || !h.ROBOT_ID.test(robotId)
    || typeof completionToken !== 'string' || !/^CODEX_AUTH_OK_[0-9a-f-]{36}$/.test(completionToken)) throw h.fail('INVALID_ARGUMENT');
  const base = `${workspaceRoot}/${folder}`;
  let real;
  try { real = h.fs.realpathSync(base); } catch { throw h.fail('UNSAFE_PATH'); }
  if (real !== base) throw h.fail('UNSAFE_PATH');
  const sessions = `${base}/.roboteam/sessions`;
  const stat = h.lstat(sessions);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw h.fail('UNSAFE_PATH');
  const files = h.fs.readdirSync(sessions).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
  if (files.length !== 1) throw h.fail('MALFORMED');
  const sessionId = files[0].slice(0, -'.json'.length);
  const session = h.readJson(`${sessions}/${files[0]}`);
  if (session?.sessionId !== sessionId || !Array.isArray(session.turns) || session.turns.length < 1) throw h.fail('MALFORMED');
  const text = (value) => (typeof value === 'string' ? value : null);
  const engine = session.engine && typeof session.engine === 'object' ? {
    type: text(session.engine.type), backend: text(session.engine.backend), robotId: text(session.engine.robotId),
    home: text(session.engine.home), cwd: text(session.engine.cwd),
  } : null;
  const transcriptPath = `${base}/.roboteam/.ala/sessions/${sessionId}.jsonl`;
  if (h.lstat(transcriptPath) === null) throw h.fail('TRANSCRIPT_MISSING');
  const raw = h.readNoFollow(transcriptPath, 4 * 1024 * 1024).toString('utf8');
  // Like ALA's own reader: a trailing line without a newline is an interrupted append; any other malformed line is an error.
  const records = raw.split('\n').slice(0, -1).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { throw h.fail('MALFORMED'); }
  });
  const last = (type) => records.filter((record) => record?.type === type).at(-1) || null;
  const continuation = last('continuation');
  const turnEnd = last('turn-end');
  const final = last('final');
  return { ok: true, sessionCount: files.length, sessionId, turnCount: session.turns.length,
    engine, lastTurnStatus: text(session.turns.at(-1)?.status),
    ala: { agent: text(continuation?.agent), hasThreadId: typeof continuation?.continuation?.threadId === 'string' && continuation.continuation.threadId !== '',
      lastTurnStatus: text(turnEnd?.status), finalContainsToken: typeof final?.text === 'string' && final.text.includes(completionToken) } };
}

// Counts robot CLI processes (cmdline holds robot-cli.mjs and --robot=<name>). The caller polls until zero.
export async function waitRobotCliExit({ robotName } = {}, options = {}) {
  const h = await makeHelpers(options);
  if (typeof robotName !== 'string' || !/^codex-auth-test-[A-Za-z0-9_-]{1,64}$/.test(robotName)) throw h.fail('INVALID_ARGUMENT');
  return { ok: true, count: h.robotCli(robotName).length };
}

// The linked ALA source as the RoboTeam container sees it.
export async function readAlaSource(args = {}, options = {}) {
  const h = await makeHelpers(options);
  try { return { ok: true, realpath: h.fs.realpathSync(options.alaPath || '/Agent/linked/AdvancedLanguageAgent') }; } catch { throw h.fail('NOT_FOUND'); }
}

// Wraps a program so that any failure prints `{"ok":false,"code":<fixed code>}` and nothing else. A code outside the fixed
// list (Node errors carry codes such as ENOENT) becomes FAILED. Nothing from an error message is ever printed.
export function credentialProgram(fn, args, options = {}) {
  return [
    `const makeHelpers = ${makeHelpers.toString()};`,
    `const PROGRAM_CODES = ${JSON.stringify(PROGRAM_CODES)};`,
    '(async () => {',
    `  const run = ${fn.toString()};`,
    '  try {',
    `    const result = await run(${JSON.stringify(args)}, ${JSON.stringify(options)});`,
    "    process.stdout.write(JSON.stringify(result) + '\\n');",
    '  } catch (error) {',
    "    const code = PROGRAM_CODES.includes(error?.code) ? error.code : 'FAILED';",
    "    process.stdout.write(JSON.stringify({ ok: false, code }) + '\\n');",
    '    process.exitCode = 1;',
    '  }',
    '})();',
    '',
  ].join('\n');
}

// For phases that move credential bytes: the budget is advisory, never a cancellation. The work is always awaited until it
// settles (every runtime call is individually bounded), so no credential write can outlive the host lock or the result.
export async function credentialPhase(milliseconds, work) {
  const settled = Promise.resolve().then(work).then(() => null, (error) => error ?? new Error('credential phase failed'));
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), milliseconds); });
  const first = await Promise.race([settled, late]);
  clearTimeout(timer);
  const error = first === 'late' ? await settled : first;
  if (error) throw error;
}

// ---- host side ------------------------------------------------------------------------------------------------

// Bounded Podman runner. Output is capped and stderr is never read, since raw Podman, Codex and ALA output can carry
// environment values. Resolves with the exit code and stdout bytes.
export function defaultRunCommand(args, input = '', { timeoutMs = 20_000, limit = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new RuntimeProgramError('UNAVAILABLE')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new RuntimeProgramError('TIMEOUT'));
      if (size > limit) return reject(new RuntimeProgramError('FAILED'));
      resolve({ exitCode: code, stdout: Buffer.concat(chunks) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseResult({ exitCode, stdout }) {
  const line = stdout.toString('utf8').trim().split('\n').at(-1) || '';
  let value;
  try { value = JSON.parse(line); } catch { throw new RuntimeProgramError('FAILED'); }
  if (value?.ok === false) throw new RuntimeProgramError(PROGRAM_CODES.includes(value.code) ? value.code : 'FAILED');
  if (exitCode !== 0 || value?.ok !== true) throw new RuntimeProgramError('FAILED');
  return value;
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function defaultGit(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

// Pure: the RoboTeam source mount `<repo>/roboTeamAgent` of a runtime row, bound at its own path below the workspace root.
export function deriveRoboTeamRepository(runtime, workspaceRoot) {
  const candidates = (runtime.mounts || []).filter((mount) => mount.Source === mount.Destination
    && mount.Destination.startsWith(`${workspaceRoot}/`) && mount.Destination.endsWith('/roboTeamAgent'));
  assert.equal(candidates.length, 1, 'Expected exactly one same-path roboTeamAgent source mount.');
  return path.posix.dirname(candidates[0].Destination);
}

// Pure: whether the recorded binding is the same before and after. The Codex client is reported, not compared.
export function bindingUnchanged(before, after) {
  const { codexClient: _before, ...left } = before;
  const { codexClient: _after, ...right } = after;
  try { assert.deepStrictEqual(left, right); return true; } catch { return false; }
}

export function createCodexRuntime({ box, runCommand = defaultRunCommand, git = defaultGit, sleep = defaultSleep } = {}) {
  assert.ok(typeof box === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(box), 'Set the exact SMOKE_PLOINKY_BOX_CONTAINER name.');
  let roboTeamContainerId = null;
  const inRoboTeam = async (fn, args, { input = '', options = {}, timeoutMs } = {}) => {
    assert.ok(roboTeamContainerId, 'The RoboTeam runtime is not bound.');
    return parseResult(await runCommand(['exec', '-i', '--user', 'podman', box, 'podman', 'exec', '-i', roboTeamContainerId,
      'node', '--input-type=module', '-e', credentialProgram(fn, args, options)], input, { timeoutMs }));
  };
  const api = {
    // Box level, read only.
    async inspectBox() {
      const { exitCode, stdout } = await runCommand(['inspect', box]);
      let value;
      try { [value] = JSON.parse(stdout.toString('utf8')); } catch { throw new RuntimeProgramError('FAILED'); }
      if (exitCode !== 0 || !value?.Id) throw new RuntimeProgramError('FAILED');
      return value;
    },
    async registryRuntime(workspaceRoot) {
      const { exitCode, stdout } = await runCommand(['exec', '-i', '--user', 'podman', box, 'node', '--input-type=module', '-'],
        program(readRegistryAndRuntime, { workspaceRoot }));
      let runtime;
      try { runtime = JSON.parse(stdout.toString('utf8').trim().split('\n').at(-1) || ''); } catch { throw new RuntimeProgramError('FAILED'); }
      if (exitCode !== 0 || !/^[0-9a-f]{64}$/.test(runtime?.containerId || '')) throw new RuntimeProgramError('FAILED');
      roboTeamContainerId = runtime.containerId;
      return runtime;
    },
    bindRoboTeam(containerId) {
      assert.match(containerId, /^[0-9a-f]{64}$/);
      roboTeamContainerId = containerId;
    },
    // RoboTeam level.
    async robotInventory() { return (await inRoboTeam(readRobotInventory, { prefix: TEST_ROBOT_PREFIX })).robots; },
    async clientIdentity(robot = {}) { return inRoboTeam(readCodexClientIdentity, { robotId: robot.robotId ?? null, robotName: robot.robotName ?? null }); },
    async inject(robot, bytes) { return inRoboTeam(injectCodexAuth, robot, { input: bytes }); },
    async readForCopyBack(robot, { timeoutMs = 30_000, intervalMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const result = await inRoboTeam(readCodexAuthForCopyBack, robot);
          return { bytes: Buffer.from(result.base64, 'base64'), size: result.size, mode: result.mode };
        } catch (error) {
          if (error.code !== 'BUSY' || Date.now() >= deadline) throw error;
          await sleep(intervalMs);
        }
      }
    },
    async remove(robot, expectedSha256) { return inRoboTeam(removeCodexAuth, robot, { input: JSON.stringify({ expectedSha256 }) }); },
    async turnIdentity(args) { return inRoboTeam(readCodexTurnIdentity, args); },
    async cliCount(robotName) { return (await inRoboTeam(waitRobotCliExit, { robotName })).count; },
    async waitCliExit(robotName, { timeoutMs = 180_000, intervalMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await api.cliCount(robotName) === 0) return;
        if (Date.now() >= deadline) throw new RuntimeProgramError('TIMEOUT');
        await sleep(intervalMs);
      }
    },
    async alaRealpath() { return (await inRoboTeam(readAlaSource, {})).realpath; },
    // The binding recorded before and after the run, from read-only sources only.
    async readBinding({ workspaceRoot, smokeRepository, includeClient = true }) {
      const outer = await api.inspectBox();
      assert.equal(outer.State?.Running, true);
      const runtime = await api.registryRuntime(workspaceRoot);
      const repository = deriveRoboTeamRepository(runtime, workspaceRoot);
      validateLiveSkillsRuntimeBinding(runtime, repository, { workspaceRoot });
      const commit = (target) => git(target, ['rev-parse', 'HEAD']).trim();
      const dirty = (target) => git(target, ['status', '--porcelain=v1']).split('\n').filter(Boolean).length;
      const ploinky = (outer.Mounts || []).filter((mount) => mount.Destination === '/opt/ploinky');
      assert.equal(ploinky.length, 1, 'Expected exactly one /opt/ploinky mount.');
      const ala = await api.alaRealpath();
      let alaCommit = null;
      if (ala.startsWith(`${workspaceRoot}/`)) { try { alaCommit = commit(ala); } catch { alaCommit = null; } }
      return {
        smoke: { repository: smokeRepository, commit: commit(smokeRepository), dirtyCount: dirty(smokeRepository) },
        roboTeamSource: { repository, commit: commit(repository), dirtyCount: dirty(repository) },
        ploinkySource: { path: ploinky[0].Source, commit: commit(ploinky[0].Source) },
        alaSource: { realpath: ala, commit: alaCommit },
        box: { name: box, id: outer.Id, startedAt: outer.State.StartedAt, imageId: outer.Image },
        roboTeamRuntime: { containerId: runtime.containerId, instanceId: runtime.instanceId, enableGeneration: runtime.enableGeneration,
          startedAt: runtime.startedAt, imageId: runtime.imageId },
        ...(includeClient ? { codexClient: await api.clientIdentity().then(({ package: name, version, generation }) => ({ package: name, version, generation12: generation.slice(0, 12) })) } : {}),
      };
    },
  };
  return api;
}
