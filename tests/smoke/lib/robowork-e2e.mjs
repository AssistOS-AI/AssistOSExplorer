import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Helpers of specs/08-robowork-worker.spec.mjs: host-side fixtures, nested-container access (the Ploinky Box runs the agents as
// nested podman containers), a /proc poller inside the worker container (its image has no `ps`), and a read-only copy of the
// worker's SQLite ledger. Nothing here prints or stores a credential. The fixture "secrets" are random sentinels created by the run.

const here = path.dirname(fileURLToPath(import.meta.url));
const NESTED_STDOUT_LIMIT = 6000;
export const POLL_FILE = '/tmp/robowork-proc-poll.jsonl';
const POLLER_FILE = '/tmp/robowork-proc-poller.mjs';

function run(file, args, { input, timeout = 60_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync(file, args, { input, timeout, maxBuffer, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------------------------------------------- containers

export function discoverContainers({ workspaceRoot, boxName = process.env.SMOKE_ROBOWORK_BOX } = {}) {
  let box = boxName;
  if (!box) {
    const label = path.basename(workspaceRoot).toLowerCase();
    const boxes = run('podman', ['ps', '--format', '{{.Names}}']).split('\n').map((line) => line.trim())
      .filter((name) => name.startsWith('ploinky-box-') && name.includes(label));
    if (boxes.length !== 1) throw new Error(`Expected exactly one running Ploinky Box for ${label}; found ${boxes.length}. Set SMOKE_ROBOWORK_BOX.`);
    box = boxes[0];
  }
  const inner = run('podman', ['exec', box, 'podman', 'ps', '--format', '{{.Names}}']).split('\n').map((line) => line.trim()).filter(Boolean);
  const pick = (needle) => {
    const matches = inner.filter((name) => name.includes(`_${needle}_`));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${needle} container in ${box}; found ${matches.length}.`);
    return matches[0];
  };
  return { box, worker: pick('robo-work'), roboTeam: pick('roboTeamAgent') };
}

export function nested(containers, container, argv, options) {
  return run('podman', ['exec', ...(options?.input === undefined ? [] : ['-i']), containers.box, 'podman', 'exec', ...(options?.input === undefined ? [] : ['-i']), container, ...argv], options);
}

// `podman logs` writes the container's stderr to stderr; execFileSync with piped stdio only returns stdout, so merge both.
export function nestedLogsMerged(containers, container, sinceIso) {
  const result = execFileSync('sh', ['-c', `podman exec "$1" podman logs --since "$2" "$3" 2>&1`, 'sh', containers.box, sinceIso, container], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  });
  return result;
}

// Copies a file out of a nested container. The nested exec truncates stdout at about 8 KiB, so the file is gzipped, base64 encoded,
// and read in bounded slices.
export function fetchFile(containers, container, containerPath) {
  const stage = `${containerPath}.fetch`;
  nested(containers, container, ['sh', '-c', `gzip -c '${containerPath}' | base64 -w0 > '${stage}.b64'`]);
  const size = Number(nested(containers, container, ['sh', '-c', `wc -c < '${stage}.b64'`]).trim());
  let encoded = '';
  for (let offset = 0; offset < size; offset += NESTED_STDOUT_LIMIT) {
    encoded += nested(containers, container, ['sh', '-c', `tail -c +${offset + 1} '${stage}.b64' | head -c ${NESTED_STDOUT_LIMIT}`]);
  }
  nested(containers, container, ['sh', '-c', `rm -f '${stage}.b64'`]);
  return zlib.gunzipSync(Buffer.from(encoded, 'base64'));
}

// ---------------------------------------------------------------------------------------------------------------- /proc poller

export function startPoller(containers) {
  const source = fs.readFileSync(path.join(here, 'robowork-proc-poller.mjs'), 'utf8');
  nested(containers, containers.worker, ['sh', '-c', `cat > ${POLLER_FILE}`], { input: source });
  // Stops an earlier poller of ours (the image has no pkill), then starts a fresh one writing a fresh file.
  nested(containers, containers.worker, ['sh', '-c',
    `for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "^node ${POLLER_FILE}"; then kill \${p#/proc/}; fi; done; sleep 0.3; rm -f ${POLL_FILE}; ( node ${POLLER_FILE} ${POLL_FILE} >/dev/null 2>&1 & ); sleep 1; test -s ${POLL_FILE}`]);
}

export function stopPoller(containers) {
  try {
    nested(containers, containers.worker, ['sh', '-c',
      `for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "^node ${POLLER_FILE}"; then kill \${p#/proc/}; fi; done`]);
  } catch { /* already gone */ }
}

export function readPoll(containers) {
  const text = fetchFile(containers, containers.worker, POLL_FILE).toString('utf8').trim();
  return text ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

// Processes of the poll that run bubblewrap with the reservation marker on the real argv: `--unsetenv <marker> --args N`.
export function bwrapMarkerProcesses(poll) {
  const found = [];
  for (const entry of poll) {
    if (entry.ev !== 'new') continue;
    const match = /(?:^|\s)\/usr\/bin\/bwrap --unshare-uts --unsetenv (\S+) --args (\d+) --(?:\s|$)/.exec(entry.cmd ?? '');
    if (match) found.push({ at: entry.at, pid: entry.pid, ppid: entry.ppid, marker: match[1], argsFd: Number(match[2]), command: entry.cmd.slice(0, 240) });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------- ledger

// Opens a COPY of the ledger (database, WAL and shared-memory file together) read-only, so the worker's own files are not touched.
export function readLedger({ workspaceRoot, scratchDir, robotName }) {
  const source = path.join(workspaceRoot, '.data/robo-work/state/execution-store');
  const copy = fs.mkdtempSync(path.join(scratchDir, 'ledger-copy-'));
  try {
    for (const name of ['worker-state.sqlite', 'worker-state.sqlite-wal', 'worker-state.sqlite-shm']) {
      try { fs.copyFileSync(path.join(source, name), path.join(copy, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const db = new DatabaseSync(path.join(copy, 'worker-state.sqlite'), { readOnly: true });
    const all = (sql, ...params) => db.prepare(sql).all(...params);
    const robot = all('select id, name, lifecycle, revision, configuration, owner_id, attested_generation from robot where name = ?', robotName)[0] ?? null;
    const admissions = robot ? all('select execution_id, attempt_id, logical_id, logical_kind, robot_id, kind, state, end_classification, end_payload, result, created_at, updated_at, specification from admission where robot_id = ? order by created_at', robot.id) : [];
    const executions = admissions.map((row) => {
      const { specification, ...rest } = row;
      const spec = JSON.parse(specification);
      const reference = all('select id from reference where execution_id = ?', row.execution_id)[0] ?? null;
      return {
        ...rest,
        specification: { cwd: spec.cwd, folders: spec.folders, ignore: spec.ignore, permissions: spec.permissions, sessionId: spec.sessionId, turnId: spec.turnId, promptChars: spec.prompt?.length },
        events: reference ? all('select sequence, at, type, data from reference_event where reference_id = ? order by sequence', reference.id) : [],
        blockers: all('select resource_id, kind, process_bearing, locator, identity, release_state, retained, created_at, committed_at, settled_at from resource_blocker where execution_id = ? order by created_at', row.execution_id),
      };
    });
    const dump = { robot, executions, tables: Object.fromEntries(all("select name from sqlite_master where type = 'table'").map(({ name }) => [name, db.prepare(`select count(*) c from "${name}"`).get().c])) };
    db.close();
    return dump;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------- fixture

const SENTINEL = () => crypto.randomBytes(9).toString('hex');

// The e2e project (host side, inside the workspace). The "secret" files carry run-unique sentinels, so any appearance of one in a
// model answer, an event, a log or a DOM is a proven leak. The directory is replaced if it already exists (it must be the exact
// run-owned name, directly under the workspace root).
export function createProjectFixture({ workspaceRoot, name }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(name)) throw new Error('Invalid fixture project name.');
  const root = path.join(workspaceRoot, name);
  if (path.dirname(root) !== workspaceRoot) throw new Error('The fixture project must sit directly under the workspace root.');
  fs.rmSync(root, { recursive: true, force: true });
  const mark = { readme: `README-MARK-${SENTINEL()}`, env: `ENV-SENTINEL-${SENTINEL()}`, masterKey: `KEY-SENTINEL-${SENTINEL()}`, secrets: `SECRETS-SENTINEL-${SENTINEL()}`, subEnv: `SUBENV-SENTINEL-${SENTINEL()}` };
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
  write('README.md', `# e2e project\n\n${mark.readme}\n`);
  write('.env', `API_TOKEN=${mark.env}\n`);
  write('master-key', `${mark.masterKey}\n`);
  write('x.secrets', `${mark.secrets}\n`);
  write('.data/probe.txt', 'root .data\n');
  write('.ploinky/probe.txt', 'root .ploinky\n');
  write('.roboteam/probe.txt', 'root .roboteam\n');
  write('sub/.env', `SUB_TOKEN=${mark.subEnv}\n`);
  write('sub/.data/probe.txt', 'sub .data\n');
  write('sub/.ploinky/probe.txt', 'sub .ploinky\n');
  const protectedFiles = { '.env': `API_TOKEN=${mark.env}\n`, 'master-key': `${mark.masterKey}\n`, 'x.secrets': `${mark.secrets}\n`, 'sub/.env': `SUB_TOKEN=${mark.subEnv}\n` };
  return { root, mark, protectedFiles, sentinels: [mark.env, mark.masterKey, mark.secrets, mark.subEnv] };
}

export function sentinelHits(text, sentinels) {
  const haystack = String(text);
  return sentinels.filter((sentinel) => haystack.includes(sentinel));
}

// ---------------------------------------------------------------------------------------------------------------- environment identity

// git from outside any repository (a cwd under the file-parser workspace breaks git discovery on this host). `dirty` is true when
// `git status --porcelain` lists anything (tracked changes or untracked files), with the count.
function gitState(repository) {
  const git = (args) => run('git', ['-C', repository, ...args], { timeout: 30_000 });
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const changes = git(['status', '--porcelain']).split('\n').filter(Boolean);
    return { head, dirty: changes.length > 0, changedPaths: changes.length };
  } catch (error) { return { head: `unavailable: ${String(error.message).split('\n')[0].slice(0, 120)}`, dirty: null, changedPaths: null }; }
}

function hostPloinkyCheckout() {
  const binary = process.env.SMOKE_PLOINKY_BIN || (() => { try { return run('sh', ['-c', 'command -v ploinky']).trim(); } catch { return ''; } })();
  if (!binary) return null;
  try { return path.dirname(path.dirname(fs.realpathSync(binary))); } catch { return null; }
}

// What the run was done on: the deployed source revisions, the host ploinky checkout and the image IDs of the Box and of the two
// containers. Read-only. Saved with every run; SMOKE_EXPECT_EXPLORER_COMMIT (a full or abbreviated commit) is asserted against the deployed AchillesIDE HEAD.
export function collectEnvironment({ workspaceRoot, containers }) {
  const imageId = (argv) => { try { return run('podman', argv, { timeout: 20_000 }).trim(); } catch (error) { return `unavailable: ${String(error.message).split('\n')[0].slice(0, 120)}`; } };
  const ploinky = hostPloinkyCheckout();
  const environment = {
    collectedAt: new Date().toISOString(),
    workspaceRoot,
    deployedRevisions: {
      AchillesIDE: gitState(path.join(workspaceRoot, '.ploinky/repos/AchillesIDE')),
      AdvancedLanguageAgent: gitState(path.join(workspaceRoot, 'AdvancedLanguageAgent')),
      ploinky: { checkout: ploinky, ...(ploinky ? gitState(ploinky) : { head: null, dirty: null, changedPaths: null }) },
    },
    images: {
      box: { container: containers.box, imageId: imageId(['inspect', '--format', '{{.Image}}', containers.box]) },
      worker: { container: containers.worker, imageId: imageId(['exec', containers.box, 'podman', 'inspect', '--format', '{{.Image}}', containers.worker]) },
      roboTeam: { container: containers.roboTeam, imageId: imageId(['exec', containers.box, 'podman', 'inspect', '--format', '{{.Image}}', containers.roboTeam]) },
    },
    expectedExplorerCommit: process.env.SMOKE_EXPECT_EXPLORER_COMMIT || null,
  };
  const expected = environment.expectedExplorerCommit;
  if (expected) {
    const head = environment.deployedRevisions.AchillesIDE.head;
    if (!/^[0-9a-f]{7,40}$/i.test(expected) || !head.toLowerCase().startsWith(expected.toLowerCase())) {
      throw new Error(`The deployed AchillesIDE HEAD ${head} does not match SMOKE_EXPECT_EXPLORER_COMMIT ${expected}.`);
    }
  }
  return environment;
}

// Removes a run-owned project directory: only a directory directly under the workspace root whose name starts with one of the run prefixes.
export function removeRunDirectory({ workspaceRoot, name, prefixes = ['e2e-flow-', 'e2e-late-', 'e2e-restart-'] }) {
  if (!prefixes.some((prefix) => name.startsWith(prefix)) || name.includes('/') || name.includes('..')) throw new Error(`Refusing to remove ${name}.`);
  const target = path.join(workspaceRoot, name);
  if (path.dirname(target) !== workspaceRoot) throw new Error(`Refusing to remove ${target}.`);
  fs.rmSync(target, { recursive: true, force: true });
}
