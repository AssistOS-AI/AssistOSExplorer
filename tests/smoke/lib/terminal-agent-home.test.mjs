import assert from 'node:assert/strict';
import test from 'node:test';
import { probeRobotHome } from './terminal-agent-home.mjs';

const runtime = { outerContainerId: 'box-id' };
const provider = { containerId: 'provider-id' };
const robot = { id: 'terminal-123456', name: 'terminal-123456789abc' };
const marker = 'terminal-123456789abc';

test('home probe pins both containers and refuses failed or replaced providers', () => {
  let calls = 0;
  const inspect = (actualRuntime, actualProvider) => {
    assert.equal(actualRuntime, runtime); assert.equal(actualProvider, provider); calls += 1;
    return { present: true, running: true };
  };
  const spawn = (command, args) => {
    assert.equal(command, 'podman');
    assert.deepEqual(args.slice(0, 6), ['exec', 'box-id', '/usr/bin/podman', 'exec', 'provider-id', 'node']);
    assert.deepEqual(args.slice(-5), ['verify', robot.id, robot.name, marker, '123']);
    return { status: 0, stdout: '{"inode":"123","device":"7"}' };
  };
  assert.equal(probeRobotHome(runtime, provider, robot, marker, 'verify', '123', { inspect, spawn }).inode, '123');
  assert.equal(calls, 2);
  assert.throws(() => probeRobotHome(runtime, provider, robot, marker, 'seed', '', {
    inspect: () => ({ present: false }), spawn,
  }), /not running/);
  let inspections = 0;
  assert.throws(() => probeRobotHome(runtime, provider, robot, marker, 'verify', '123', {
    inspect: () => (++inspections === 1 ? { present: true, running: true } : { present: false }), spawn,
  }), /changed/);
  assert.throws(() => probeRobotHome(runtime, provider, robot, marker, 'seed', '', {
    inspect, spawn: () => ({ status: 1 }),
  }), /failed/);
});
