import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

assert.equal(os.userInfo().username, 'admin');
assert.equal(os.homedir(), '/home/admin');
const run = (command, args, timeout = 30_000) => execFileSync(command, args, {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
});
function size(file) {
    try {
        const value = run('du', ['-s', '-B1', '--', file], 45_000).trim().split(/\s+/)[0];
        assert(/^\d+$/.test(value));
        return Number(value);
    } catch { return null; }
}
function item(file) {
    const stat = fs.lstatSync(file);
    return { path: file, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(),
        uid: stat.uid, device: stat.dev, inode: stat.ino, modified: stat.mtime.toISOString(),
        bytes: stat.isDirectory() && !stat.isSymbolicLink() ? size(file) : stat.size };
}
function inventoryEngine(command, prefix = []) {
    const execute = args => run(command, [...prefix, ...args]);
    try {
        const ids = execute(['container', 'ls', '-aq', '--no-trunc']).trim().split(/\s+/).filter(Boolean);
        const containers = ids.length ? JSON.parse(execute(['container', 'inspect', ...ids])).map(container => ({
            id: container.Id, name: String(container.Name || '').replace(/^\//, ''),
            state: container.State?.Status, running: container.State?.Running === true,
            image: container.Image, imageName: container.ImageName || container.Config?.Image,
            labels: Object.fromEntries(Object.entries(container.Config?.Labels || {}).filter(([key]) => key.startsWith('io.assistos.ploinky'))),
            mounts: (container.Mounts || []).map(mount => ({ type: mount.Type, source: mount.Source, destination: mount.Destination, writable: mount.RW })),
            ports: container.NetworkSettings?.Ports,
        })) : [];
        const imageIds = [...new Set(execute(['image', 'ls', '-aq', '--no-trunc']).trim().split(/\s+/).filter(Boolean))];
        const used = new Set(containers.map(container => container.image.replace(/^sha256:/, '')));
        const images = imageIds.length ? JSON.parse(execute(['image', 'inspect', ...imageIds])).map(image => ({
            id: image.Id, tags: image.RepoTags || [], digests: image.RepoDigests || [],
            created: image.Created, bytes: image.Size,
            referencedByContainer: used.has(image.Id.replace(/^sha256:/, '')),
        })) : [];
        let usage;
        try { usage = execute(['system', 'df', '--format', 'json']); } catch { usage = 'unavailable'; }
        return { available: true, containers, images, usage };
    } catch { return { available: false }; }
}

const engines = {};
for (const engine of ['podman', 'docker']) {
    engines[engine] = inventoryEngine(engine);
    for (const container of engines[engine].containers || []) {
        if (!container.running || container.labels['io.assistos.ploinky-box.role'] !== 'box') continue;
        container.nested = inventoryEngine(engine, ['container', 'exec', '--user', 'podman', container.id, 'podman']);
    }
}
for (const engine of ['docker', 'podman']) {
    engines[`${engine}Root`] = inventoryEngine('sudo', ['-n', engine]);
}
const hostDirectoryUsage = {};
for (const directory of ['/home/admin', '/root', '/opt', '/var/lib/docker', '/var/lib/containers', '/tmp', '/var/tmp']) {
    try {
        hostDirectoryUsage[directory] = run('sudo', ['-n', '/usr/bin/node', '--input-type=module', '-e',
            'import { execFileSync } from "node:child_process"; process.stdout.write(execFileSync("du", ["-x", "-B1", "-d1", "--", process.argv[1]], {encoding:"utf8", timeout:90000, killSignal:"SIGKILL", stdio:["ignore","pipe","pipe"]}));',
            directory], 100_000);
    } catch { hostDirectoryUsage[directory] = 'unavailable'; }
}
const candidates = new Set();
const omitted = new Set(['.ssh', '.config', '.cache', '.local', '.npm', '.git', 'node_modules', '.data']);
function walk(directory, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.name === '.ploinky') { candidates.add(file); continue; }
        if (omitted.has(entry.name)) continue;
        if (/(backup|artifact|test|explorer|ploinky|soul)/i.test(entry.name)
            || /^\.qa-(?:e2e|reset)/.test(entry.name)) candidates.add(file);
        if (entry.isDirectory()) walk(file, depth + 1);
    }
}
walk('/home/admin', 0);
for (const entry of fs.readdirSync('/tmp', { withFileTypes: true })) {
    if (!entry.isSymbolicLink() && /^(explorer[_-]qa|ploinky|qa[-_])/.test(entry.name)) {
        const file = path.join('/tmp', entry.name);
        if (fs.lstatSync(file).uid === process.getuid()) candidates.add(file);
    }
}
for (const file of ['/home/admin/explorerWorkspace', '/home/admin/explorerQaWorkspace', '/home/admin/soulGateway']) {
    if (fs.existsSync(file)) candidates.add(file);
}
const disk = fs.statfsSync('/home/admin', { bigint: true });
console.log(JSON.stringify({ version: 1, host: os.hostname(), user: os.userInfo().username,
    inspectedAt: new Date().toISOString(), node: process.version,
    totalBytes: String(disk.blocks * disk.bsize), availableBytes: String(disk.bavail * disk.bsize),
    engines, hostDirectoryUsage, paths: [...candidates].sort().map(item),
}, null, 2));
