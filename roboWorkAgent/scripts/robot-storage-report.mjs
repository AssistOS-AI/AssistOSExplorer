#!/usr/bin/env node
// Read-only report of what RoboWork keeps on disk, per robot and per tool bundle. Node built-ins only and a single file, so it
// can be copied into a deployment that does not contain it (the classification below mirrors server/opencode-plugin-retire.mjs;
// storage-scripts.test.mjs requires the two to agree).
//
//   node robot-storage-report.mjs --data-dir /root --robots-dir /robots [--json]
//
// It follows no link: every path segment below the two given directories is checked with lstat, and the only files it reads
// are `state.json` and `snapshot.json` of a migration journal, a tool `stamp.json` and `current.json`, and in each home
// `.config/opencode/package.json`, `package-lock.json`, `opencode.json` and `opencode.jsonc`, each bounded to 4 MiB. Anything
// else is measured with lstat or listed by name only, and nothing is written.

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 4 * 1024 * 1024;
const MIGRATION_ID = 'opencode-v2-1';
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const GENERATION = /^[0-9a-f]{64}$/u;
const PLUGIN_PACKAGES = ['@opencode/plugin', '@opencode-ai/plugin'];
const OWN_PLUGIN_FILES = new Set(['soul-gateway.js']);
const SECTIONS = ['devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function lstatOrNull(file) {
    try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// The path below `base` reached through real directories only. `null`: a segment is missing; `{ unsafe }`: a link or a file is in the way.
async function realPath(base, ...segments) {
    let current = base;
    for (const segment of segments.flatMap(entry => entry.split('/'))) {
        current = path.join(current, segment);
        const stat = await lstatOrNull(current);
        if (!stat) return null;
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { unsafe: current };
    }
    return current;
}

// A regular file, never through a link, with one name and at most 4 MiB.
async function readFile(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) return { unsafe: true };
        return { text: await handle.readFile('utf8') };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true };
        if (['ELOOP', 'EISDIR'].includes(error.code)) return { unsafe: true };
        throw error;
    } finally { await handle?.close(); }
}

async function readJson(file) {
    const result = await readFile(file);
    if (result.text === undefined) return result;
    try { return { value: JSON.parse(result.text) }; } catch { return { invalid: true }; }
}

const typeOf = async file => {
    const stat = await lstatOrNull(file);
    if (!stat) return 'missing';
    if (stat.isSymbolicLink()) return 'link';
    if (stat.isDirectory()) return 'directory';
    return stat.isFile() ? 'file' : 'special';
};

// Apparent bytes below a path, counted without following a link. `null` when the path is missing or not reachable safely.
async function bytesBelow(base, relative) {
    const target = await realPath(base, relative);
    if (!target || target.unsafe) return null;
    const walk = async directory => {
        let total = 0;
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            const stat = await fs.lstat(file);
            total += stat.isDirectory() ? stat.size + await walk(file) : stat.size;
        }
        return total;
    };
    return walk(target);
}

// ---- classification of `<home>/.config/opencode`: the same rules as server/opencode-plugin-retire.mjs ----

function parseJsonc(raw) {
    const text = raw.replace(/^﻿/u, '');
    let stripped = '';
    let inString = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            stripped += char;
            if (char === '\\') stripped += text[++index] ?? '';
            else if (char === '"') inString = false;
        } else if (char === '"') { inString = true; stripped += char; }
        else if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; stripped += '\n'; }
        else if (char === '/' && text[index + 1] === '*') {
            const end = text.indexOf('*/', index + 2);
            if (end < 0) return null;
            index = end + 1;
            stripped += ' ';
        } else stripped += char;
    }
    let result = '';
    inString = false;
    for (let index = 0; index < stripped.length; index++) {
        const char = stripped[index];
        if (inString) {
            result += char;
            if (char === '\\') result += stripped[++index] ?? '';
            else if (char === '"') inString = false;
        } else if (char === '"') { inString = true; result += char; }
        else if (char === ',' && /^\s*[}\]]/u.test(stripped.slice(index + 1))) continue;
        else result += char;
    }
    try { return JSON.parse(result); } catch { return null; }
}

