import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// One shared budget for every pull of a startup refresh; a slow registry cannot hold refreshes forever.
export const IMAGE_REFRESH_BUDGET_MS = 20 * 60 * 1000;

// A digest reference names fixed content, so pulling it again cannot bring anything newer.
export function isTaggedReference(image) {
    return typeof image === 'string' && image.trim() !== '' && !image.includes('@');
}

async function localImageId(image, { podmanCommand, execFileImpl }) {
    try {
        const result = await execFileImpl(podmanCommand, ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15000, maxBuffer: 1024 * 1024 });
        return String(result.stdout || '').trim() || null;
    } catch { return null; }
}

// Pulls each tagged image again so a new build published under the same tag reaches robots. Running containers keep
// the image they started from; the next start uses the refreshed one. A failed pull keeps the local image and never throws.
export async function refreshImages(images, { podmanCommand = '/usr/bin/podman', execFileImpl = execute, onlyPresent = false,
    budgetMs = IMAGE_REFRESH_BUDGET_MS, now = Date.now, log = message => console.log(message) } = {}) {
    const unique = [...new Set(images.filter(isTaggedReference).map(image => image.trim()))];
    const deadline = now() + budgetMs;
    const results = [];
    for (const image of unique) {
        const before = await localImageId(image, { podmanCommand, execFileImpl });
        if (onlyPresent && !before) continue;
        const remaining = deadline - now();
        if (remaining <= 0) {
            log(`[image-refresh] ${image}: skipped, refresh time budget exhausted`);
            results.push({ image, outcome: 'skipped' });
            continue;
        }
        try {
            await execFileImpl(podmanCommand, ['pull', '--quiet', image], { timeout: remaining, maxBuffer: 8 * 1024 * 1024 });
        } catch (error) {
            log(`[image-refresh] ${image}: pull failed, keeping the local image (${error.code || error.signal || 'error'})`);
            results.push({ image, outcome: 'failed' });
            continue;
        }
        const after = await localImageId(image, { podmanCommand, execFileImpl });
        const outcome = before && after && before === after ? 'current' : 'updated';
        log(`[image-refresh] ${image}: ${outcome === 'updated' ? 'updated' : 'already current'}`);
        results.push({ image, outcome });
    }
    return results;
}
