import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin';
const MAX_JSON_BYTES = 4 * 1024 * 1024;

// Read a regular file without following a link; the robot home is writable by the sandbox.
async function readRegularFile(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_JSON_BYTES) return { unsafe: true };
        return { text: await handle.readFile('utf8') };
    } catch (error) {
        if (error.code === 'ENOENT') return { missing: true };
        if (['ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code)) return { unsafe: true };
        throw error;
    } finally { await handle?.close(); }
}

async function readJson(file) {
    const result = await readRegularFile(file);
    if (!result.text) return result;
    try { return { value: JSON.parse(result.text) }; } catch { return { invalid: true }; }
}

async function entryType(file) {
    const metadata = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!metadata) return 'missing';
    if (metadata.isSymbolicLink()) return 'link';
    return metadata.isDirectory() ? 'directory' : 'file';
}

// What OpenCode itself checks before it installs (Npm.install): node_modules exists and
// package-lock.json lists the dependency. It never compares versions, so a plugin left by an
// older OpenCode would stay forever; this state also requires the exact installed version.
export async function openCodePluginState(directory, version) {
    const manifest = await readJson(path.join(directory, 'package.json'));
    const lock = await readJson(path.join(directory, 'package-lock.json'));
    const installed = await readJson(path.join(directory, 'node_modules', OPENCODE_PLUGIN_PACKAGE, 'package.json'));
    const unsafe = [manifest, lock, installed].some(item => item.unsafe);
    const dependencies = manifest.value?.dependencies;
    // Only the manifest this module and OpenCode write: nothing but the plugin dependency.
    const managed = Boolean(manifest.value && dependencies && typeof dependencies === 'object'
        && Object.keys(dependencies).length === 1 && dependencies[OPENCODE_PLUGIN_PACKAGE] !== undefined
        && ['devDependencies', 'peerDependencies', 'optionalDependencies'].every(key =>
            !manifest.value[key] || Object.keys(manifest.value[key]).length === 0));
    const current = managed
        && dependencies[OPENCODE_PLUGIN_PACKAGE] === version
        && lock.value?.packages?.['']?.dependencies?.[OPENCODE_PLUGIN_PACKAGE] === version
        && lock.value?.packages?.[`node_modules/${OPENCODE_PLUGIN_PACKAGE}`]?.version === version
        && installed.value?.version === version;
    return { unsafe, managed, current, manifest, lock };
}

// Copy the prepared plugin dependency tree into a robot's OpenCode configuration directory
// before OpenCode first runs there, so its dependency installation finds nothing to do.
// The template is a copy, never a link: the sandbox sees the home at another path, and a
// later OpenCode install must not write through into the shared tool cache.
//
// Returns the outcome so callers and tests can tell the cases apart:
//   unavailable - no template for this OpenCode version (OpenCode installs for itself)
//   current     - the home already holds this exact version
//   seeded      - nothing was installed; the template was copied in
//   reseeded    - an older or incomplete managed install was replaced
//   customized  - the home declares other dependencies or holds a node_modules without a
//                 managed manifest; left alone for OpenCode to maintain
//   unsafe      - a link or special file sits where the seed would read or write; left alone
//   aborted     - isCancelled() became true (the robot is being deleted) before anything was moved
//                 into the home; the staging directory is removed and nothing is left behind
//   failed      - the copy did not complete; nothing is left half-installed and OpenCode
//                 installs for itself, as it did before seeding existed
export async function seedOpenCodePlugin(home, template, { isCancelled = () => false } = {}) {
    try { return await seedHome(home, template, isCancelled); }
    catch (error) { return { status: 'failed', error: error?.message || String(error) }; }
}

async function seedHome(home, template, isCancelled) {
    if (!template?.path || !template.version) return { status: 'unavailable' };
    const directory = path.join(home, '.config', 'opencode');
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe OpenCode configuration directory');
    for (let attempt = 0; attempt < 3; attempt++) {
        const [modules, manifestType, lockType] = await Promise.all([
            entryType(path.join(directory, 'node_modules')), entryType(path.join(directory, 'package.json')),
            entryType(path.join(directory, 'package-lock.json'))]);
        if ([modules, manifestType, lockType].includes('link')
            || modules === 'file' || manifestType === 'directory' || lockType === 'directory') return { status: 'unsafe' };
        const state = await openCodePluginState(directory, template.version);
        if (state.unsafe) return { status: 'unsafe' };
        if (state.current) return { status: 'current' };
        const hasManifest = Boolean(state.manifest.value);
        if (hasManifest ? !state.managed : state.manifest.invalid || modules === 'directory') return { status: 'customized' };
        if (isCancelled()) return { status: 'aborted' };
        const stale = `${directory}/.roboteam-stale-${randomUUID()}`;
        const staging = `${directory}/.roboteam-seed-${randomUUID()}`;
        try {
            await fs.mkdir(staging, { mode: 0o700 });
            await fs.cp(path.join(template.path, 'node_modules'), path.join(staging, 'node_modules'),
                { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
                    mode: constants.COPYFILE_FICLONE });
            for (const name of ['package-lock.json', 'package.json']) {
                await fs.copyFile(path.join(template.path, name), path.join(staging, name), constants.COPYFILE_EXCL);
                await fs.chmod(path.join(staging, name), 0o600);
            }
            // The last point before the home changes: a robot being deleted gets nothing more written.
            if (isCancelled()) return { status: 'aborted' };
            // The manifest and lock first; node_modules last, because its presence is what
            // makes OpenCode skip the installation.
            for (const name of ['package-lock.json', 'package.json']) {
                await fs.rename(path.join(staging, name), path.join(directory, name));
            }
            if (modules === 'directory') await fs.rename(path.join(directory, 'node_modules'), stale);
            try {
                await fs.rename(path.join(staging, 'node_modules'), path.join(directory, 'node_modules'));
            } catch (error) {
                // A concurrent preparation of the same home won the rename; verify its result.
                if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
                continue;
            }
            return { status: modules === 'directory' ? 'reseeded' : 'seeded' };
        } finally {
            await Promise.all([fs.rm(staging, { recursive: true, force: true }),
                fs.rm(stale, { recursive: true, force: true })]);
        }
    }
    return { status: 'unsafe' };
}
