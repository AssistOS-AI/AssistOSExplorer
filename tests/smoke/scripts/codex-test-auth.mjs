#!/usr/bin/env node

// Entry point of the Codex-authenticated Copilot gate: seed, preflight, run, scan-leaks, retire, adopt.
// Two credential routes: `owner` (route A, the default for preflight, run and scan-leaks) derives an access-only credential from the
// machine owner's Codex login, read-only; `stream` (route B) uses the owned login stream. CODEX_TEST_AUTH_SOURCE selects the route and
// there is never an automatic fallback. seed, retire and adopt are stream-only.
// Stdout is exactly one sanitized JSON line for every subcommand and every outcome, and it names the route. Prompts and diagnostics go
// to stderr as fixed English sentences. Credential bytes are never printed, logged, passed in argv or placed in the environment.
// This file never imports lib/config.mjs (it creates an artifact directory at import time) and never runs Codex.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  CodexAuthError, EXIT_CODES, RUN_TIMEOUT_MS, RUN_WATCHDOG_MS, adoptQuarantine, assertArtifactDirectory, assertNoOtherRouteInflight, assertNoQuarantine,
  assertPrivateRoot, collectScanReferences, decideRunOutcome, describeFailure, inflightPresent, inspectStream, isRunId, listQuarantines, loadStream,
  lockStatus, planRecovery, readInflight, resolveAuthPaths, resultLine, retireStream, scanLeaks, seedStream,
} from '../lib/codex-test-auth.mjs';
import {
  assertAccessValidity, assertOwnerScanCoverage, deriveAccessOnlyAuth, ownerDirectoryFor, ownerScanReferences, planOwnerRun, readOwnerAuth,
  resolveCredentialSource, resolveOwnerAuthPath, summarizeOwner,
} from '../lib/codex-test-auth-owner.mjs';
import { checkClientQualification } from '../lib/codex-client-qualification.mjs';
import { RuntimeProgramError, TEST_ROBOT_PREFIX, createCodexRuntime } from '../lib/codex-test-auth-runtime.mjs';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC = 'specs/07-copilot-codex-native.spec.mjs';

function repositoryRoot() {
  let current = smokeRoot;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return smokeRoot;
    current = parent;
  }
}

const absoluteEnv = (value) => (typeof value === 'string' && path.isAbsolute(value) ? value : null);

function forbiddenRoots(env) {
  return [repositoryRoot(), smokeRoot, absoluteEnv(env.SMOKE_WORKSPACE_ROOT), absoluteEnv(env.SMOKE_ARTIFACT_DIR)].filter(Boolean);
}

function emit(fields) {
  process.stdout.write(`${resultLine(fields)}\n`);
  process.exitCode = EXIT_CODES[fields.code ?? 'OK'];
}

function say(sentence) {
  process.stderr.write(`${sentence}\n`);
}

// Blocks until a newline (or end of input) arrives on a terminal descriptor, without leaving a read pending afterwards.
function waitForLineSync(fd) {
  const byte = Buffer.alloc(1);
  for (;;) {
    let read;
    try { read = fs.readSync(fd, byte, 0, 1, null); } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EOF') return;
      throw error;
    }
    if (read === 0 || byte[0] === 0x0a) return;
  }
}

// The operator step of `seed`: print the exact login command, then wait for Enter. The prompt goes to /dev/tty when there
// is one (read synchronously, so the process can exit right after), otherwise to stderr and stdin, so stdout stays a single
// JSON line.
async function waitForOperator({ command }) {
  let tty = null;
  try { tty = fs.openSync('/dev/tty', 'r+'); } catch { tty = null; }
  const write = (text) => (tty === null ? process.stderr.write(text) : fs.writeSync(tty, text));
  write('Run this command in a second terminal on this host, complete the device login, and wait for the command to exit:\n\n');
  write(`  ${command}\n\n`);
  write('Press Enter here only after the login command has exited. ');
  if (tty !== null) {
    waitForLineSync(tty);
    write('\n');
    fs.closeSync(tty);
    return;
  }
  await new Promise((resolve) => {
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => { lines.close(); resolve(); });
    lines.once('close', resolve);
  });
  write('\n');
}

