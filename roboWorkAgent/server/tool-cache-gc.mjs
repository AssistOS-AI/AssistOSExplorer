import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Startup-only garbage collection of the tool cache (`/root/tool-cache`). It runs once, after leftover runs are killed and
// GUI containers are removed and before the service listens, so no live consumer of a generation can exist. Superseded
// generations are renamed into `<root>/.trash/<uuid>` (a metadata-only step that precedes `listen`) and deleted afterwards
// by the returned cleanup. Whenever a reference is unreadable or unexpected the whole pass is skipped: when unsure, keep.

const GENERATION = /^[0-9a-f]{64}$/u;
const GENERATION_LOCK = /^([0-9a-f]{64})\.lock$/u;
const CURRENT_TEMPORARY = /^current\.json\..+\.tmp$/u;
const TRASH = '.trash';
const SHELL_GENERATIONS = 'shell-generations';
const SHELL_SELECTIONS = 'shell-selections';
const DESCRIPTOR_LIMIT = 32768;

async function lstatOrNull(target) {
    try { return await fs.lstat(target); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

// A missing directory is null; a link or a non-directory is never followed and skips the pass.
async function realDirectoryOrNull(target, label) {
    const stat = await lstatOrNull(target);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a real directory`);
    return stat;
}

async function readEntries(directory) {
    try { return await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

// undefined: the file is missing; null: it is not a JSON object; any other read error throws.
async function readJson(file) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
}

// The bundle and generation a path lies in, or null for any other path. Links are resolved lexically, never by realpath.
function generationOf(root, target, names) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    if (parts[0] === SHELL_GENERATIONS && GENERATION.test(parts[1] || '')) return { bundle: SHELL_GENERATIONS, generation: parts[1] };
    if (names.has(parts[0]) && parts[1] === 'generations' && GENERATION.test(parts[2] || '')) return { bundle: parts[0], generation: parts[2] };
    return null;
}

async function linkTarget(link) {
    return path.resolve(path.dirname(link), await fs.readlink(link));
}

const sizeOf = (map, key) => map.get(key)?.size || 0;

// Selects what to remove. Throws on any unreadable or unexpected reference; changes nothing on disk.
export async function planCollection({ root: rawRoot, bundles, retiredBundles = [], keepBundles = [], cacheSchema, terminalPaths = [], now, leftoverMs }) {
    const root = path.resolve(rawRoot);
    const plan = { remove: [], leftovers: [], retained: 0 };
    if (!await realDirectoryOrNull(root, 'tool cache root')) return plan;
    await realDirectoryOrNull(path.join(root, TRASH), 'tool cache trash');
    const bundleNames = [...bundles, ...retiredBundles];
    const retired = new Set(retiredBundles);
    const names = new Set(bundleNames);
    const candidates = new Map();
    const keep = new Map();
    // `keepBundles`: the caller could not secure something that lives only in these bundles, so every generation stays.
    const keepAll = new Set(keepBundles);
    const current = new Map();
    const leftover = (target) => plan.leftovers.push(target);
    const retain = (bundle, generation, into = keep) => {
        // A retired bundle has no keep rule: nothing prepares it, so nothing may hold one of its generations.
        if (!retired.has(bundle) && candidates.get(bundle)?.has(generation)) (into.get(bundle) || into.set(bundle, new Set()).get(bundle)).add(generation);
    };
    const isOld = async (target) => {
        const stat = await lstatOrNull(target);
        return Boolean(stat) && now - stat.mtimeMs >= leftoverMs;
    };

    // Candidates, abandoned staging and temporary files of every bundle and of the shell generations.
    for (const bundle of [...bundleNames, SHELL_GENERATIONS]) {
        const bundleDirectory = path.join(root, bundle);
        if (!await realDirectoryOrNull(bundleDirectory, `bundle ${bundle}`)) continue;
        const generationsDirectory = bundle === SHELL_GENERATIONS ? bundleDirectory : path.join(bundleDirectory, 'generations');
        const found = new Set();
        candidates.set(bundle, found);
        if (await realDirectoryOrNull(generationsDirectory, `generations of ${bundle}`)) {
            for (const entry of await readEntries(generationsDirectory)) {
                if (GENERATION.test(entry.name) && entry.isDirectory()) found.add(entry.name);
                else if (entry.name.startsWith('.staging-') && await isOld(path.join(generationsDirectory, entry.name))) leftover(path.join(generationsDirectory, entry.name));
                else if (GENERATION_LOCK.test(entry.name)) {
                    const lock = path.join(generationsDirectory, entry.name);
                    const stat = await lstatOrNull(lock);
                    if (!stat) continue;
                    // K4b: a fresh lock belongs to an installation that may still be unstamped; its target stays.
                    if (now - stat.mtimeMs < leftoverMs) keep.set(bundle, (keep.get(bundle) || new Set()).add(entry.name.slice(0, -'.lock'.length)));
                    else leftover(lock);
                }
            }
        }
        if (bundle === SHELL_GENERATIONS) continue;
        if (await realDirectoryOrNull(path.join(bundleDirectory, 'staging'), `staging of ${bundle}`)) {
            for (const entry of await readEntries(path.join(bundleDirectory, 'staging'))) {
                if (await isOld(path.join(bundleDirectory, 'staging', entry.name))) leftover(path.join(bundleDirectory, 'staging', entry.name));
            }
        }
        for (const entry of await readEntries(bundleDirectory)) {
            if (CURRENT_TEMPORARY.test(entry.name) && await isOld(path.join(bundleDirectory, entry.name))) leftover(path.join(bundleDirectory, entry.name));
        }
    }
    for (const entry of await readEntries(root)) {
        if ((entry.name.startsWith('.shell-') || entry.name.startsWith('.npm-')) && await isOld(path.join(root, entry.name))) leftover(path.join(root, entry.name));
    }
    const selections = path.join(root, SHELL_SELECTIONS);
    const selectionEntries = await realDirectoryOrNull(selections, SHELL_SELECTIONS) ? await readEntries(selections) : [];
    for (const entry of selectionEntries) {
        if (entry.name.startsWith('.shell-') && await isOld(path.join(selections, entry.name))) leftover(path.join(selections, entry.name));
    }

    // K1: the generation current.json names. A missing, invalid or dangling descriptor keeps the whole bundle.
    for (const bundle of bundles) {
        if (!candidates.has(bundle)) continue;
        const descriptor = await readJson(path.join(root, bundle, 'current.json'));
        const valid = descriptor?.schema === cacheSchema && descriptor.name === bundle && GENERATION.test(descriptor.generation || '')
            && candidates.get(bundle).has(descriptor.generation);
        if (!valid) { keepAll.add(bundle); continue; }
        retain(bundle, descriptor.generation);
        retain(bundle, descriptor.generation, current);
    }

    // K2: shell views, and the agent generations that a kept shell generation links to through bin/*.
    const views = [];
    for (const entry of await readEntries(root)) {
        if (entry.isSymbolicLink() && (entry.name === 'shell' || entry.name.startsWith('shell-'))) views.push(path.join(root, entry.name));
    }
    for (const entry of selectionEntries) {
        if (entry.isSymbolicLink() && !entry.name.startsWith('.')) views.push(path.join(selections, entry.name));
    }
    const keptShells = new Set();
    for (const view of views) {
        const reached = generationOf(root, await linkTarget(view), names);
        if (reached?.bundle === SHELL_GENERATIONS && candidates.get(SHELL_GENERATIONS)?.has(reached.generation)) keptShells.add(reached.generation);
    }
    for (const shell of keptShells) {
        retain(SHELL_GENERATIONS, shell);
        const binDirectory = path.join(root, SHELL_GENERATIONS, shell, 'bin');
        let links;
        try { links = await fs.readdir(binDirectory, { withFileTypes: true }); } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
            throw error;
        }
        for (const link of links) {
            if (!link.isSymbolicLink()) continue;
            const reached = generationOf(root, await linkTarget(path.join(binDirectory, link.name)), names);
            if (reached && reached.bundle !== SHELL_GENERATIONS) retain(reached.bundle, reached.generation);
        }
    }

    // K4: generations a stored terminal descriptor names.
    for (const target of terminalPaths) {
        if (typeof target !== 'string' || !path.isAbsolute(target)) continue;
        const reached = generationOf(root, path.resolve(target), names);
        if (reached) retain(reached.bundle, reached.generation);
    }

    for (const [bundle, found] of candidates) {
        if (keepAll.has(bundle)) { plan.retained += found.size - sizeOf(current, bundle); continue; }
        for (const generation of [...found].sort()) {
            if (keep.get(bundle)?.has(generation)) { if (!current.get(bundle)?.has(generation)) plan.retained += 1; continue; }
            plan.remove.push(path.join(root, bundle === SHELL_GENERATIONS ? SHELL_GENERATIONS : path.join(bundle, 'generations'), generation));
        }
    }
    return plan;
}

// The ALA and bwrap paths of every stored terminal descriptor (`<state>/*.json`). A missing directory is empty and an
// unparseable or oversized file is ignored; any other read error throws.
export async function terminalDescriptorPaths(stateRoot) {
    const paths = [];
    for (const entry of await readEntries(stateRoot)) {
        if (entry.name.startsWith('.') || !entry.name.endsWith('.json') || !entry.isFile()) continue;
        const file = path.join(stateRoot, entry.name);
        const stat = await lstatOrNull(file);
        if (!stat || stat.size > DESCRIPTOR_LIMIT) continue;
        const descriptor = await readJson(file);
        for (const field of ['alaEntry', 'bwrap']) if (typeof descriptor?.[field] === 'string') paths.push(descriptor[field]);
    }
    return paths;
}

async function removeLegacyNpmCache(root, legacyNpmCache, log) {
    const legacy = path.resolve(legacyNpmCache);
    const relative = path.relative(legacy, root);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
    const stat = await lstatOrNull(legacy);
    // Only a real directory: never a link or a file, and never through a link.
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    await fs.rm(legacy, { recursive: true, force: true });
    log('[tool-cache] removed legacy npm cache');
}

async function emptyTrash(root, trash, log) {
    const rootStat = await lstatOrNull(root);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) { log('[tool-cache] root is not a real directory; trash left untouched'); return; }
    const stat = await lstatOrNull(trash);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) { log('[tool-cache] trash is not a real directory; left untouched'); return; }
    for (const entry of await readEntries(trash)) {
        try { await fs.rm(path.join(trash, entry.name), { recursive: true, force: true }); } catch (error) {
            log(`[tool-cache] could not delete a trashed entry: ${error?.code || error?.message}`);
        }
    }
}

// Plans and renames; resolves with the cleanup that deletes the trash and the legacy npm cache. Never rejects: a failure
// is logged, and the cleanup it returns never rejects either.
export async function collectToolCache({ root: rawRoot, bundles, retiredBundles, keepBundles, cacheSchema, terminalStateDir, legacyNpmCache = null,
    now, leftoverMs, log = () => {} }) {
    const root = path.resolve(rawRoot);
    const trash = path.join(root, TRASH);
    try {
        const terminalPaths = terminalStateDir ? await terminalDescriptorPaths(terminalStateDir) : [];
        const plan = await planCollection({ root, bundles, retiredBundles, keepBundles, cacheSchema, terminalPaths, now, leftoverMs });
        const victims = [...plan.remove.map(target => ({ target, generation: true })), ...plan.leftovers.map(target => ({ target, generation: false }))];
        if (victims.length) {
            await fs.mkdir(trash, { recursive: true, mode: 0o700 });
            await realDirectoryOrNull(trash, 'tool cache trash');
        }
        for (const { target, generation } of victims) {
            const relative = path.relative(root, target);
            try {
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.startsWith(TRASH + path.sep)) throw new Error('outside the cache');
                const stat = await fs.lstat(target);
                if (generation && (!stat.isDirectory() || !GENERATION.test(path.basename(target)))) throw new Error('not a generation directory');
                await fs.rename(target, path.join(trash, randomUUID()));
                log(generation
                    ? `[tool-cache] removed ${relative.split(path.sep)[0]} generation ${path.basename(target).slice(0, 12)}`
                    : `[tool-cache] removed abandoned ${relative}`);
            } catch (error) {
                log(`[tool-cache] could not remove ${relative}: ${error?.code || error?.message}`);
            }
        }
        if (plan.retained) log(`[tool-cache] kept ${plan.retained} superseded generations in use`);
    } catch (error) {
        log(`[tool-cache] garbage collection skipped: ${error?.code || error?.message}`);
    }
    let cleaning;
    return {
        cleanup() {
            cleaning ||= (async () => {
                try { await emptyTrash(root, trash, log); } catch (error) { log(`[tool-cache] trash cleanup failed: ${error?.code || error?.message}`); }
                if (legacyNpmCache) {
                    try { await removeLegacyNpmCache(root, legacyNpmCache, log); } catch (error) {
                        log(`[tool-cache] legacy npm cache removal failed: ${error?.code || error?.message}`);
                    }
                }
            })();
            return cleaning;
        },
    };
}
