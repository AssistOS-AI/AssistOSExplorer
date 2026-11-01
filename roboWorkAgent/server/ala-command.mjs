import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveAlaCommand(override) {
    if (override) return override;
    const runtimeLink = '/Agent/linked/AdvancedLanguageAgent/bin/ala.mjs';
    const linked = existsSync(runtimeLink) ? runtimeLink
        : fileURLToPath(new URL('../../Agent/linked/AdvancedLanguageAgent/bin/ala.mjs', import.meta.url));
    // Local source tests use the same workspace checkout without a container mount.
    const sibling = fileURLToPath(new URL('../../../AdvancedLanguageAgent/bin/ala.mjs', import.meta.url));
    const entry = existsSync(linked) ? linked : existsSync(sibling) ? sibling : linked;
    try { return realpathSync(entry); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return entry;
    }
}