async function seed(paths, env) {
  const bin = env.CODEX_TEST_AUTH_SEED_BIN;
  if (typeof bin !== 'string' || bin === '') throw new CodexAuthError('USAGE', 'bad-variable');
  if (!path.isAbsolute(bin)) throw new CodexAuthError('USAGE', 'relative-path');
  assertPrivateRoot(paths, { forbiddenRoots: forbiddenRoots(env) });
  const result = await seedStream(paths, { seedBin: bin, waitForOperator });
  return { command: 'seed', result: 'done', stream: paths.stream, ...result };
}

// Box-level, read-only facts for the report. Anything that fails here is an unmet prerequisite.
async function readRuntimeFacts(env) {
  const box = env.SMOKE_PLOINKY_BOX_CONTAINER;
  const workspaceRoot = env.SMOKE_WORKSPACE_ROOT;
  if (typeof box !== 'string' || box === '' || !absoluteEnv(workspaceRoot)) throw new CodexAuthError('USAGE', 'bad-variable');
  const runtime = createCodexRuntime({ box });
  try {
    const outer = await runtime.inspectBox();
    const registry = await runtime.registryRuntime(workspaceRoot);
    const robots = await runtime.robotInventory();
    const client = await runtime.clientIdentity().catch((error) => {
      if (error instanceof RuntimeProgramError) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'codex-client-missing');
      throw error;
    });
    return { runtime, robots, client, facts: {
      box: { name: box, id12: String(outer.Id).slice(0, 12), startedAt: outer.State?.StartedAt ?? null },
      roboTeam: { containerId12: registry.containerId.slice(0, 12), startedAt: registry.startedAt },
      robots: { total: robots.length, ownedLeftovers: robots.filter((robot) => robot.name?.startsWith(TEST_ROBOT_PREFIX)).length,
        codexAuthPresentInTestRobots: robots.filter((robot) => robot.codexAuthPresent === true).length },
      codexClient: { toolCacheCurrentVersion: client.version },
    } };
  } catch (error) {
    if (error instanceof RuntimeProgramError) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'binding');
    throw error;
  }
}

// Read-only: nothing under ROOT, the artifact directory or the Box is created or changed.
async function preflight(paths, env) {
  const info = { command: 'preflight', stream: paths.stream };
  try {
    assertPrivateRoot(paths, { forbiddenRoots: forbiddenRoots(env) });
    assertNoOtherRouteInflight(paths, 'stream');
    const state = inspectStream(paths);
    Object.assign(info, state);
    const lock = lockStatus(paths);
    if (lock.state === 'held') throw new CodexAuthError('LOCK_HELD', lock.reason);
    if (state.quarantineCount > 0) throw new CodexAuthError('STREAM_UNSAFE', 'quarantine-pending');
    const { robots, client, facts } = await readRuntimeFacts(env);
    Object.assign(info, facts);
    planRecovery({ inflight: readInflight(paths), robots });
    const pin = env.CODEX_TEST_EXPECT_CODEX_VERSION;
    if (pin && pin !== client.version) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'version-pin');
    return { ...info, result: 'ready' };
  } catch (error) {
    // The facts gathered so far are still reported, with the failure.
    const failure = describeFailure(error);
    if (!(error instanceof CodexAuthError)) say('Preflight failed with an unexpected error.');
    return { ...info, result: 'not-ready', ...failure };
  }
}

