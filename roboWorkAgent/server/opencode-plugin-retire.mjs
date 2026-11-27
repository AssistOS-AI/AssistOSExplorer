import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// OpenCode 2 gives its plugins `@opencode/plugin` and `effect` from its own executable and installs nothing into the
// configuration directory. The dependency tree that OpenCode 1 installed there (and that RoboWork once copied into every
// home) is dead weight, so startup removes it from homes where it is provably RoboWork's or OpenCode's own. Anything a
// person or a robot authored stays: when unsure, keep and report.

export const OPENCODE_PLUGIN_PACKAGES = Object.freeze(['@opencode/plugin', '@opencode-ai/plugin']);
export const OPENCODE_CONFIG = '.config/opencode';
const MAX_BYTES = 4 * 1024 * 1024;
const TREE_NAMES = Object.freeze(['node_modules', 'package.json', 'package-lock.json']);
const CONFIG_DOCUMENTS = Object.freeze(['opencode.json', 'opencode.jsonc']);
const PLUGIN_DIRECTORIES = Object.freeze(['plugin', 'plugins']);
const OWN_PLUGIN_FILES = new Set(['soul-gateway.js']);
const LEFTOVER = /^\.roboteam-(?:seed|stale)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEPENDENCY_SECTIONS = Object.freeze(['devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']);

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Reads a regular file without following a link; a robot home is writable by the sandbox.
export async function readRegularFile(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_BYTES) return { unsafe: true };
        return { text: await handle.readFile('utf8') };
    } catch (error) {
        if (error.code === 'ENOENT') return { missing: true };
        if (['ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code)) return { unsafe: true };
        throw error;
    } finally { await handle?.close(); }
}

async function readJson(file) {
    const result = await readRegularFile(file);
    if (result.text === undefined) return result;
    try { return { value: JSON.parse(result.text) }; } catch { return { invalid: true }; }
}

export async function entryType(file) {
    const metadata = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!metadata) return 'missing';
    if (metadata.isSymbolicLink()) return 'link';
    if (metadata.isDirectory()) return 'directory';
    return metadata.isFile() ? 'file' : 'special';
}

// Every segment below `home` must be a real directory; a link or a file anywhere on the way throws. False: a segment is missing.
export async function checkedPath(home, relative) {
    let current = home;
    for (const segment of relative.split('/')) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!stat) return false;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe OpenCode state directory');
    }
    return true;
}

// JSON with comments and trailing commas, as OpenCode reads its configuration; null when it still does not parse.
function parseJsonc(raw) {
    const text = raw.replace(/^\uFEFF/u, '');
    let withoutComments = '';
    let inString = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            withoutComments += char;
            if (char === '\\') withoutComments += text[++index] ?? '';
            else if (char === '"') inString = false;
        } else if (char === '"') { inString = true; withoutComments += char; }
        else if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; withoutComments += '\n'; }
        else if (char === '/' && text[index + 1] === '*') {
            const end = text.indexOf('*/', index + 2);
            if (end < 0) return null;
            index = end + 1;
            withoutComments += ' ';
        } else withoutComments += char;
    }
    let result = '';
    inString = false;
    for (let index = 0; index < withoutComments.length; index++) {
        const char = withoutComments[index];
        if (inString) {
            result += char;
            if (char === '\\') result += withoutComments[++index] ?? '';
            else if (char === '"') inString = false;
        } else if (char === '"') { inString = true; result += char; }
        else if (char === ',' && /^\s*[}\]]/u.test(withoutComments.slice(index + 1))) continue;
        else result += char;
    }
    try { return JSON.parse(result); } catch { return null; }
}

// The manifest this tree always had: nothing but one dependency on the plugin package.
function managedManifest(manifest) {
    const value = manifest.value;
    if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.dependencies)) return null;
    const names = Object.keys(value.dependencies);
    if (names.length !== 1 || !OPENCODE_PLUGIN_PACKAGES.includes(names[0])) return null;
    return typeof value.dependencies[names[0]] === 'string' && value.dependencies[names[0]] ? names[0] : null;
}

// The lock's root record may list only that dependency and no other section.
function managedLock(lock, dependency) {
    const root = lock.value?.packages?.[''];
    if (!isRecord(root)) return false;
    const dependencies = root.dependencies ?? {};
    if (!isRecord(dependencies) || Object.keys(dependencies).some(name => name !== dependency)) return false;
    return DEPENDENCY_SECTIONS.every(section => root[section] === undefined
        || (isRecord(root[section]) && Object.keys(root[section]).length === 0));
}

