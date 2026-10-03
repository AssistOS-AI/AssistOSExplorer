import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  RuntimeProgramError, bindingUnchanged, createCodexRuntime, credentialPhase, credentialProgram, deriveRoboTeamRepository, injectCodexAuth,
  readAlaSource, readCodexAuthForCopyBack, readCodexClientIdentity, readCodexTurnIdentity, readRobotInventory, removeCodexAuth,
  waitRobotCliExit,
} from './codex-test-auth-runtime.mjs';
import { program, readRegistryAndRuntime, validateLiveSkillsRuntimeBinding } from './copilot-live-skills-runtime.mjs';

// Synthetic payloads only. Every program runs against a temporary fake /data and /proc.
const uid = process.getuid();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SECRET = 'rt-fake-RUNTIME-SECRET-0123456789abcdef';
const authBytes = (extra = '') => Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: SECRET, account_id: 'acct-fake-runtime' }, extra }));
const ROBOT = { robotId: 'codex-auth-test-r1-ab12', robotName: 'codex-auth-test-r1' };

function world(t, { robot = ROBOT, codingAgents = ['codex'], name = robot.robotName, schema = 'roboteam-robot-v1' } = {}) {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cta-rt-')));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const proc = path.join(data, 'proc');
  fs.mkdirSync(proc);
  const mk = (id, robotName, agents = ['codex']) => {
    const root = path.join(data, 'robots', id);
    fs.mkdirSync(path.join(root, 'home', '.codex'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, 'home', '.codex'), 0o700);
    fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ schema, id, name: robotName, codingAgents: agents }));
    return { root, home: path.join(root, 'home'), codex: path.join(root, 'home', '.codex'), auth: path.join(root, 'home', '.codex', 'auth.json') };
  };
  const paths = mk(robot.robotId, name, codingAgents);
  const options = { dataRoot: data, procRoot: proc, expectedUid: uid };
  const addProcess = (pid, args, environ = null) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), `${args.join('\0')}\0`);
    if (environ) fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${environ.join('\0')}\0`);
  };
  return { data, proc, options, robot, mk, addProcess, ...paths };
}

// Runs the serialized program text exactly as the Box exec chain does: node --input-type=module -e <text>, stdin for bytes.
function runSerialized(fn, args, options, input = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', credentialProgram(fn, args, options)], { input, encoding: 'utf8', timeout: 20_000 });
  return { ...result, json: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}

const code = (expected) => (error) => error?.code === expected && error.message === expected;
const rejectsWith = (promise, expected) => assert.rejects(promise, code(expected));

test('injectCodexAuth writes a 0600 file with O_EXCL into a codex-only test robot', async (t) => {
  const w = world(t);
  const bytes = authBytes();
  const opened = [];
  const spy = { ...fs, openSync(file, flags, mode) { opened.push({ file, flags, mode }); return fs.openSync(file, flags, mode); } };
  const direct = await injectCodexAuth(w.robot, { ...w.options, input: bytes, fsApi: spy });
  assert.deepEqual(direct, { ok: true, size: bytes.length, mode: '600', nlink: 1 });
  const create = opened.find((entry) => entry.file === w.auth && entry.flags & fs.constants.O_CREAT);
  assert.ok(create.flags & fs.constants.O_EXCL && create.flags & fs.constants.O_NOFOLLOW && create.flags & fs.constants.O_WRONLY);
  assert.equal(create.mode, 0o600);
  const stat = fs.lstatSync(w.auth);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.deepEqual(fs.readFileSync(w.auth), bytes);
  // The same program from its serialized text, with the bytes on stdin only.
  fs.rmSync(w.auth);
  const text = credentialProgram(injectCodexAuth, w.robot, w.options);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(bytes.toString('base64')), false);
  const serialized = runSerialized(injectCodexAuth, w.robot, w.options, bytes);
  assert.equal(serialized.status, 0);
  assert.deepEqual(serialized.json, { ok: true, size: bytes.length, mode: '600', nlink: 1 });
  assert.equal(serialized.stdout.includes(SECRET) || serialized.stderr.includes(SECRET), false);
  assert.deepEqual(fs.readFileSync(w.auth), bytes);
  assert.equal(fs.lstatSync(w.auth).mode & 0o777, 0o600);
  // A second injection never overwrites.
  await rejectsWith(injectCodexAuth(w.robot, { ...w.options, input: authBytes('other') }), 'TARGET_EXISTS');
  assert.deepEqual(fs.readFileSync(w.auth), bytes);
  // Exactly 64 KiB is accepted.
  fs.rmSync(w.auth);
  const exact = Buffer.alloc(64 * 1024, 0x20);
  assert.equal((await injectCodexAuth(w.robot, { ...w.options, input: exact })).size, 64 * 1024);
});

test('injectCodexAuth refuses wrong robots, unsafe directories, an existing or dangling auth.json, a config.toml and payloads over 64 KiB', async (t) => {
  const w = world(t);
  const input = authBytes();
  // Boundary robot ids: 2 and 65 characters, traversal, uppercase and bad names are argument errors; 3 and 64 are valid ids.
  for (const robotId of ['ab', 'a'.repeat(65), '../codex-auth-test-r1-ab12', 'Default', 'codex auth', '', 'a/b', null]) {
    await rejectsWith(injectCodexAuth({ robotId, robotName: ROBOT.robotName }, { ...w.options, input }), 'INVALID_ARGUMENT');
  }
  for (const robotName of ['default', 'codex-auth-test-', 'codex-auth-test-a b', `codex-auth-test-${'x'.repeat(65)}`, 'Codex-auth-test-r1', 7]) {
    await rejectsWith(injectCodexAuth({ robotId: ROBOT.robotId, robotName }, { ...w.options, input }), 'INVALID_ARGUMENT');
  }
  for (const id of ['abc', 'a'.repeat(64)]) {
    const name = `codex-auth-test-${id.slice(0, 5)}`;
    w.mk(id, name);
    assert.equal((await injectCodexAuth({ robotId: id, robotName: name }, { ...w.options, input })).ok, true, id);
  }
  // Unknown, mismatched and non-codex robots.
  await rejectsWith(injectCodexAuth({ robotId: 'codex-auth-test-zz-0000', robotName: 'codex-auth-test-zz' }, { ...w.options, input }), 'ROBOT_NOT_FOUND');
  await rejectsWith(injectCodexAuth({ robotId: ROBOT.robotId, robotName: 'codex-auth-test-other' }, { ...w.options, input }), 'WRONG_ROBOT');
  for (const [agents, schema] of [[['opencode'], undefined], [['codex', 'opencode'], undefined], [[], undefined], [['codex'], 'roboteam-robot-v2']]) {
    const other = world(t, { codingAgents: agents, ...(schema ? { schema } : {}) });
    await rejectsWith(injectCodexAuth(other.robot, { ...other.options, input }), 'WRONG_ROBOT');
    assert.equal(fs.existsSync(other.auth), false);
  }
  const renamed = world(t, { name: 'codex-auth-test-different' });
  await rejectsWith(injectCodexAuth(renamed.robot, { ...renamed.options, input }), 'WRONG_ROBOT');
  fs.writeFileSync(path.join(renamed.root, 'metadata.json'), 'not json');
  await rejectsWith(injectCodexAuth(renamed.robot, { ...renamed.options, input }), 'WRONG_ROBOT');
  // Unsafe directories.
  const mode = world(t);
  fs.chmodSync(mode.codex, 0o750);
  await rejectsWith(injectCodexAuth(mode.robot, { ...mode.options, input }), 'UNSAFE_PATH');
  const owner = world(t);
  await rejectsWith(injectCodexAuth(owner.robot, { ...owner.options, expectedUid: uid + 1, input }), 'UNSAFE_PATH');
  const linkedHome = world(t);
  fs.renameSync(linkedHome.home, `${linkedHome.home}-real`);
  fs.symlinkSync(`${linkedHome.home}-real`, linkedHome.home);
  await rejectsWith(injectCodexAuth(linkedHome.robot, { ...linkedHome.options, input }), 'UNSAFE_PATH');
  assert.equal(fs.existsSync(path.join(`${linkedHome.home}-real`, '.codex', 'auth.json')), false);
  const linkedCodex = world(t);
  fs.renameSync(linkedCodex.codex, `${linkedCodex.codex}-real`);
  fs.symlinkSync(`${linkedCodex.codex}-real`, linkedCodex.codex);
  await rejectsWith(injectCodexAuth(linkedCodex.robot, { ...linkedCodex.options, input }), 'UNSAFE_PATH');
  const linkedRoot = world(t);
  fs.renameSync(linkedRoot.root, `${linkedRoot.root}-real`);
  fs.symlinkSync(`${linkedRoot.root}-real`, linkedRoot.root);
  await rejectsWith(injectCodexAuth(linkedRoot.robot, { ...linkedRoot.options, input }), 'UNSAFE_PATH');
  const noCodex = world(t);
  fs.rmdirSync(noCodex.codex);
  await rejectsWith(injectCodexAuth(noCodex.robot, { ...noCodex.options, input }), 'UNSAFE_PATH');
  // Existing, dangling and symlinked credential files, and a config.toml.
  const existing = world(t);
  fs.writeFileSync(existing.auth, 'prior', { mode: 0o600 });
  await rejectsWith(injectCodexAuth(existing.robot, { ...existing.options, input }), 'TARGET_EXISTS');
  assert.equal(fs.readFileSync(existing.auth, 'utf8'), 'prior');
  const dangling = world(t);
  fs.symlinkSync(path.join(dangling.data, 'nowhere.json'), dangling.auth);
  await rejectsWith(injectCodexAuth(dangling.robot, { ...dangling.options, input }), 'TARGET_EXISTS');
  assert.equal(fs.existsSync(path.join(dangling.data, 'nowhere.json')), false, 'a dangling symlink target is never created');
  const config = world(t);
  fs.writeFileSync(path.join(config.codex, 'config.toml'), 'model_provider = "x"\n');
  await rejectsWith(injectCodexAuth(config.robot, { ...config.options, input }), 'UNSAFE_PATH');
  assert.equal(fs.existsSync(config.auth), false);
  // Payload limits: 65,537 bytes and an empty payload leave nothing behind, in-process and from the serialized text.
  const big = world(t);
  await rejectsWith(injectCodexAuth(big.robot, { ...big.options, input: Buffer.alloc(64 * 1024 + 1, 0x20) }), 'PAYLOAD_TOO_LARGE');
  await rejectsWith(injectCodexAuth(big.robot, { ...big.options, input: Buffer.alloc(0) }), 'INVALID_ARGUMENT');
  assert.equal(fs.existsSync(big.auth), false);
  const serialized = runSerialized(injectCodexAuth, big.robot, big.options, Buffer.alloc(64 * 1024 + 1, 0x41));
  assert.deepEqual(serialized.json, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(serialized.status, 1);
  assert.equal(fs.existsSync(big.auth), false);
  assert.deepEqual(runSerialized(injectCodexAuth, big.robot, big.options, '').json, { ok: false, code: 'INVALID_ARGUMENT' });
  assert.equal(fs.existsSync(big.auth), false);
});

test('readCodexAuthForCopyBack refuses symlinks and hard links and reports BUSY while an ALA process uses the robot home', async (t) => {
  const w = world(t);
  const bytes = authBytes('refreshed');
  await rejectsWith(readCodexAuthForCopyBack(w.robot, w.options), 'NOT_FOUND');
  fs.writeFileSync(w.auth, bytes, { mode: 0o600 });
  const ok = await readCodexAuthForCopyBack(w.robot, w.options);
  assert.deepEqual(ok, { ok: true, base64: bytes.toString('base64'), size: bytes.length, mode: '600' });
  const serialized = runSerialized(readCodexAuthForCopyBack, w.robot, w.options);
  assert.equal(serialized.status, 0);
  assert.deepEqual(serialized.json, ok);
  // BUSY: `--home <robot home>` and `--home=<robot home>`, but only for this robot's home.
  w.addProcess(901, ['node', '/ala/bin/ala.mjs', '--ca', 'codex', '--home', w.home, '--cwd', '/workspace/x']);
  await rejectsWith(readCodexAuthForCopyBack(w.robot, w.options), 'BUSY');
  assert.deepEqual(runSerialized(readCodexAuthForCopyBack, w.robot, w.options).json, { ok: false, code: 'BUSY' });
  fs.rmSync(path.join(w.proc, '901'), { recursive: true });
  w.addProcess(902, ['node', 'ala.mjs', `--home=${w.home}`]);
  await rejectsWith(readCodexAuthForCopyBack(w.robot, w.options), 'BUSY');
  fs.rmSync(path.join(w.proc, '902'), { recursive: true });
  const other = w.mk('codex-auth-test-r2-cd34', 'codex-auth-test-r2');
  w.addProcess(903, ['node', 'ala.mjs', '--home', other.home]);
  w.addProcess(904, ['node', 'ala.mjs', '--cwd', w.home]);
  w.addProcess(905, ['node', '--input-type=module', '-e', `--home ${w.home}`]);
  assert.equal((await readCodexAuthForCopyBack(w.robot, w.options)).ok, true);
  // Symlink and hard link are refused.
  const linked = world(t);
  const target = path.join(linked.data, 'elsewhere.json');
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.symlinkSync(target, linked.auth);
  await rejectsWith(readCodexAuthForCopyBack(linked.robot, linked.options), 'UNSAFE_PATH');
  fs.rmSync(linked.auth);
  fs.linkSync(target, linked.auth);
  await rejectsWith(readCodexAuthForCopyBack(linked.robot, linked.options), 'UNSAFE_PATH');
  fs.rmSync(linked.auth);
  fs.writeFileSync(linked.auth, Buffer.alloc(64 * 1024 + 1, 0x20), { mode: 0o600 });
  await rejectsWith(readCodexAuthForCopyBack(linked.robot, linked.options), 'UNSAFE_PATH');
  // Wrong robot or unsafe directory.
  await rejectsWith(readCodexAuthForCopyBack({ ...ROBOT, robotName: 'codex-auth-test-other' }, w.options), 'WRONG_ROBOT');
  await rejectsWith(readCodexAuthForCopyBack({ robotId: '../x', robotName: ROBOT.robotName }, w.options), 'INVALID_ARGUMENT');
});

test('removeCodexAuth removes only the expected bytes and is idempotent', async (t) => {
  const w = world(t);
  const bytes = authBytes('to-remove');
  const request = (hash) => JSON.stringify({ expectedSha256: hash });
  assert.deepEqual(await removeCodexAuth(w.robot, { ...w.options, input: request(sha(bytes)) }), { ok: true, removed: false });
  fs.writeFileSync(w.auth, bytes, { mode: 0o600 });
  await rejectsWith(removeCodexAuth(w.robot, { ...w.options, input: request(sha(authBytes('different'))) }), 'REMOVE_MISMATCH');
  assert.deepEqual(fs.readFileSync(w.auth), bytes, 'a mismatched hash removes nothing');
  for (const bad of ['', 'not json', request('abc'), request(sha(bytes).toUpperCase()), JSON.stringify({}), JSON.stringify({ expectedSha256: 7 }), '[]']) {
    await rejectsWith(removeCodexAuth(w.robot, { ...w.options, input: bad }), 'INVALID_ARGUMENT');
  }
  assert.equal(fs.existsSync(w.auth), true);
  const serialized = runSerialized(removeCodexAuth, w.robot, w.options, request(sha(bytes)));
  assert.deepEqual(serialized.json, { ok: true, removed: true });
  assert.equal(fs.existsSync(w.auth), false);
  assert.deepEqual(runSerialized(removeCodexAuth, w.robot, w.options, request(sha(bytes))).json, { ok: true, removed: false });
  assert.deepEqual(await removeCodexAuth(w.robot, { ...w.options, input: request(sha(bytes)) }), { ok: true, removed: false });
  // A symlink or a hard link is never followed or removed on the strength of its target's hash.
  const target = path.join(w.data, 'elsewhere.json');
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.symlinkSync(target, w.auth);
  await rejectsWith(removeCodexAuth(w.robot, { ...w.options, input: request(sha(bytes)) }), 'UNSAFE_PATH');
  assert.equal(fs.lstatSync(w.auth).isSymbolicLink(), true);
  fs.rmSync(w.auth);
  fs.linkSync(target, w.auth);
  await rejectsWith(removeCodexAuth(w.robot, { ...w.options, input: request(sha(bytes)) }), 'UNSAFE_PATH');
  assert.equal(fs.existsSync(w.auth), true);
  await rejectsWith(removeCodexAuth({ ...ROBOT, robotName: 'codex-auth-test-other' }, { ...w.options, input: request(sha(bytes)) }), 'WRONG_ROBOT');
});

function turnFixture(t, { workspaceName = 'work space é' } = {}) {
  const w = world(t);
  const workspaceRoot = path.join(w.data, workspaceName);
  const folder = 'codex-auth-run-1';
  const base = path.join(workspaceRoot, folder);
  const sessionId = randomUUID();
  const token = `CODEX_AUTH_OK_${randomUUID()}`;
  const sessions = path.join(base, '.roboteam', 'sessions');
  const alaSessions = path.join(base, '.roboteam', '.ala', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(alaSessions, { recursive: true });
  const record = (value) => `${JSON.stringify(value)}\n`;
  const session = { sessionId, turns: [{ turnId: 't1', status: 'completed' }],
    engine: { type: 'ala', version: 1, sessionId, home: w.home, cwd: base, backend: 'codex', robotId: w.robot.robotId } };
  const transcript = [
    { type: 'session', id: sessionId, at: 'x' },
    { type: 'continuation', agent: 'codex', continuation: { threadId: 'thread-fake-1' } },
    { type: 'user', turnId: 't1', seq: 1, text: `Reply with exactly this token: ${token}` },
    { type: 'final', turnId: 't1', seq: 2, text: token },
    { type: 'turn-end', turnId: 't1', seq: 3, status: 'completed' },
  ].map(record).join('');
  fs.writeFileSync(path.join(sessions, `${sessionId}.json`), JSON.stringify(session));
  fs.writeFileSync(path.join(alaSessions, `${sessionId}.jsonl`), transcript);
  const args = { workspaceRoot, folder, robotId: w.robot.robotId, completionToken: token };
  return { ...w, workspaceRoot, folder, base, sessionId, token, sessions, alaSessions, session, transcript, args, record,
    transcriptFile: path.join(alaSessions, `${sessionId}.jsonl`), sessionFile: path.join(sessions, `${sessionId}.json`) };
}

test('readCodexTurnIdentity reads the .roboteam session and the mandatory ALA transcript, fails on a missing transcript, and never opens .codex or copilot/sessions', async (t) => {
  const f = turnFixture(t);
  // Decoys the reader must never touch: the native credential and the retired robot-scoped session path.
  fs.writeFileSync(f.auth, authBytes(), { mode: 0o600 });
  fs.mkdirSync(path.join(f.root, 'copilot', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'copilot', 'sessions', `${f.sessionId}.json`), '{}');
  const touched = [];
  const spy = { ...fs };
  for (const name of ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'existsSync', 'readlinkSync']) {
    spy[name] = (file, ...rest) => { if (typeof file === 'string') touched.push([name, file]); return fs[name](file, ...rest); };
  }
  const expected = { ok: true, sessionCount: 1, sessionId: f.sessionId, turnCount: 1,
    engine: { type: 'ala', backend: 'codex', robotId: f.robot.robotId, home: f.home, cwd: f.base }, lastTurnStatus: 'completed',
    ala: { agent: 'codex', hasThreadId: true, lastTurnStatus: 'completed', finalContainsToken: true } };
  assert.deepEqual(await readCodexTurnIdentity(f.args, { ...f.options, fsApi: spy }), expected);
  const opened = touched.filter(([name]) => name === 'openSync').map(([, file]) => file).sort();
  assert.deepEqual(opened, [f.transcriptFile, f.sessionFile].sort());
  for (const [, file] of touched) {
    assert.equal(file.includes('/.codex/') || file.endsWith('/.codex') || file.includes('/copilot/sessions'), false, file);
  }
  // From the serialized text, with a workspace root that contains a space and a non-ASCII letter.
  const serialized = runSerialized(readCodexTurnIdentity, f.args, f.options);
  assert.equal(serialized.status, 0);
  assert.deepEqual(serialized.json, expected);
  assert.equal(serialized.stdout.includes(f.token), false, 'the completion token is reported as a boolean only');
  // A trailing line without a newline is an interrupted append and is ignored.
  fs.appendFileSync(f.transcriptFile, '{"type":"turn-end","status":"fail');
  assert.equal((await readCodexTurnIdentity(f.args, f.options)).ala.lastTurnStatus, 'completed');
  // The facts the host judges: another agent, a failed turn, a final without the token, no thread id.
  const rewrite = (records) => fs.writeFileSync(f.transcriptFile, records.map(f.record).join(''));
  const base = [{ type: 'session', id: f.sessionId }, { type: 'continuation', agent: 'codex', continuation: { threadId: 'x' } },
    { type: 'final', turnId: 't1', text: f.token }, { type: 'turn-end', turnId: 't1', status: 'completed' }];
  rewrite([base[0], { type: 'continuation', agent: 'opencode', continuation: { threadId: 'x' } }, base[2], base[3]]);
  assert.equal((await readCodexTurnIdentity(f.args, f.options)).ala.agent, 'opencode');
  rewrite([base[0], base[1], base[2], { type: 'turn-end', turnId: 't1', status: 'failed' }]);
  assert.equal((await readCodexTurnIdentity(f.args, f.options)).ala.lastTurnStatus, 'failed');
  rewrite([base[0], base[1], { type: 'final', turnId: 't1', text: 'something else' }, base[3]]);
  assert.equal((await readCodexTurnIdentity(f.args, f.options)).ala.finalContainsToken, false);
  rewrite([base[0], { type: 'continuation', agent: 'codex', continuation: { threadId: '' } }, base[2], base[3]]);
  assert.equal((await readCodexTurnIdentity(f.args, f.options)).ala.hasThreadId, false);
  rewrite([base[0]]);
  assert.deepEqual((await readCodexTurnIdentity(f.args, f.options)).ala, { agent: null, hasThreadId: false, lastTurnStatus: null, finalContainsToken: false });
  fs.writeFileSync(f.transcriptFile, 'not json\n{}\n');
  await rejectsWith(readCodexTurnIdentity(f.args, f.options), 'MALFORMED');
  // A missing transcript is its own code (the host maps it to exit 23), also from the serialized text.
  fs.rmSync(f.transcriptFile);
  await rejectsWith(readCodexTurnIdentity(f.args, f.options), 'TRANSCRIPT_MISSING');
  assert.deepEqual(runSerialized(readCodexTurnIdentity, f.args, f.options).json, { ok: false, code: 'TRANSCRIPT_MISSING' });
  fs.symlinkSync(f.sessionFile, f.transcriptFile);
  await rejectsWith(readCodexTurnIdentity(f.args, f.options), 'UNSAFE_PATH');
  // Session file problems: none, two, no turns, wrong id.
  rewrite(base);
  fs.rmSync(f.transcriptFile);
  rewrite(base);
  fs.writeFileSync(path.join(f.sessions, `${randomUUID()}.json`), '{}');
  await rejectsWith(readCodexTurnIdentity(f.args, f.options), 'MALFORMED');
  const none = turnFixture(t);
  fs.writeFileSync(none.sessionFile, JSON.stringify({ ...none.session, turns: [] }));
  await rejectsWith(readCodexTurnIdentity(none.args, none.options), 'MALFORMED');
  fs.writeFileSync(none.sessionFile, JSON.stringify({ ...none.session, sessionId: randomUUID() }));
  await rejectsWith(readCodexTurnIdentity(none.args, none.options), 'MALFORMED');
  fs.rmSync(none.sessionFile);
  await rejectsWith(readCodexTurnIdentity(none.args, none.options), 'MALFORMED');
  // Arguments and containment.
  for (const bad of [{ folder: '../x' }, { folder: 'a/b' }, { folder: '' }, { workspaceRoot: 'relative' }, { workspaceRoot: '/' }, { workspaceRoot: `${f.workspaceRoot}/` },
    { workspaceRoot: `${f.workspaceRoot}/../x` }, { robotId: 'Bad' }, { completionToken: 'CODEX_AUTH_OK_x' }, { completionToken: f.token.replace('CODEX', 'OTHER') }]) {
    await rejectsWith(readCodexTurnIdentity({ ...f.args, ...bad }, f.options), 'INVALID_ARGUMENT');
  }
  const linkedFolder = path.join(f.workspaceRoot, 'linked');
  fs.symlinkSync(f.base, linkedFolder);
  await rejectsWith(readCodexTurnIdentity({ ...f.args, folder: 'linked' }, f.options), 'UNSAFE_PATH');
  await rejectsWith(readCodexTurnIdentity({ ...f.args, folder: 'missing-folder' }, f.options), 'UNSAFE_PATH');
});

function toolCacheFixture(w, { version = '0.160.0', stampVersion = version, generation = '4766a1b2276fdbe3606f84ab59db278ea529e06863af68f39a52361391efbec0',
  link = true } = {}) {
  const generations = path.join(w.data, 'tool-cache', 'codex', 'generations', generation);
  const packageDir = path.join(generations, 'lib', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  fs.writeFileSync(path.join(packageDir, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(generations, 'stamp.json'), JSON.stringify({ schema: 1, name: 'codex', generation, versions: { codex: stampVersion } }));
  if (!link) return generation;
  const shell = path.join(w.data, 'tool-cache', 'shell-generations', 'f'.repeat(64));
  fs.mkdirSync(path.join(shell, 'bin'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(shell, 'bin'), path.join(packageDir, 'bin', 'codex.js')), path.join(shell, 'bin', 'codex'));
  fs.mkdirSync(path.join(w.data, 'tool-cache', 'shell-selections'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(w.data, 'tool-cache', 'shell-selections'), shell), path.join(w.data, 'tool-cache', 'shell-selections', 'shell-codex'));
  return generation;
}

test('readCodexClientIdentity resolves the shell-codex selection to its generation and package version and reports provider names only', async (t) => {
  const w = world(t);
  const generation = toolCacheFixture(w);
  w.addProcess(311, ['node', '/code/server/robot-cli.mjs', `--robot=${w.robot.robotName}`, '--workspace-dir=x'],
    ['PATH=/usr/bin', 'OPENAI_BASE_URL=http://fake.invalid/SECRET-URL', 'HOME=/root']);
  w.addProcess(312, ['node', '/code/server/robot-cli.mjs', '--robot', w.robot.robotName],
    ['OPENAI_API_KEY=sk-fake-SECRET-KEY', 'X=1']);
  w.addProcess(313, ['node', '/code/server/robot-cli.mjs', '--robot=codex-auth-test-other'], ['OPENAI_API_KEY=sk-fake-OTHER']);
  w.addProcess(314, ['node', '/code/server/other.mjs', `--robot=${w.robot.robotName}`], ['OPENAI_API_KEY=sk-fake-NOT-A-CLI']);
  const result = await readCodexClientIdentity(w.robot, w.options);
  assert.deepEqual(result, { ok: true, package: '@openai/codex', version: '0.160.0', generation,
    cli: { count: 2, openaiBaseUrlSet: true, openaiApiKeySet: true }, codexConfigTomlPresent: false });
  const serialized = runSerialized(readCodexClientIdentity, w.robot, w.options);
  assert.deepEqual(serialized.json, result);
  assert.equal(/SECRET|sk-fake|fake\.invalid/.test(serialized.stdout), false, 'only names are reported, never values');
  // Clean environments and a config.toml.
  const clean = world(t);
  toolCacheFixture(clean);
  clean.addProcess(321, ['node', 'robot-cli.mjs', `--robot=${clean.robot.robotName}`], ['PATH=/usr/bin']);
  fs.writeFileSync(path.join(clean.codex, 'config.toml'), 'x = 1\n');
  assert.deepEqual(await readCodexClientIdentity(clean.robot, clean.options), { ok: true, package: '@openai/codex', version: '0.160.0', generation,
    cli: { count: 1, openaiBaseUrlSet: false, openaiApiKeySet: false }, codexConfigTomlPresent: true });
  // Without a robot only the client is read.
  assert.deepEqual(await readCodexClientIdentity({}, clean.options), { ok: true, package: '@openai/codex', version: '0.160.0', generation, cli: null, codexConfigTomlPresent: null });
  await rejectsWith(readCodexClientIdentity({ robotId: clean.robot.robotId, robotName: null }, clean.options), 'INVALID_ARGUMENT');
  // A stamp that disagrees, an unlinked tool cache, a selection outside the generations and an unreadable CLI environment.
  const mismatch = world(t);
  toolCacheFixture(mismatch, { stampVersion: '0.159.0' });
  await rejectsWith(readCodexClientIdentity(mismatch.robot, mismatch.options), 'MALFORMED');
  const missing = world(t);
  await rejectsWith(readCodexClientIdentity(missing.robot, missing.options), 'NOT_FOUND');
  const outside = world(t);
  fs.mkdirSync(path.join(outside.data, 'tool-cache', 'shell-selections', 'shell-codex', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(outside.data, 'tool-cache', 'shell-selections', 'shell-codex', 'bin', 'codex'), '');
  await rejectsWith(readCodexClientIdentity(outside.robot, outside.options), 'MALFORMED');
  const badVersion = world(t);
  toolCacheFixture(badVersion, { version: '0.160.0 && rm -rf /', stampVersion: '0.160.0 && rm -rf /' });
  await rejectsWith(readCodexClientIdentity(badVersion.robot, badVersion.options), 'MALFORMED');
  const unreadable = world(t);
  toolCacheFixture(unreadable);
  unreadable.addProcess(331, ['node', 'robot-cli.mjs', `--robot=${unreadable.robot.robotName}`]);
  fs.mkdirSync(path.join(unreadable.proc, '331', 'environ'));
  await rejectsWith(readCodexClientIdentity(unreadable.robot, unreadable.options), 'MALFORMED');
});

test('credentialProgram failure output contains only a code, never a message or payload bytes', () => {
  const marker = 'PAYLOAD-MARKER-do-not-print-0123456789';
  const stdin = `{"leaked":"${marker}"}`;
  // The functions are serialized, so they carry no closure: the marker arrives as an argument.
  async function failsWithMessage(args, options) { throw new Error(`message with ${args.marker} and ${JSON.stringify(args)} ${JSON.stringify(options)}`); }
  async function failsWithNodeCode(args) { throw Object.assign(new Error(`ENOENT: no such file ${args.marker}`), { code: 'ENOENT', path: `/x/${args.marker}` }); }
  async function failsWithKnownCode(args) { throw Object.assign(new Error(`BUSY ${args.marker}`), { code: 'BUSY' }); }
  async function failsWithUnknownCode(args) { throw Object.assign(new Error(args.marker), { code: `CUSTOM_${args.marker}` }); }
  async function failsWithString(args) { throw args.marker; }
  async function failsWithNothing() { throw undefined; }
  async function failsAfterReading() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    throw new Error(Buffer.concat(chunks).toString('utf8'));
  }
  const cases = [[failsWithMessage, 'FAILED'], [failsWithNodeCode, 'FAILED'], [failsWithKnownCode, 'BUSY'], [failsWithUnknownCode, 'FAILED'],
    [failsWithString, 'FAILED'], [failsWithNothing, 'FAILED'], [failsAfterReading, 'FAILED']];
  for (const [fn, expected] of cases) {
    const run = runSerialized(fn, { marker, note: 'argument-ok' }, { note: 'option-ok' }, stdin);
    assert.equal(run.stdout, `${JSON.stringify({ ok: false, code: expected })}\n`, fn.name);
    assert.equal(run.stderr, '', fn.name);
    assert.equal(run.status, 1, fn.name);
    assert.equal(run.stdout.includes(marker) || run.stderr.includes(marker), false, fn.name);
  }
  // Positive control: the same functions do run (they would fail with a ReferenceError, also coded FAILED, if they were not serializable).
  assert.match(credentialProgram(failsWithKnownCode, { marker }, {}), /args\.marker/);
  const thrown = spawnSync(process.execPath, ['--input-type=module', '-e', `const f = ${failsWithMessage.toString()}; try { await f({ marker: 'M' }, {}); } catch (error) { console.log(error.message.slice(0, 20)); }`], { encoding: 'utf8' });
  assert.equal(thrown.stdout.trim(), 'message with M and {');
  // A success is exactly the program's result on one line.
  const ok = runSerialized(async function succeeds(args) { return { ok: true, echoed: args.value }; }, { value: 3 }, {}, stdin);
  assert.deepEqual([ok.stdout, ok.status], ['{"ok":true,"echoed":3}\n', 0]);
});

test('every program runs from its serialized text against the fake runtime', async (t) => {
  const w = world(t);
  const generation = toolCacheFixture(w);
  const alaTarget = path.join(w.data, 'Agent', 'linked', 'AdvancedLanguageAgent');
  fs.mkdirSync(alaTarget, { recursive: true });
  const bytes = authBytes('all-programs');
  const run = (fn, args, input = '', options = w.options) => runSerialized(fn, args, options, input);
  assert.deepEqual(run(readRobotInventory, { prefix: 'codex-auth-test-' }).json,
    { ok: true, robots: [{ id: w.robot.robotId, name: w.robot.robotName, codingAgents: ['codex'], codexAuthPresent: false }] });
  assert.equal(run(readCodexClientIdentity, w.robot).json.generation, generation);
  assert.equal(run(injectCodexAuth, w.robot, bytes).json.ok, true);
  assert.deepEqual(run(readRobotInventory, { prefix: 'codex-auth-test-' }).json.robots[0].codexAuthPresent, true);
  assert.equal(run(readCodexAuthForCopyBack, w.robot).json.size, bytes.length);
  assert.deepEqual(run(waitRobotCliExit, { robotName: w.robot.robotName }).json, { ok: true, count: 0 });
  assert.deepEqual(run(removeCodexAuth, w.robot, JSON.stringify({ expectedSha256: sha(bytes) })).json, { ok: true, removed: true });
  assert.deepEqual(run(readAlaSource, {}, '', { ...w.options, alaPath: alaTarget }).json, { ok: true, realpath: alaTarget });
  assert.deepEqual(await readAlaSource({}, { ...w.options, alaPath: alaTarget }), { ok: true, realpath: alaTarget });
  await rejectsWith(readAlaSource({}, { ...w.options, alaPath: path.join(w.data, 'absent') }), 'NOT_FOUND');
  const turn = turnFixture(t);
  assert.equal(run(readCodexTurnIdentity, turn.args, '', turn.options).json.ala.finalContainsToken, true);
});

test('the robot inventory reports credential presence for test robots only and counts every robot', async (t) => {
  const w = world(t);
  const defaultRobot = w.mk('default-d3472e', 'default', ['opencode']);
  fs.writeFileSync(defaultRobot.auth, authBytes('default-robot'), { mode: 0o600 });
  const broken = w.mk('broken-robot-0001', 'x', ['codex']);
  fs.writeFileSync(path.join(broken.root, 'metadata.json'), '{not json');
  fs.writeFileSync(w.auth, authBytes('test-robot'), { mode: 0o600 });
  fs.mkdirSync(path.join(w.data, 'robots', 'NotARobot'));
  const result = await readRobotInventory({ prefix: 'codex-auth-test-' }, w.options);
  const byId = Object.fromEntries(result.robots.map((robot) => [robot.id, robot]));
  assert.equal(result.robots.length, 3);
  assert.deepEqual(byId[w.robot.robotId], { id: w.robot.robotId, name: w.robot.robotName, codingAgents: ['codex'], codexAuthPresent: true });
  assert.deepEqual(byId['default-d3472e'], { id: 'default-d3472e', name: 'default', codingAgents: ['opencode'], codexAuthPresent: null });
  assert.deepEqual(byId['broken-robot-0001'], { id: 'broken-robot-0001', name: null, codingAgents: null, codexAuthPresent: null });
  await rejectsWith(readRobotInventory({ prefix: 'other-' }, w.options), 'INVALID_ARGUMENT');
  await rejectsWith(readRobotInventory({}, w.options), 'INVALID_ARGUMENT');
  const empty = world(t);
  fs.rmSync(path.join(empty.data, 'robots'), { recursive: true });
  await rejectsWith(readRobotInventory({ prefix: 'codex-auth-test-' }, empty.options), 'UNSAFE_PATH');
});

test('the host runner keeps credential bytes on stdin only and maps failures to codes', async (t) => {
  const w = world(t);
  const BOX = 'ploinky-box-fake-0123456789ab';
  const RT = 'a'.repeat(64);
  const bytes = authBytes('host-runner');
  const calls = [];
  const replies = [];
  const runCommand = async (argv, input = '', limits = {}) => {
    calls.push({ argv, input, limits });
    return replies.shift() || { exitCode: 0, stdout: Buffer.from('{"ok":true}\n') };
  };
  const runtime = createCodexRuntime({ box: BOX, runCommand, sleep: async () => {} });
  runtime.bindRoboTeam(RT);
  await runtime.inject(w.robot, bytes);
  const [{ argv, input }] = calls;
  assert.deepEqual(argv.slice(0, 12), ['exec', '-i', '--user', 'podman', BOX, 'podman', 'exec', '-i', RT, 'node', '--input-type=module', '-e']);
  assert.equal(argv.length, 13);
  assert.deepEqual(input, bytes, 'the credential travels on stdin');
  for (const part of argv) {
    assert.equal(part.includes(SECRET) || part.includes(bytes.toString('base64')) || part.includes(sha(bytes)), false);
  }
  assert.match(argv[12], /injectCodexAuth/);
  assert.match(argv[12], /"robotId":"codex-auth-test-r1-ab12"/);
  // The hash of the runtime bytes travels on stdin for the removal, never in the program text.
  calls.length = 0;
  await runtime.remove(w.robot, sha(bytes));
  assert.equal(calls[0].argv.join('\n').includes(sha(bytes)), false);
  assert.deepEqual(JSON.parse(calls[0].input), { expectedSha256: sha(bytes) });
  // Failure mapping: a code from the program, an unknown code, an unparsable reply and a non-zero exit without ok:true.
  replies.push({ exitCode: 1, stdout: Buffer.from('{"ok":false,"code":"TARGET_EXISTS"}\n') });
  await assert.rejects(runtime.inject(w.robot, bytes), (error) => error instanceof RuntimeProgramError && error.code === 'TARGET_EXISTS');
  replies.push({ exitCode: 1, stdout: Buffer.from('{"ok":false,"code":"SECRET-DETAIL"}\n') });
  await assert.rejects(runtime.inject(w.robot, bytes), (error) => error.code === 'FAILED' && !error.message.includes('SECRET'));
  replies.push({ exitCode: 0, stdout: Buffer.from('garbage with a secret\n') });
  await assert.rejects(runtime.inject(w.robot, bytes), (error) => error.code === 'FAILED' && !error.message.includes('secret'));
  replies.push({ exitCode: 3, stdout: Buffer.from('{"ok":true}\n') });
  await assert.rejects(runtime.inject(w.robot, bytes), (error) => error.code === 'FAILED');
  // Copy-back polls BUSY (bounded), then returns the decoded bytes; any other code stops at once.
  calls.length = 0;
  const busy = { exitCode: 1, stdout: Buffer.from('{"ok":false,"code":"BUSY"}\n') };
  replies.push(busy, busy, { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true, base64: bytes.toString('base64'), size: bytes.length, mode: '600' })) });
  const copy = await runtime.readForCopyBack(w.robot, { timeoutMs: 5000, intervalMs: 1 });
  assert.deepEqual(copy, { bytes, size: bytes.length, mode: '600' });
  assert.equal(calls.length, 3);
  replies.push(busy, busy, busy);
  await assert.rejects(runtime.readForCopyBack(w.robot, { timeoutMs: 0, intervalMs: 1 }), (error) => error.code === 'BUSY');
  replies.push({ exitCode: 1, stdout: Buffer.from('{"ok":false,"code":"NOT_FOUND"}\n') });
  await assert.rejects(runtime.readForCopyBack(w.robot), (error) => error.code === 'NOT_FOUND');
  // The CLI wait polls to zero, and times out otherwise.
  replies.push({ exitCode: 0, stdout: Buffer.from('{"ok":true,"count":2}\n') }, { exitCode: 0, stdout: Buffer.from('{"ok":true,"count":0}\n') });
  await runtime.waitCliExit(w.robot.robotName, { timeoutMs: 5000, intervalMs: 1 });
  replies.push({ exitCode: 0, stdout: Buffer.from('{"ok":true,"count":1}\n') });
  await assert.rejects(runtime.waitCliExit(w.robot.robotName, { timeoutMs: 0, intervalMs: 1 }), (error) => error.code === 'TIMEOUT');
  // An unbound runtime and a bad box name are refused before any command runs.
  calls.length = 0;
  await assert.rejects(createCodexRuntime({ box: BOX, runCommand }).inject(w.robot, bytes));
  assert.throws(() => createCodexRuntime({ box: '../etc' }));
  assert.equal(calls.length, 0);
});

test('the binding helpers derive the RoboTeam repository and compare bindings without the Codex client', () => {
  const root = '/work/space é/ws';
  const runtime = { mounts: [
    { Type: 'bind', Source: root, Destination: root, RW: true },
    { Type: 'bind', Source: `${root}/repos/AchillesCLI/roboTeamAgent`, Destination: `${root}/repos/AchillesCLI/roboTeamAgent`, RW: true },
    { Type: 'bind', Source: `${root}/.data/roboTeamAgent`, Destination: '/data', RW: true },
  ] };
  assert.equal(deriveRoboTeamRepository(runtime, root), `${root}/repos/AchillesCLI`);
  assert.throws(() => deriveRoboTeamRepository({ mounts: [] }, root));
  assert.throws(() => deriveRoboTeamRepository({ mounts: [...runtime.mounts, { ...runtime.mounts[1], Source: `${root}/other/roboTeamAgent`, Destination: `${root}/other/roboTeamAgent` }] }, root));
  assert.throws(() => deriveRoboTeamRepository({ mounts: [{ ...runtime.mounts[1], Source: '/elsewhere' }] }, root));
  const binding = { smoke: { commit: 'a' }, box: { id: 'b' }, codexClient: { version: '0.160.0' } };
  assert.equal(bindingUnchanged(binding, { ...binding, codexClient: { version: '0.161.0' } }), true);
  assert.equal(bindingUnchanged(binding, { ...binding, box: { id: 'c' } }), false);
  assert.equal(bindingUnchanged(binding, { smoke: binding.smoke, codexClient: binding.codexClient }), false);
});

test('the imported live-skills runtime helpers still exist with the expected arity', () => {
  // Function.length stops at the first parameter with a default, so the validator reports 2 although it takes a third options object.
  assert.equal(typeof program, 'function');
  assert.equal(program.length, 2);
  assert.equal(typeof readRegistryAndRuntime, 'function');
  assert.equal(readRegistryAndRuntime.length, 1);
  assert.equal(typeof validateLiveSkillsRuntimeBinding, 'function');
  assert.equal(validateLiveSkillsRuntimeBinding.length, 2);
  // `program` still serializes a function with its JSON arguments, which is how the Box-level registry read runs.
  const text = program(readRegistryAndRuntime, { workspaceRoot: '/work/ws' });
  assert.match(text, /readRegistryAndRuntime/);
  assert.match(text, /\{"workspaceRoot":"\/work\/ws"\}/);
  assert.throws(() => validateLiveSkillsRuntimeBinding({}, '/x', { workspaceRoot: '/work/ws' }));
});

test('a credential phase is awaited until it settles even when it overruns its budget', async () => {
  const events = [];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  // A phase that overruns its budget but succeeds: the caller only continues after the work finished.
  await credentialPhase(5, async () => { await delay(60); events.push('work-finished'); });
  events.push('caller-continues');
  assert.deepEqual(events, ['work-finished', 'caller-continues']);
  // A late failure is reported, and still only after the work settled.
  events.length = 0;
  await assert.rejects(credentialPhase(5, async () => { await delay(60); events.push('late-failure'); throw new RuntimeProgramError('TIMEOUT'); }),
    (error) => error.code === 'TIMEOUT');
  assert.deepEqual(events, ['late-failure']);
  // A prompt failure and a prompt success behave as usual, and an empty throw is still a failure.
  await assert.rejects(credentialPhase(1000, async () => { throw new RuntimeProgramError('BUSY'); }), (error) => error.code === 'BUSY');
  await assert.rejects(credentialPhase(1000, async () => { throw undefined; }));
  await credentialPhase(1000, async () => {});
  // The budget timer never keeps the process alive after a fast phase.
  const started = Date.now();
  await credentialPhase(60_000, async () => {});
  assert.ok(Date.now() - started < 5000);
});