async function classify(home) {
    const homeType = await typeOf(home);
    if (homeType === 'missing') return { status: 'absent', entries: {} };
    if (homeType !== 'directory') return { status: 'unsafe', reason: 'home is not a directory', entries: {} };
    const base = await realPath(home, '.config/opencode');
    if (base === null) return { status: 'absent', entries: {} };
    if (base.unsafe) return { status: 'unsafe', reason: 'configuration path is a link', entries: {} };
    const entries = {};
    for (const name of ['plugin', 'plugins']) {
        const type = await typeOf(path.join(base, name));
        if (type === 'directory') entries[name] = (await fs.readdir(path.join(base, name))).filter(entry => !OWN_PLUGIN_FILES.has(entry)).sort();
    }
    const result = (status, reason) => ({ status, ...(reason ? { reason } : {}), entries });
    const [modules, manifestType, lockType] = await Promise.all(['node_modules', 'package.json', 'package-lock.json'].map(name => typeOf(path.join(base, name))));
    if ([modules, manifestType, lockType].some(type => type === 'link' || type === 'special')
        || modules === 'file' || manifestType === 'directory' || lockType === 'directory') return result('unsafe', 'link or special entry');
    if (modules === 'missing' && manifestType === 'missing' && lockType === 'missing') return result('absent');
    const [manifest, lock] = await Promise.all([readJson(path.join(base, 'package.json')), readJson(path.join(base, 'package-lock.json'))]);
    if (manifest.unsafe || lock.unsafe) return result('unsafe', 'file is shared or too large');
    if (manifest.missing || manifest.invalid || lock.invalid) return result('customized', 'manifest or lock is missing or unreadable');
    const value = manifest.value;
    const names = isRecord(value) && Object.keys(value).length === 1 && isRecord(value.dependencies) ? Object.keys(value.dependencies) : [];
    const dependency = names.length === 1 && PLUGIN_PACKAGES.includes(names[0]) && typeof value.dependencies[names[0]] === 'string'
        && value.dependencies[names[0]] ? names[0] : null;
    if (!dependency) return result('customized', 'manifest is not the plugin-only manifest');
    if (!lock.missing) {
        const root = lock.value?.packages?.[''];
        const dependencies = isRecord(root) ? root.dependencies ?? {} : null;
        if (!isRecord(dependencies) || Object.keys(dependencies).some(name => name !== dependency)
            || !SECTIONS.every(section => root[section] === undefined || (isRecord(root[section]) && Object.keys(root[section]).length === 0))) {
            return result('customized', 'lock lists other dependencies');
        }
    }
    for (const name of ['plugin', 'plugins']) {
        const type = await typeOf(path.join(base, name));
        if (type === 'missing') continue;
        if (type !== 'directory') return result('unsafe', `${name} is not a directory`);
        for (const entry of await fs.readdir(path.join(base, name))) {
            if (!OWN_PLUGIN_FILES.has(entry)) return result('authored', `${name} holds another entry`);
            if (await typeOf(path.join(base, name, entry)) !== 'file') return result('unsafe', `${name}/${entry} is not a file`);
        }
    }
    for (const name of ['opencode.json', 'opencode.jsonc']) {
        const document = await readFile(path.join(base, name));
        if (document.missing) continue;
        if (document.unsafe) return result('authored', `${name} cannot be read safely`);
        const parsed = parseJsonc(document.text);
        if (!isRecord(parsed)) return result('authored', `${name} is not a readable object`);
        if (Object.hasOwn(parsed, 'plugin') || Object.hasOwn(parsed, 'plugins')) return result('authored', `${name} configures a plugin`);
    }
    return result('managed');
}

// ---- the report ----

async function freeBytes(directory) {
    const stat = await fs.statfs(directory);
    return stat.bavail * stat.bsize;
}

async function journalOf(migrations, id) {
    const directory = await realPath(migrations, id);
    if (directory === null) return { journal: null, snapshotRecord: null, directory: null };
    if (directory.unsafe) return { journal: { unsafe: true }, snapshotRecord: null, directory: null };
    const state = await readJson(path.join(directory, 'state.json'));
    const record = await readJson(path.join(directory, 'snapshot.json'));
    const journal = state.value ? { migration: state.value.migration, phase: state.value.phase,
        ...(Number.isInteger(state.value.sessions) ? { sessions: state.value.sessions } : {}), ...(state.value.error ? { error: 'recorded' } : {}) }
        : state.missing ? null : { unreadable: true };
    const snapshotRecord = record.value ? { excluded: Array.isArray(record.value.excluded) ? record.value.excluded : [],
        sessions: Array.isArray(record.value.before?.sessions) ? record.value.before.sessions.length : null } : null;
    return { journal, snapshotRecord, directory };
}

