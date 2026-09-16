import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSoulGatewayOpenCode } from './soul-gateway-opencode.mjs';

export async function installSoulGatewayPlugin(home) {
    for (const [source, target] of [
        ['soul-gateway-models.mjs', '.config/opencode/soul-gateway-models.mjs'],
        ['plugins/soul-gateway.js', '.config/opencode/plugins/soul-gateway.js'],
    ]) {
        const destination = path.join(home, target);
        const content = await fs.readFile(new URL(source, import.meta.url));
        const existing = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('Unsafe Soul Gateway plugin file.');
        if (existing && content.equals(await fs.readFile(destination))) continue;
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, destination);
        } finally { await fs.rm(temporary, { force: true }); }
    }
}

// One service process owns the private sockets. Native clients never get Router credentials.
export function createSoulGatewayService({ adapter = createSoulGatewayOpenCode } = {}) {
    const robots = new Map();
    let closed = false;
    return {
        async prepare(home) {
            if (closed) throw new Error('Soul Gateway service is closed.');
            if (robots.has(home)) return robots.get(home);
            const work = (async () => {
                const gateway = adapter();
                try {
                    const enabled = await gateway.listen(path.join(home, '.config/opencode/soul-gateway.sock'));
                    return enabled ? gateway : null;
                } catch (error) { await gateway.close(); throw error; }
            })();
            robots.set(home, work);
            try { return await work; }
            catch (error) { robots.delete(home); throw error; }
        },
        async remove(home) {
            const work = robots.get(home);
            robots.delete(home);
            const gateway = await work;
            await gateway?.close();
        },
        async close() {
            closed = true;
            await Promise.all([...robots.values()].map(async work => {
                const gateway = await work.catch(() => null);
                await gateway?.close();
            }));
            robots.clear();
        },
    };
}
