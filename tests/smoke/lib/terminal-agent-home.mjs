import { spawnSync } from 'node:child_process';
import { collectExactAgentState } from './webtty-runtime-evidence.mjs';

const PROBE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [operation, id, name, marker, expectedInode] = process.argv.slice(1);
if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id) || !/^terminal-[a-f0-9]{12}$/.test(name) || !/^terminal-[a-f0-9]{12}$/.test(marker)) throw Error('Invalid owned fixture');
for (const dir of ['/data', '/data/robots', '/data/robots/' + id, '/data/robots/' + id + '/home']) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Unsafe robot home');
}
const root = '/data/robots/' + id;
const label = path.join(root, 'label');
const labelStat = fs.lstatSync(label);
if (!labelStat.isFile() || labelStat.isSymbolicLink()) throw Error('Unsafe robot label');
const robot = JSON.parse(fs.readFileSync(label, 'utf8'));
if (robot.id !== id || robot.name !== name) throw Error('Robot ownership mismatch');
const file = path.join(root, 'home', 'terminal-proof');
if (operation === 'seed') fs.writeFileSync(file, marker, { flag: 'wx', mode: 0o600 });
else if (operation !== 'verify') throw Error('Invalid operation');
const stat = fs.lstatSync(file, { bigint: true });
if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe proof file');
const content = fs.readFileSync(file, 'utf8');
if (content !== (operation === 'seed' ? marker : marker + '-writeback')) throw Error('Wrong proof content');
if (operation === 'verify' && String(stat.ino) !== expectedInode) throw Error('Proof inode changed');
process.stdout.write(JSON.stringify({ inode: String(stat.ino), device: String(stat.dev) }));
`;

export function probeRobotHome(runtime, provider, robot, marker, operation, inode = '', { inspect = collectExactAgentState, spawn = spawnSync } = {}) {
  const before = inspect(runtime, provider);
  if (!before.present || !before.running) throw new Error('RoboWork provider is not running.');
  const result = spawn('podman', ['exec', runtime.outerContainerId, '/usr/bin/podman', 'exec', provider.containerId,
    'node', '-e', PROBE, operation, robot.id, robot.name, marker, inode],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error(`RoboWork home probe failed (exit ${result.status ?? 'unknown'}).`);
  const after = inspect(runtime, provider);
  if (!after.present || !after.running) throw new Error('RoboWork provider changed during home probe.');
  const output = JSON.parse(result.stdout);
  if (!/^\d+$/.test(output.inode) || !/^\d+$/.test(output.device)) throw new Error('Invalid home proof identity.');
  return output;
}