async function robotReport(robotsDir, migrations, id) {
    const robot = await realPath(robotsDir, id);
    const labelled = robot && !robot.unsafe && (await typeOf(path.join(robot, 'label'))) === 'file';
    if (!labelled) return { id, labelled: false };
    const home = path.join(robot, 'home');
    const { journal, snapshotRecord, directory } = await journalOf(migrations, id);
    const homeBytes = await bytesBelow(robot, 'home');
    const snapshot = directory ? await bytesBelow(directory, 'snapshot') : null;
    return {
        id, labelled: true,
        journal,
        disposition: await classify(home),
        bytes: {
            home: homeBytes,
            configPluginTree: await bytesBelow(home, '.config/opencode/node_modules'),
            projectPluginTree: await bytesBelow(home, '.opencode/node_modules'),
            cache: await bytesBelow(home, '.cache'),
            npm: await bytesBelow(home, '.npm'),
        },
        snapshot: snapshot === null ? null : { bytes: snapshot, pluginTreeBytes: await bytesBelow(directory, 'snapshot/.config/opencode/node_modules'),
            ...(snapshotRecord ?? {}) },
    };
}

// Which rule keeps a generation: `current` (a descriptor names it), `view` (a shell view or a kept shell generation links to it),
// `retired` (a bundle nothing prepares now), or `none` (collected at the next start unless a stored terminal descriptor names it;
// those descriptors are not read here).
async function toolCacheReport(cacheRoot) {
    const root = await realPath(path.dirname(cacheRoot), path.basename(cacheRoot));
    if (!root || root.unsafe) return { bundles: {}, unreachable: true };
    const entries = await fs.readdir(root, { withFileTypes: true });
    const reached = new Set();
    const note = target => {
        const parts = path.relative(root, target).split(path.sep);
        if (parts[0] === 'shell-generations' && GENERATION.test(parts[1] || '')) reached.add(`shell-generations/${parts[1]}`);
        else if (parts[1] === 'generations' && GENERATION.test(parts[2] || '')) reached.add(`${parts[0]}/${parts[2]}`);
    };
    const views = entries.filter(entry => entry.isSymbolicLink() && (entry.name === 'shell' || entry.name.startsWith('shell-'))).map(entry => path.join(root, entry.name));
    const selections = await realPath(root, 'shell-selections');
    if (selections && !selections.unsafe) {
        for (const entry of await fs.readdir(selections, { withFileTypes: true })) if (entry.isSymbolicLink() && !entry.name.startsWith('.')) views.push(path.join(selections, entry.name));
    }
    for (const view of views) {
        const target = path.resolve(path.dirname(view), await fs.readlink(view));
        note(target);
        const parts = path.relative(root, target).split(path.sep);
        if (parts[0] === 'shell-generations' && GENERATION.test(parts[1] || '')) {
            const bin = await realPath(root, `shell-generations/${parts[1]}/bin`);
            if (bin && !bin.unsafe) {
                for (const link of await fs.readdir(bin, { withFileTypes: true })) {
                    if (link.isSymbolicLink()) note(path.resolve(bin, await fs.readlink(path.join(bin, link.name))));
                }
            }
        }
    }
    const bundles = {};
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const generationsDirectory = entry.name === 'shell-generations' ? await realPath(root, entry.name) : await realPath(root, `${entry.name}/generations`);
        if (!generationsDirectory || generationsDirectory.unsafe) continue;
        const descriptor = entry.name === 'shell-generations' ? {} : await readJson(path.join(root, entry.name, 'current.json'));
        const generations = [];
        for (const generation of (await fs.readdir(generationsDirectory, { withFileTypes: true })).filter(item => item.isDirectory() && GENERATION.test(item.name))) {
            const stamp = entry.name === 'shell-generations' ? {} : await readJson(path.join(generationsDirectory, generation.name, 'stamp.json'));
            const keptBy = entry.name === 'opencode-plugin' ? 'retired'
                : descriptor.value?.generation === generation.name ? 'current'
                : reached.has(`${entry.name}/${generation.name}`) ? 'view' : 'none';
            generations.push({ generation: generation.name, bytes: await bytesBelow(generationsDirectory, generation.name),
                version: stamp.value?.versions ? Object.values(stamp.value.versions)[0] ?? null : null, keptBy });
        }
        bundles[entry.name] = { current: descriptor.value?.generation ?? null, generations: generations.sort((a, b) => a.generation.localeCompare(b.generation)) };
    }
    return { bundles };
}