// 'authored': something besides RoboWork's own plugin names or configures a plugin. Null when there is no sign of one.
async function authoredReason(directory) {
    for (const name of PLUGIN_DIRECTORIES) {
        const type = await entryType(path.join(directory, name));
        if (type === 'missing') continue;
        if (type !== 'directory') return { status: 'unsafe', reason: `${name} is not a directory` };
        for (const entry of await fs.readdir(path.join(directory, name))) {
            if (!OWN_PLUGIN_FILES.has(entry)) return { status: 'authored', reason: `${name} holds another entry` };
            if (await entryType(path.join(directory, name, entry)) !== 'file') return { status: 'unsafe', reason: `${name}/${entry} is not a file` };
        }
    }
    for (const name of CONFIG_DOCUMENTS) {
        const document = await readRegularFile(path.join(directory, name));
        if (document.missing) continue;
        if (document.unsafe) return { status: 'authored', reason: `${name} cannot be read safely` };
        const value = parseJsonc(document.text);
        if (!isRecord(value)) return { status: 'authored', reason: `${name} is not a readable object` };
        if (Object.hasOwn(value, 'plugin') || Object.hasOwn(value, 'plugins')) return { status: 'authored', reason: `${name} configures a plugin` };
    }
    return null;
}

// Read-only. Classifies `<home>/.config/opencode`; `directory` is set only once every path segment was checked, and
// `leftovers` names what a killed earlier run left behind. Never throws.
export async function pluginTreeDisposition(home) {
    try {
        const root = await entryType(home);
        if (root === 'missing') return { status: 'absent', leftovers: [] };
        if (root !== 'directory') return { status: 'unsafe', reason: 'home is not a directory', leftovers: [] };
        let present;
        try { present = await checkedPath(home, OPENCODE_CONFIG); } catch { return { status: 'unsafe', reason: 'configuration path is a link', leftovers: [] }; }
        if (!present) return { status: 'absent', leftovers: [] };
        const directory = path.join(home, OPENCODE_CONFIG);
        const leftovers = [];
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (LEFTOVER.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) leftovers.push(entry.name);
        }
        const result = (status, extra = {}) => ({ status, directory, leftovers, ...extra });
        const [modules, manifestType, lockType] = await Promise.all(TREE_NAMES.map(name => entryType(path.join(directory, name))));
        if ([modules, manifestType, lockType].some(type => type === 'link' || type === 'special')
            || modules === 'file' || manifestType === 'directory' || lockType === 'directory') return result('unsafe', { reason: 'link or special entry' });
        if (modules === 'missing' && manifestType === 'missing' && lockType === 'missing') return result('absent');
        const [manifest, lock] = await Promise.all([readJson(path.join(directory, 'package.json')), readJson(path.join(directory, 'package-lock.json'))]);
        if (manifest.unsafe || lock.unsafe) return result('unsafe', { reason: 'file is shared or too large' });
        // A node_modules without a manifest, or a lock alone, is not something this code wrote.
        if (manifest.missing || manifest.invalid || lock.invalid) return result('customized', { reason: 'manifest or lock is missing or unreadable' });
        const dependency = managedManifest(manifest);
        if (!dependency) return result('customized', { reason: 'manifest is not the plugin-only manifest' });
        if (!lock.missing && !managedLock(lock, dependency)) return result('customized', { reason: 'lock lists other dependencies' });
        const authored = await authoredReason(directory);
        if (authored) return result(authored.status, { reason: authored.reason });
        return result('managed', { dependency, hasTree: modules === 'directory' });
    } catch (error) {
        return { status: 'failed', error: error?.message || String(error), leftovers: [] };
    }
}

// Removes the managed tree: node_modules is renamed aside first, so a killed run leaves one name to clean up; the manifest
// goes last, so a killed run is still classified as managed on the next start. Never throws.
export async function retireOpenCodePlugin(home) {
    try {
        const disposition = await pluginTreeDisposition(home);
        const { directory } = disposition;
        if (directory) {
            for (const name of disposition.leftovers) await fs.rm(path.join(directory, name), { recursive: true, force: true });
        }
        if (disposition.status !== 'managed') {
            const { status, reason, error } = disposition;
            return { status, ...(reason ? { reason } : {}), ...(error ? { error } : {}) };
        }
        if (await entryType(path.join(directory, 'node_modules')) === 'directory') {
            const stale = path.join(directory, `.roboteam-stale-${randomUUID()}`);
            await fs.rename(path.join(directory, 'node_modules'), stale);
            await fs.rm(stale, { recursive: true, force: true });
        }
        await fs.rm(path.join(directory, 'package-lock.json'), { force: true });
        await fs.rm(path.join(directory, 'package.json'), { force: true });
        return { status: 'retired' };
    } catch (error) {
        return { status: 'failed', error: error?.message || String(error), code: error?.code };
    }
}
