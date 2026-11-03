import fs from 'node:fs/promises';

for (const directory of ['/data', '/data/robots', '/data/runs', '/data/tool-cache', '/data/server-state']) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe RoboWork storage');
    await fs.chmod(directory, 0o700);
}
