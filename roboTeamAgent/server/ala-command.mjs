import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function resolveAlaCommand(override) {
    if (override) return override;
    let entry;
    try {
        entry = require.resolve('advanced-language-agent/bin/ala.mjs');
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        // Keep construction side-effect free; installation validation reports missing dependencies.
        entry = fileURLToPath(new URL('../node_modules/advanced-language-agent/bin/ala.mjs', import.meta.url));
    }
    try { return realpathSync(entry); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return entry;
    }
}