async function scanLeaksCommand(paths, env, argv) {
  const directory = assertArtifactDirectory(argv[3] ?? env.SMOKE_ARTIFACT_DIR, { paths, forbiddenRoots: forbiddenRoots({ ...env, SMOKE_ARTIFACT_DIR: undefined }) });
  const { leaks, filesScanned } = scanLeaks(directory, collectScanReferences(paths));
  const leaked = leaks.length > 0;
  return { command: 'scan-leaks', result: leaked ? 'failed' : 'done', code: leaked ? 'LEAK_DETECTED' : 'OK',
    reason: leaked ? 'artifact-contains-token' : null, stream: paths.stream, artifactDirectory: directory, leaks: leaks.length, filesScanned,
    findings: leaks };
}

// The directories route A must keep every other root away from: the located owner directory joins the forbidden roots of ROOT and of the
// artifact directory, so neither can be created inside the owner's Codex directory.
const withOwnerDirectory = (roots, ownerDirectory) => [...roots, ownerDirectory].filter(Boolean);

// Route A. Read-only: nothing under ROOT, the artifact directory, the owner directory or the Box is created or changed. The order is
// fixed: ROOT checks, then the facts that stay reportable when the owner gate fails (a pending marker is recovered by a run even then),
// the lock, the other route's marker, the owner gate, and only then anything that touches Podman.
async function preflightOwner(paths, env) {
  const info = { command: 'preflight', stream: null };
  const bytesHeld = [];
  try {
    const ownerDirectory = ownerDirectoryFor(env, paths);
    const checked = assertPrivateRoot(paths, { forbiddenRoots: withOwnerDirectory(forbiddenRoots(env), ownerDirectory) });
    const lock = lockStatus(paths);
    Object.assign(info, { rootExists: checked.exists, lock: lock.state, inflight: inflightPresent(paths, { route: 'owner' }) ? 'present' : 'absent',
      otherRouteInflight: inflightPresent(paths) });
    if (lock.state === 'held') throw new CodexAuthError('LOCK_HELD', lock.reason);
    assertNoOtherRouteInflight(paths, 'owner');
    const { file, source } = resolveOwnerAuthPath(env, paths, { forbiddenRoots: forbiddenRoots(env) });
    info.owner = { source, readable: false };
    const { bytes } = await readOwnerAuth(file);
    bytesHeld.push(bytes);
    info.owner = summarizeOwner(bytes, { remainingRunMs: RUN_TIMEOUT_MS, source });
    const { derived, expMs } = deriveAccessOnlyAuth(bytes);
    bytesHeld.push(derived);
    assertAccessValidity({ expMs, now: Date.now(), remainingRunMs: RUN_TIMEOUT_MS });
    const { runtime, robots, client, facts } = await readRuntimeFacts(env);
    Object.assign(info, facts);
    planRecovery({ inflight: readInflight(paths, { route: 'owner' }), robots });
    const { report, failure } = await checkClientQualification({ runtime, identity: client });
    info.codexClient = { toolCacheCurrentVersion: client.version, generation12: report.generation12, platform: report.platform, nativeSha256: report.nativeSha256,
      qualification: report.status };
    if (failure) throw failure;
    const pin = env.CODEX_TEST_EXPECT_CODEX_VERSION;
    if (pin && pin !== client.version) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'version-pin');
    return { ...info, result: 'ready' };
  } catch (error) {
    // The facts gathered so far are still reported, with the failure.
    const failure = describeFailure(error);
    if (!(error instanceof CodexAuthError)) say('Preflight failed with an unexpected error.');
    return { ...info, result: 'not-ready', ...failure };
  } finally { for (const held of bytesHeld) held.fill(0); }
}