export async function storageReport({ dataDir, robotsDir }) {
    const migrations = path.join(dataDir, 'server-state', 'migrations', MIGRATION_ID);
    const robots = [];
    for (const entry of (await fs.readdir(robotsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || !entry.isDirectory() || !ROBOT_ID.test(entry.name)) continue;
        robots.push(await robotReport(robotsDir, migrations, entry.name));
    }
    const labelled = new Set(robots.filter(robot => robot.labelled).map(robot => robot.id));
    const migrationDirectory = await realPath(path.dirname(migrations), path.basename(migrations));
    const unlabelledBackups = !migrationDirectory || migrationDirectory.unsafe ? []
        : (await fs.readdir(migrationDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
            && ROBOT_ID.test(entry.name) && !labelled.has(entry.name)).map(entry => entry.name).sort();
    return {
        dataDir, robotsDir,
        freeBytes: { dataDir: await freeBytes(dataDir), robotsDir: await freeBytes(robotsDir) },
        robots, unlabelledBackups,
        toolCache: await toolCacheReport(path.join(dataDir, 'tool-cache')),
    };
}

const size = bytes => (bytes === null || bytes === undefined ? '-' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)}G` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)}M` : `${bytes}`);

function render(report) {
    const lines = [`free: data ${size(report.freeBytes.dataDir)}  robots ${size(report.freeBytes.robotsDir)}`, '',
        'robot\tjournal\tdisposition\thome\tconfig-tree\tproject-tree\t.cache\t.npm\tsnapshot\tsnapshot-tree\tother plugin entries'];
    for (const robot of report.robots) {
        if (!robot.labelled) { lines.push(`${robot.id}\t(no label)`); continue; }
        const others = Object.entries(robot.disposition.entries).flatMap(([directory, names]) => names.map(name => `${directory}/${name}`)).join(',') || '-';
        lines.push([robot.id, robot.journal?.phase ?? (robot.journal ? 'unreadable' : 'none'), robot.disposition.status, size(robot.bytes.home),
            size(robot.bytes.configPluginTree), size(robot.bytes.projectPluginTree), size(robot.bytes.cache), size(robot.bytes.npm),
            size(robot.snapshot?.bytes), size(robot.snapshot?.pluginTreeBytes), others].join('\t'));
    }
    if (report.unlabelledBackups.length) lines.push('', `backups of robots without a label (never deleted by the prune script): ${report.unlabelledBackups.join(', ')}`);
    lines.push('', 'tool bundle\tgeneration\tversion\tbytes\tkept by');
    for (const [name, bundle] of Object.entries(report.toolCache.bundles)) {
        for (const generation of bundle.generations) lines.push([name, generation.generation.slice(0, 12), generation.version ?? '-', size(generation.bytes), generation.keptBy].join('\t'));
    }
    return lines.join('\n');
}

function parseArguments(argv) {
    const options = { json: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--json') options.json = true;
        else if (argument === '--data-dir' || argument === '--robots-dir') {
            const value = argv[++index];
            if (!value || !path.isAbsolute(value)) throw new Error(`${argument} needs an absolute path`);
            options[argument === '--data-dir' ? 'dataDir' : 'robotsDir'] = path.resolve(value);
        } else throw new Error(`unknown argument ${argument}`);
    }
    if (!options.dataDir || !options.robotsDir) throw new Error('usage: robot-storage-report.mjs --data-dir <dir> --robots-dir <dir> [--json]');
    return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const options = parseArguments(process.argv.slice(2));
        const report = await storageReport(options);
        process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
    } catch (error) {
        process.stderr.write(`robot-storage-report: ${error.message}\n`);
        process.exitCode = 2;
    }
}
