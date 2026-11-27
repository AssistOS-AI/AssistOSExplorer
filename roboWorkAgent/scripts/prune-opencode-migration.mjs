#!/usr/bin/env node
// Operator removal of what the OpenCode migration keeps for rollback. Nothing here runs automatically: Daniel decides when the
// migration is verified. Without --apply it prints the plan and changes nothing; that plan is advisory, because a dry run does
// not hold the migration lock and a RoboWork start can change what it lists.
//
//   node prune-opencode-migration.mjs --data-dir /root --robots-dir /robots [--apply]
//        [--plugin-trees] [--snapshots] [--v1-tools] [--normalize-v1-tools]
//
//   --plugin-trees        per robot, remove its snapshot's `.config/opencode/node_modules`, only when that robot's journal is complete,
//                         its `snapshot.json` reads as a plain JSON object, and the snapshot manifest and lock classify as `managed`
//                         (the retire module's rules); records the exclusion in `snapshot.json` and keeps every other field. A robot
//                         that does not qualify is skipped with its reason and left byte-identical
//   --snapshots           remove every labelled robot's snapshot directory; keeps `state.json` and `snapshot.json`, so a completed
//                         robot is never migrated again. Refused unless at least one robot is labelled and every labelled robot's
//                         journal is complete
//   --v1-tools            remove the whole retained V1 OpenCode backup (`v1-tool-cache`, including any OpenCode 2 generation an
//                         earlier whole-bundle copy left there). Same refusal as --snapshots
//   --normalize-v1-tools  delete nothing: rewrite the backup `current.json` to name the V1 generation the backup holds, after
//                         checking that generation's stamp and contents. Ignored with --v1-tools
//
// Backup directories of robots without a label are listed and never deleted. With --apply the script holds the migration's
// kernel lock for the whole run (the command named by ROBOWORK_FLOCK, `flock` by default) and refuses while another process
// holds it. Do not start or deploy RoboWork while --apply runs: the service waits for the lock for up to ten minutes and then
// treats a held lock as a failure of the whole pass, and a prune that overlaps a start could remove what the start needs. Every
// path segment below the two given directories is checked with lstat and no link is followed. `--plugin-trees` imports the
// classification from ../server/opencode-plugin-retire.mjs, or from a copy of that file beside this script.

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATION_ID = 'opencode-v2-1';
const MAX_BYTES = 4 * 1024 * 1024;
// The service writes `state.json` and `snapshot.json` without a bound and robots cannot write them, so they get a far larger one
// (a record of 40,000 messages is about 5 MB). They are still opened without following a link and must have one name.
const JOURNAL_LIMIT = 256 * 1024 * 1024;
const JOURNAL_FILES = new Set(['state.json', 'snapshot.json']);
// Entries of the migration directory that are not robot backups.
const NOT_ROBOT_BACKUPS = new Set(['v1-tool-cache', 'partial', 'generations']);
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const GENERATION = /^[0-9a-f]{64}$/u;
const TREE = '.config/opencode/node_modules';
const FLAGS = ['--apply', '--plugin-trees', '--snapshots', '--v1-tools', '--normalize-v1-tools'];

const lstatOrNull = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });

// Real directories only, below `base`. `null`: a segment is missing; throws when a link or a file is in the way.
async function realPath(base, ...segments) {
    let current = base;
    for (const segment of segments.flatMap(entry => entry.split('/'))) {
        current = path.join(current, segment);
        const stat = await lstatOrNull(current);
        if (!stat) return null;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing to follow a link or a file at ${current}`);
    }
    return current;
}

async function readJson(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > (JOURNAL_FILES.has(path.basename(file)) ? JOURNAL_LIMIT : MAX_BYTES)) return { unsafe: true };
        try { return { value: JSON.parse(await handle.readFile('utf8')) }; } catch { return { invalid: true }; }
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true };
        if (['ELOOP', 'EISDIR'].includes(error.code)) return { unsafe: true };
        throw error;
    } finally { await handle?.close(); }
}

async function bytesBelow(directory) {
    let total = 0;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    for (const entry of entries) {
        const stat = await lstatOrNull(path.join(directory, entry.name));
        if (stat) total += stat.isDirectory() ? stat.size + await bytesBelow(path.join(directory, entry.name)) : stat.size;
    }
    return total;
}

// The kernel lock the migration holds, taken without waiting; `release()` frees it.
async function acquireLock(file) {
    const child = spawn(process.env.ROBOWORK_FLOCK || 'flock', ['--exclusive', '--nonblock', file, 'cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        child.once('error', error => reject(error.code === 'ENOENT' ? new Error('flock is not available; install util-linux or set ROBOWORK_FLOCK') : error));
        child.once('exit', () => reject(new Error('migration.lock is held: the service or another operator is migrating; try again after it ends')));
        child.stdout.once('data', resolve);
        child.stdin.on('error', reject);
        child.stdin.write('locked\n');
    }).catch(error => { child.stdin.destroy(); child.kill(); throw error; });
    return () => child.stdin.end();
}

function parseArguments(argv) {
    const options = { apply: false, pluginTrees: false, snapshots: false, v1Tools: false, normalizeV1Tools: false };
    const names = { '--apply': 'apply', '--plugin-trees': 'pluginTrees', '--snapshots': 'snapshots', '--v1-tools': 'v1Tools', '--normalize-v1-tools': 'normalizeV1Tools' };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (FLAGS.includes(argument)) options[names[argument]] = true;
        else if (argument === '--data-dir' || argument === '--robots-dir') {
            const value = argv[++index];
            if (!value || !path.isAbsolute(value)) throw new Error(`${argument} needs an absolute path`);
            options[argument === '--data-dir' ? 'dataDir' : 'robotsDir'] = path.resolve(value);
        } else throw new Error(`unknown argument ${argument}`);
    }
    if (!options.dataDir || !options.robotsDir) throw new Error(`usage: prune-opencode-migration.mjs --data-dir <dir> --robots-dir <dir> [${FLAGS.join('] [')}]`);
    return options;
}

async function loadClassifier() {
    for (const location of ['../server/opencode-plugin-retire.mjs', './opencode-plugin-retire.mjs']) {
        try { return await import(new URL(location, import.meta.url).href); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
    }
    throw new Error('opencode-plugin-retire.mjs not found beside the script or in ../server');
}

// Every labelled robot, its journal and its snapshot record, and the backup directories that belong to no labelled robot.
async function inspect({ dataDir, robotsDir }, migrations) {
    const labelled = [];
    for (const entry of (await fs.readdir(robotsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink() || !ROBOT_ID.test(entry.name)) continue;
        const label = await lstatOrNull(path.join(robotsDir, entry.name, 'label'));
        if (label?.isFile() && !label.isSymbolicLink()) labelled.push(entry.name);
    }
    const robots = [];
    for (const id of labelled) {
        const directory = await realPath(migrations, id);
        const state = directory ? await readJson(path.join(directory, 'state.json')) : { missing: true };
        const record = directory ? await readJson(path.join(directory, 'snapshot.json')) : { missing: true };
        const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
        robots.push({ id, directory, state: plain(state.value) ? state.value : null, record: plain(record.value) ? record.value : null,
            recordProblem: record.missing ? 'missing' : record.unsafe ? 'over the size limit or not a plain file' : record.invalid ? 'not valid JSON' : plain(record.value) ? null : 'not a JSON object',
            complete: state.value?.migration === MIGRATION_ID && state.value?.phase === 'complete' });
    }
    const unlabelled = (await fs.readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
        && ROBOT_ID.test(entry.name) && !NOT_ROBOT_BACKUPS.has(entry.name) && !labelled.includes(entry.name)).map(entry => entry.name).sort();
    return { robots, unlabelled };
}

// The journals must prove that every robot finished migrating with all its sessions before a rollback copy goes.
function refusals(robots) {
    const problems = [];
    if (!robots.length) problems.push('no robot is labelled, so nothing proves the migration finished');
    for (const robot of robots) {
        if (!robot.complete) {
            const state = robot.state?.migration && robot.state.migration !== MIGRATION_ID ? 'for another migration' : robot.state?.phase ?? 'missing';
            problems.push(`robot=${robot.id} journal is ${state}, not complete`);
            continue;
        }
        const expected = robot.record?.before?.sessions;
        if (!Array.isArray(expected) || !Number.isInteger(robot.state.sessions) || robot.state.sessions < expected.length) {
            problems.push(`robot=${robot.id} has ${robot.state.sessions ?? 'no'} sessions against ${Array.isArray(expected) ? expected.length : 'an unknown number'} in its snapshot`);
        }
    }
    return problems;
}

async function v1Generations(backup) {
    const generations = await realPath(backup, 'generations');
    const found = { v1: [], v2: [], unknown: [] };
    if (!generations) return { ...found, directory: null };
    for (const entry of await fs.readdir(generations, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !GENERATION.test(entry.name)) continue;
        const stamp = await readJson(path.join(generations, entry.name, 'stamp.json'));
        const version = stamp.value?.name === 'opencode' && stamp.value.generation === entry.name ? stamp.value.versions?.opencode : undefined;
        const major = typeof version === 'string' ? Number(version.split('.')[0]) : Number.NaN;
        if (major < 2) found.v1.push({ generation: entry.name, stamp: stamp.value });
        else if (major >= 2) found.v2.push(entry.name);
        else found.unknown.push(entry.name);
    }
    return { ...found, directory: generations };
}

async function writeAtomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
}

async function removeDirectory(parent, ...segments) {
    const target = await realPath(parent, ...segments);
    if (target) await fs.rm(target, { recursive: true, force: true });
}

export async function prune(options, log = line => process.stdout.write(`${line}\n`)) {
    const migrations = await realPath(options.dataDir, 'server-state', 'migrations', MIGRATION_ID);
    if (!migrations) throw new Error(`no migration directory under ${options.dataDir}`);
    // Only --apply holds the lock; a dry run changes nothing, so it neither contends with a RoboWork start nor creates the file.
    const release = options.apply ? await acquireLock(path.join(migrations, 'migration.lock')) : () => {};
    if (!options.apply) log('advisory: this dry run does not hold migration.lock');
    try {
        const { robots, unlabelled } = await inspect(options, migrations);
        if (unlabelled.length) log(`backups of robots without a label (listed, never deleted): ${unlabelled.join(', ')}`);
        const actions = [];
        const refused = [];
        const backup = await realPath(migrations, 'v1-tool-cache');

        if (options.pluginTrees) {
            const { pluginTreeDisposition } = await loadClassifier();
            for (const robot of robots) {
                const snapshot = robot.directory ? await realPath(robot.directory, 'snapshot') : null;
                if (!snapshot) { log(`skip plugin tree robot=${robot.id}: no snapshot`); continue; }
                if (!robot.complete) { log(`skip plugin tree robot=${robot.id}: journal is ${robot.state?.phase ?? 'missing'}`); continue; }
                if (robot.recordProblem) { log(`skip plugin tree robot=${robot.id}: snapshot.json is ${robot.recordProblem}; left untouched`); continue; }
                const disposition = await pluginTreeDisposition(snapshot);
                if (disposition.status !== 'managed') { log(`skip plugin tree robot=${robot.id}: snapshot is ${disposition.status}`); continue; }
                const excluded = Array.isArray(robot.record?.excluded) && robot.record.excluded.includes(TREE);
                if (!disposition.hasTree && excluded) { log(`skip plugin tree robot=${robot.id}: already removed`); continue; }
                const tree = path.join(snapshot, TREE);
                actions.push({ kind: 'plugin-tree', robot, snapshot, tree, hasTree: disposition.hasTree,
                    bytes: disposition.hasTree ? await bytesBelow(tree) : 0 });
            }
        }
        if (options.snapshots || options.v1Tools) {
            const problems = refusals(robots);
            if (problems.length) refused.push(...problems);
        }
        if (options.snapshots && !refused.length) {
            for (const robot of robots) {
                const snapshot = robot.directory ? await realPath(robot.directory, 'snapshot') : null;
                if (snapshot) actions.push({ kind: 'snapshot', robot, bytes: await bytesBelow(snapshot) });
            }
        }
        if (options.v1Tools && !refused.length && backup) actions.push({ kind: 'v1-tools', bytes: await bytesBelow(backup) });
        if (options.normalizeV1Tools && !options.v1Tools) {
            const held = backup ? await v1Generations(backup) : { v1: [], v2: [], unknown: [], directory: null };
            if (!held.v1.length) refused.push('no OpenCode 1 generation in the backup to name');
            else {
                const current = (await readJson(path.join(backup, 'current.json'))).value;
                const chosen = held.v1.find(entry => entry.generation === current?.generation)
                    ?? [...held.v1].sort((a, b) => (Date.parse(b.stamp.preparedAt) || 0) - (Date.parse(a.stamp.preparedAt) || 0) || (a.generation < b.generation ? 1 : -1))[0];
                // A stamp alone proves nothing: the generation must hold something besides it.
                const contents = (await fs.readdir(path.join(held.directory, chosen.generation))).filter(name => name !== 'stamp.json');
                if (!contents.length) refused.push(`generation ${chosen.generation.slice(0, 12)} in the backup holds only its stamp`);
                else actions.push({ kind: 'normalize', backup, chosen, others: [...held.v2, ...held.unknown], from: current?.generation ?? null });
            }
        }

        for (const problem of refused) log(`refused: ${problem}`);
        for (const action of actions) {
            if (action.kind === 'plugin-tree') log(`plan: ${action.hasTree ? `remove snapshot plugin tree robot=${action.robot.id} bytes=${action.bytes}` : `record the exclusion of the snapshot plugin tree robot=${action.robot.id}`}`);
            if (action.kind === 'snapshot') log(`plan: remove snapshot robot=${action.robot.id} bytes=${action.bytes}`);
            if (action.kind === 'v1-tools') log(`plan: remove v1-tool-cache bytes=${action.bytes}`);
            if (action.kind === 'normalize') {
                log(`plan: name generation ${action.chosen.generation.slice(0, 12)} in the backup current.json (now ${action.from ? action.from.slice(0, 12) : 'missing'})`);
                for (const generation of action.others) log(`keep: generation ${generation.slice(0, 12)} stays in the backup; --v1-tools removes the whole backup`);
            }
        }
        if (refused.length) { log('nothing was changed'); return { code: 1, actions: [] }; }
        if (!actions.length) { log('nothing to do'); return { code: 0, actions: [] }; }
        if (!options.apply) { log('dry run: nothing was changed; add --apply'); return { code: 0, actions }; }

        for (const action of actions) {
            if (action.kind === 'plugin-tree') {
                const { robot, snapshot } = action;
                // The record is read again and must still be a plain object before anything is removed; it is never replaced by `{}`.
                const recordFile = path.join(robot.directory, 'snapshot.json');
                const record = (await readJson(recordFile)).value;
                if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`snapshot.json of robot=${robot.id} is no longer a readable JSON object; nothing was removed for it`);
                if (action.hasTree) await removeDirectory(snapshot, '.config/opencode/node_modules');
                const excluded = new Set(Array.isArray(record.excluded) ? record.excluded : []);
                excluded.add(TREE);
                await writeAtomic(recordFile, { ...record, excluded: [...excluded], pluginTreePrunedAt: new Date().toISOString() });
                log(`removed: snapshot plugin tree robot=${robot.id}`);
            } else if (action.kind === 'snapshot') {
                await removeDirectory(action.robot.directory, 'snapshot');
                log(`removed: snapshot robot=${action.robot.id}`);
            } else if (action.kind === 'v1-tools') {
                await removeDirectory(migrations, 'v1-tool-cache');
                log('removed: v1-tool-cache');
            } else if (action.kind === 'normalize') {
                await writeAtomic(path.join(action.backup, 'current.json'), { schema: action.chosen.stamp.schema, name: 'opencode',
                    generation: action.chosen.generation, versions: action.chosen.stamp.versions });
                log(`normalized: backup current.json names ${action.chosen.generation.slice(0, 12)}`);
            }
        }
        return { code: 0, actions };
    } finally { release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.exitCode = (await prune(parseArguments(process.argv.slice(2)))).code;
    } catch (error) {
        process.stderr.write(`prune-opencode-migration: ${error.message}\n`);
        process.exitCode = 2;
    }
}