// Route A: the references are the current owner login and what ROOT holds (a stream, when one exists). Best effort after an owner refresh:
// the scan inside `run` is the authoritative one. An empty set is refused, as for every other caller.
async function scanLeaksOwner(paths, env, argv) {
  const ownerDirectory = ownerDirectoryFor(env, paths);
  const directory = assertArtifactDirectory(argv[3] ?? env.SMOKE_ARTIFACT_DIR, { paths,
    forbiddenRoots: withOwnerDirectory(forbiddenRoots({ ...env, SMOKE_ARTIFACT_DIR: undefined }), ownerDirectory) });
  // The owner references are the owner's own buffers and the buffers derived from them. They are wiped only after the scan has read them.
  const ownerBuffers = [];
  const references = [];
  let ownerReferences = 'unavailable';
  try {
    try {
      const { file } = resolveOwnerAuthPath(env, paths, { forbiddenRoots: forbiddenRoots({ ...env, SMOKE_ARTIFACT_DIR: undefined }) });
      const { bytes } = await readOwnerAuth(file);
      ownerBuffers.push(bytes);
      const owned = ownerScanReferences(bytes);
      ownerBuffers.push(...owned);
      references.push(...owned);
      ownerReferences = 'loaded';
    } catch { /* the owner login may be absent or unusable; the scan then relies on what ROOT holds */ }
    references.push(...collectScanReferences(paths));
    let scanned;
    try { scanned = scanLeaks(directory, references); } catch (error) {
      // An empty reference set is refused. The failure still says whether the owner login could be loaded.
      if (!(error instanceof CodexAuthError)) throw error;
      return { command: 'scan-leaks', result: 'failed', ...describeFailure(error), stream: null, artifactDirectory: directory, ownerReferences };
    }
    const { leaks, filesScanned } = scanned;
    const leaked = leaks.length > 0;
    return { command: 'scan-leaks', result: leaked ? 'failed' : 'done', code: leaked ? 'LEAK_DETECTED' : 'OK',
      reason: leaked ? 'artifact-contains-token' : null, stream: null, artifactDirectory: directory, leaks: leaks.length, filesScanned,
      findings: leaks, ownerReferences };
  } finally { for (const buffer of ownerBuffers) buffer.fill(0); }
}

function runPlaywright(args, env, stdio) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(smokeRoot, 'scripts', 'run-playwright.mjs'), ...args], { cwd: smokeRoot, env, stdio });
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }, RUN_WATCHDOG_MS);
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code: signal ? 1 : (code ?? 1), output }); });
  });
}

function readResultFile(directory) {
  const file = path.join(directory, 'codex-auth', 'result.json');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { return null; } finally { fs.closeSync(fd); }
}

