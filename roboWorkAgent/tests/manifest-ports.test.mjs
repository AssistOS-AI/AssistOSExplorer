import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('RoboWork Box ports avoid the LiveKit readiness listener and the RoboTeam bindings', async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8'));
    const ports = manifest.profiles.default.openPorts;
    assert.deepEqual(ports, ['17100:7000', '13101:3001']);
    const boxPorts = ports.map(entry => entry.split(':')[0]);
    for (const reserved of ['17000', '7000', '3001']) assert.ok(!boxPorts.includes(reserved), `Box port ${reserved} is reserved`);
});
