// Resolves the sibling repositories whose sources some tests in this repository
// read. A missing sibling throws; a test never skips because of it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const SIBLINGS = Object.freeze({
    'legacy-agents': Object.freeze({ env: 'LEGACY_AGENTS_ROOT', directory: 'legacy-agents' }),
    webmeet: Object.freeze({ env: 'WEBMEET_ROOT', directory: 'webmeet' }),
    ploinky: Object.freeze({ env: 'PLOINKY_ROOT', directory: 'ploinky' }),
});

// The sibling checkout root: the environment variable when set, else the
// directory next to this repository. Throws when it does not exist.
export function siblingRoot(name, { repoRoot = REPO_ROOT, env = process.env } = {}) {
    const entry = SIBLINGS[name];
    if (!entry) throw new Error(`Unknown sibling repository "${name}" (known: ${Object.keys(SIBLINGS).join(', ')}).`);
    const root = path.resolve(env[entry.env] || path.join(repoRoot, '..', entry.directory));
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`The "${name}" sibling checkout is required by this test but is missing at ${root}. `
            + `Check out ${name} next to this repository or set ${entry.env}.`);
    }
    return root;
}

// An absolute path inside a sibling checkout. Throws when the path is absent.
export function siblingPath(name, ...segments) {
    const target = path.join(siblingRoot(name), ...segments);
    if (!fs.existsSync(target)) {
        throw new Error(`Expected ${path.join(...segments)} in the "${name}" sibling checkout, but ${target} does not exist.`);
    }
    return target;
}

export function siblingUrl(name, ...segments) {
    return pathToFileURL(siblingPath(name, ...segments));
}

// Dynamic import of a module that lives in a sibling checkout.
export function importFromSibling(name, ...segments) {
    return import(siblingUrl(name, ...segments).href);
}