async function run(paths, env) {
  const base = { command: 'run', stream: paths.stream };
  const directory = assertArtifactDirectory(env.SMOKE_ARTIFACT_DIR, { paths, forbiddenRoots: forbiddenRoots({ ...env, SMOKE_ARTIFACT_DIR: undefined }) });
  base.artifactDirectory = directory;
  const runId = env.SMOKE_RUN_ID || `codex-auth-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
  if (!isRunId(runId)) throw new CodexAuthError('USAGE', 'bad-variable');
  assertPrivateRoot(paths, { forbiddenRoots: forbiddenRoots(env) });
  assertNoOtherRouteInflight(paths, 'stream');
  // Read-only: the pre-run stream stays in memory for the leak scan. Nothing is written under ROOT by this parent.
  const before = loadStream(paths);
  // With a marker pending, the worker recovers first; the quarantine refusal then follows that cleanup.
  if (!inflightPresent(paths)) assertNoQuarantine(paths);
  const childEnv = { ...env, SMOKE_COPILOT_CODEX: '1', SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: directory,
    CODEX_TEST_AUTH_ROOT: paths.root, CODEX_TEST_AUTH_STREAM: paths.stream };
  const playwrightArgs = ['--project=chromium', '--workers=1', '--retries=0', SPEC];
  const listed = await runPlaywright([...playwrightArgs, '--list'], childEnv, ['ignore', 'pipe', 'pipe']);
  if (listed.code !== 0 || !/Total: 1 tests? in 1 files?/.test(listed.output)) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'selection-count');
  const quarantinesBefore = new Set(listQuarantines(paths));
  const logDirectory = path.join(directory, 'codex-auth');
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(logDirectory, 'playwright.log'),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  let exited;
  try { exited = await runPlaywright(playwrightArgs, childEnv, ['ignore', logFd, logFd]); } finally { fs.closeSync(logFd); }
  const result = readResultFile(directory);
  // Every credential this run could have held: the stream before, the stream after and any new quarantine file.
  const sets = [before.bytes];
  try { sets.push(loadStream(paths).bytes); } catch { /* the stream may have been retired by an operator mid-run */ }
  for (const quarantine of listQuarantines(paths).filter((id) => !quarantinesBefore.has(id))) {
    try { sets.push(fs.readFileSync(path.join(paths.streamDir, `quarantine-${quarantine}.json`))); } catch { /* skipped */ }
  }
  const { leaks } = scanLeaks(directory, sets);
  return { ...base, ...decideRunOutcome({ leaks, result, exitedCode: exited.code }) };
}

// Route A. The parent reads the owner login before and after the worker runs and keeps both reads in memory. They are the leak-scan
// references, and byte-identical reads prove that every credential the worker could have read is among them. With a route-A marker
// pending, the worker is spawned even when the owner gate fails, so a crashed run's leftover copy is recovered first.
async function runOwner(paths, env) {
  const base = { command: 'run', stream: null };
  const ownerDirectory = ownerDirectoryFor(env, paths);
  const directory = assertArtifactDirectory(env.SMOKE_ARTIFACT_DIR, { paths,
    forbiddenRoots: withOwnerDirectory(forbiddenRoots({ ...env, SMOKE_ARTIFACT_DIR: undefined }), ownerDirectory) });
  base.artifactDirectory = directory;
  const runId = env.SMOKE_RUN_ID || `codex-auth-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
  if (!isRunId(runId)) throw new CodexAuthError('USAGE', 'bad-variable');
  assertPrivateRoot(paths, { forbiddenRoots: withOwnerDirectory(forbiddenRoots(env), ownerDirectory) });
  assertNoOtherRouteInflight(paths, 'owner');
  const pendingRecovery = inflightPresent(paths, { route: 'owner' });
  let ownerFile = null;
  let ownerSource = null;
  let pre = null;
  let post = null;
  let ownerGateFailure = null;
  try {
    ({ file: ownerFile, source: ownerSource } = resolveOwnerAuthPath(env, paths, { forbiddenRoots: forbiddenRoots(env) }));
    pre = (await readOwnerAuth(ownerFile)).bytes;
    const { derived, expMs } = deriveAccessOnlyAuth(pre);
    derived.fill(0);
    assertAccessValidity({ expMs, now: Date.now(), remainingRunMs: RUN_TIMEOUT_MS });
  } catch (error) {
    ownerGateFailure = describeFailure(error);
    if (!(error instanceof CodexAuthError)) say('The owner login check failed with an unexpected error.');
  }
  const ownerGate = ownerGateFailure ? ownerGateFailure.reason : 'pass';
  // Every owner buffer and every buffer derived from one is wiped in the `finally`, after the scan has read them.
  let references = [];
  try {
    const plan = planOwnerRun({ pendingRecovery, ownerGateFailure });
    if (!plan.spawn) return { ...base, result: 'failed', ...plan.earlyFailure, ownerGate, spawnedForRecovery: false };
    const childEnv = { ...env, SMOKE_COPILOT_CODEX: '1', SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: directory,
      CODEX_TEST_AUTH_ROOT: paths.root, CODEX_TEST_AUTH_STREAM: paths.stream, CODEX_TEST_AUTH_SOURCE: 'owner',
      // Only an override is passed on. For the default path the worker resolves it itself, so its result says `default`.
      ...(ownerSource === 'override' ? { CODEX_TEST_AUTH_OWNER_AUTH: ownerFile } : {}) };
    const playwrightArgs = ['--project=chromium', '--workers=1', '--retries=0', SPEC];
    const listed = await runPlaywright([...playwrightArgs, '--list'], childEnv, ['ignore', 'pipe', 'pipe']);
    if (listed.code !== 0 || !/Total: 1 tests? in 1 files?/.test(listed.output)) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'selection-count');
    const logDirectory = path.join(directory, 'codex-auth');
    fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(logDirectory, 'playwright.log'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    let exited;
    try { exited = await runPlaywright(playwrightArgs, childEnv, ['ignore', logFd, logFd]); } finally { fs.closeSync(logFd); }
    const result = readResultFile(directory);
    if (ownerFile) { try { post = (await readOwnerAuth(ownerFile)).bytes; } catch { post = null; } }
    let coverage = 'unproven';
    try { coverage = assertOwnerScanCoverage({ preBytes: pre, postBytes: post, result }); } catch { coverage = 'unproven'; }
    references = [...(pre ? ownerScanReferences(pre) : []), ...(post ? ownerScanReferences(post) : [])];
    // With no owner read at all and a worker that never derived a credential, nothing could have leaked, so the scan is skipped.
    let leaks = [];
    let leakScan = 'skipped';
    if (references.length > 0) { ({ leaks } = scanLeaks(directory, references)); leakScan = 'scanned'; }
    const outcome = decideRunOutcome({ leaks, coverageFailure: coverage === 'unproven', result, exitedCode: exited.code });
    return { ...base, ...outcome, ownerGate, spawnedForRecovery: plan.spawnedForRecovery, ownerChangedDuringRun: pre && post ? !pre.equals(post) : null,
      leakScanCoverage: coverage, leakScan };
  } finally {
    pre?.fill(0);
    post?.fill(0);
    for (const buffer of references) buffer.fill(0);
  }
}

