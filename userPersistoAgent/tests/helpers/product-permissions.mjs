import { readFileSync } from 'node:fs';
import { ensureSeedData } from '../../lib/bootstrap.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url)));
export const explorerPermissions = JSON.parse(manifest.profiles.explorer.env.USERPERSISTO_PRODUCT_PERMISSIONS.value);

// Tests exercising Explorer explicitly opt into the same configuration as its
// dependency profile. General account tests keep the neutral default bootstrap.
export function ensureExplorerSeedData() {
    return ensureSeedData({ productPermissions: explorerPermissions });
}
