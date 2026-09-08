import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startScript = path.join(agentRoot, 'scripts/start-livekit-server-agent.sh');

test('runtime checks the unversioned contract path emitted by the image build', () => {
  const source = fs.readFileSync(startScript, 'utf8');
  assert.match(source, /EGRESS_CONTRACT="\/usr\/local\/share\/ploinky\/livekit-egress-loopback\.contract"/);
  assert.doesNotMatch(source, /livekit-egress-loopback-v5\.contract/);
});

test('runtime invokes the non-executable health source through the shell', () => {
  const source = fs.readFileSync(startScript, 'utf8');
  assert.match(source, /^sh \/code\/scripts\/health\/livekit-server-agent-health\.sh$/m);
});

test('runtime restores the unprivileged PulseAudio and Egress process contract', () => {
  const source = fs.readFileSync(startScript, 'utf8');
  assert.match(source, /EGRESS_UID="\$\(id -u egress/);
  assert.match(source, /setpriv \\\n\s+--reuid="\$EGRESS_UID"/);
  assert.match(source, /XDG_RUNTIME_DIR="\$EGRESS_XDG_RUNTIME_DIR" \\\n\s+pulseaudio \\\n\s+--daemonize=no/);
  assert.match(source, /PULSE_SERVER="unix:\$\{EGRESS_XDG_RUNTIME_DIR\}\/pulse\/native"/);
  assert.match(source, /run_as_egress env PULSE_SERVER="\$PULSE_SERVER" pactl info/);
  assert.match(source, /PULSE_SERVER="\$PULSE_SERVER" \\\n\s+EGRESS_CONFIG_FILE="\$EGRESS_RUNTIME_CONFIG" \\\n\s+egress &/);
  assert.match(source, /install -o "\$EGRESS_UID" -g "\$EGRESS_GID" -m 0400/);
  assert.match(source, /chown "\$EGRESS_UID:\$EGRESS_GID" \/data\/recordings/);
  assert.match(source, /printf '%s\\n' "\$EGRESS_PID" > "\$EGRESS_PID_FILE"/);
  assert.match(source, /kill -0 "\$pid"/);
  assert.match(source, /ss -H -lntpe/);
  assert.match(source, /index\(\$0, "uid:" uid\)/);
  assert.doesNotMatch(source, /\/proc\/\$\{pid\}/);
  assert.doesNotMatch(source, /ps -o uid=,comm=/);
  assert.doesNotMatch(source, /\/users:\\\\\(\\\\\("egress"/);
  assert.match(source, /SUPERVISED_PIDS="\$REDIS_PID,\$LIVEKIT_PID,\$PULSE_PID,\$EGRESS_PID"/);
});

test('summary readiness uses PID liveness and kernel listener ownership', () => {
  const source = fs.readFileSync(
    path.join(agentRoot, 'scripts/health/livekit-server-agent-health.sh'),
    'utf8',
  );
  assert.match(source, /kill -0 "\$egress_pid"/);
  assert.match(source, /ss -H -lntpe/);
  assert.match(source, /index\(\$0, "uid:" uid\)/);
  assert.doesNotMatch(source, /ps -o uid=,comm=/);
  assert.doesNotMatch(source, /\/proc\/\$\{egress_pid\}/);
});

test('private supervisor requires all four runtime processes', () => {
  const source = fs.readFileSync(
    path.join(agentRoot, 'scripts/health/supervisor-health.mjs'),
    'utf8',
  );
  assert.match(source, /supervisedPids\.length === 4/);
  assert.doesNotMatch(source, /supervisedPids\.length === 3/);
});

test('runtime without the v5 image marker fails before reading generated config or opening listeners', () => {
  const result = spawnSync('sh', [startScript], {
    cwd: agentRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LiveKit Egress v5 image contract marker is missing/);
  assert.match(result.stderr, /pin its verified index before activation/);
  assert.doesNotMatch(result.stderr, /missing generated file/);
});