const COMMANDS = {
  seed: (paths, env) => seed(paths, env),
  preflight: (paths, env, argv, route) => (route === 'owner' ? preflightOwner(paths, env) : preflight(paths, env)),
  run: (paths, env, argv, route) => (route === 'owner' ? runOwner(paths, env) : run(paths, env)),
  'scan-leaks': (paths, env, argv, route) => (route === 'owner' ? scanLeaksOwner(paths, env, argv) : scanLeaksCommand(paths, env, argv)),
  retire: async (paths, env) => {
    assertPrivateRoot(paths, { forbiddenRoots: forbiddenRoots(env) });
    return { command: 'retire', result: 'done', stream: paths.stream, ...retireStream(paths) };
  },
  adopt: async (paths, env, argv) => {
    if (!isRunId(argv[3])) throw new CodexAuthError('USAGE', 'bad-variable');
    assertPrivateRoot(paths, { forbiddenRoots: forbiddenRoots(env) });
    return { command: 'adopt', result: 'done', stream: paths.stream, ...adoptQuarantine(paths, { runId: argv[3] }) };
  },
};

async function main(argv, env) {
  const name = argv[2] ?? null;
  if (!Object.hasOwn(COMMANDS, name ?? '')) {
    emit({ command: name && /^[a-z-]{1,20}$/.test(name) ? name : null, route: null, result: 'failed', code: 'USAGE', reason: 'bad-subcommand' });
    return;
  }
  // The route is resolved once and named in every line. It is null when the resolution itself failed.
  let route = null;
  try {
    route = resolveCredentialSource(env, { command: name });
    const paths = resolveAuthPaths(env);
    const outcome = await COMMANDS[name](paths, env, argv, route);
    const code = outcome.code ?? 'OK';
    emit({ ...outcome, route, code, reason: outcome.reason ?? null });
  } catch (error) {
    const failure = describeFailure(error);
    if (!(error instanceof CodexAuthError)) say('The command failed with an unexpected error.');
    emit({ command: name, route, result: name === 'preflight' ? 'not-ready' : 'failed', ...failure });
  }
}

await main(process.argv, process.env);
