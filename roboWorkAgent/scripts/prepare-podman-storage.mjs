import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { terminalDirectory } from '../server/terminal-profiles.mjs';

// The image initializer owns disposable graphroot/runroot on tmpfs. Only the persistent image cache moves.
export async function preparePodmanStorage({ dataDir = '/root', source = '/opt/roboteam-runtime/storage.conf' } = {}) {
    const template = await fs.readFile(source, 'utf8');
    for (const line of ['graphroot = "/var/lib/roboteam-podman/storage"', 'runroot = "/var/lib/roboteam-podman/run"',
        'transient_store = true', 'force_mask = "0700"']) {
        if (!template.split('\n').includes(line)) throw new Error('Unsupported RoboWork Podman storage layout');
    }
    if (!/^imagestore = "\/(?:data|root)\/podman\/images"$/mu.test(template)) throw new Error('Unsupported RoboWork image store');
    const root = path.resolve(dataDir);
    await terminalDirectory(root);
    const state = path.join(root, 'server-state');
    await terminalDirectory(state, { create: true });
    const podman = path.join(root, 'podman');
    await terminalDirectory(podman, { create: true });
    await terminalDirectory(path.join(podman, 'images'), { create: true });
    const configuration = template.replace(/^imagestore = .*$/mu, `imagestore = ${JSON.stringify(path.join(podman, 'images'))}`);
    const destination = path.join(state, 'podman-storage.conf');
    const temporary = path.join(state, '.podman-storage-' + randomUUID());
    try {
        await fs.writeFile(temporary, configuration, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
    return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.stdout.write(await preparePodmanStorage() + '\n');
}
