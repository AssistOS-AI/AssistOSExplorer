import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manifest keeps every writable host volume beneath the unique agent data root', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'manifest.json'), 'utf8'));

  assert.deepEqual(manifest.volumes, {
    '.data/liveKitServerAgent/generated': '/working-data/generated',
    '.data/liveKitServerAgent/redis': '/data/redis',
    '.data/liveKitServerAgent/recordings': '/data/recordings',
  });
  assert.deepEqual(manifest.volumeOptions['/working-data/generated'], {
    generated: true,
    required: false,
  });
  for (const hostPath of Object.keys(manifest.volumes)) {
    assert.equal(
      hostPath.startsWith('.data/liveKitServerAgent/'),
      true,
      `${hostPath} must be owned by liveKitServerAgent beneath .data`,
    );
  }
});
