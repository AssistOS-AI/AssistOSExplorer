import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALA_PIN = 'cf2996dcf22465d5ed408a0e93aec2ca59f1f91b';

// The ALA checkout is a read-only reference. ALA_ROOT overrides the sibling default; a missing checkout is an error,
// never a skip.
export function alaRoot() {
    const root = process.env.ALA_ROOT
        || fileURLToPath(new URL('../../../../../AdvancedLanguageAgent', import.meta.url));
    const suite = path.join(root, 'tests/provider-conformance.mjs');
    if (!fs.existsSync(suite)) throw new Error(`ALA conformance suite not found at ${suite}; set ALA_ROOT`);
    // The suite is evidence only for the ALA revision that the plan pins. Any other checkout fails; it is never skipped.
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== ALA_PIN) {
        throw new Error(`ALA checkout ${root} is at ${head.stdout.trim() || 'an unknown revision'}, not the pin ${ALA_PIN}`);
    }
    return root;
}

export async function rawWireCaseNames() {
    const root = alaRoot();
    const suite = await import(pathToFileURL(path.join(root, 'tests/provider-conformance.mjs')).href);
    const names = [];
    suite.defineRawWireConformance({
        label: 'robo-work provider endpoint', test: (name) => names.push(name),
        harness: { view: { home: '', cwd: '', folder: '', outside: '' }, readOnlyFolder: '' }
    });
    return names;
}
