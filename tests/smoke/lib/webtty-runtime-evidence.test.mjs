import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import {
  captureNestedPodmanEventCursor,
  collectAgentProcessRows,
  collectNestedContainerEvents,
  collectExactRoutingServerIdentity,
  collectWebttyRuntimeEvidence,
  collectWebttyRecoveryDirectoryState,
  crashExactRoutingServer,
  independentlyTranslateMount,
  inspectNestedContainer,
  requireAgentEvidence,
  resolveWebttyBoxEndpoint,
  workspaceHash,
} from './webtty-runtime-evidence.mjs';

const OUTER_ID = 'a'.repeat(64);
const AGENT_ID = 'b'.repeat(64);
const AGENT = Object.freeze({
  runtime: 'podman',
  containerId: AGENT_ID,
  containerName: 'ploinky-agent-git',
  instanceId: 'instance-git',
  enableGeneration: 'enable-git',
});
const ROUTER_EVIDENCE = Object.freeze({
  outerContainerId: OUTER_ID,
  workspaceRoot: '/srv/webtty workspace',
  workspaceHash: workspaceHash('/srv/webtty workspace'),
});

test('WebTTY browser localhost and Box IPv4 origins select the same exact loopback port', () => {
    assert.deepEqual(resolveWebttyBoxEndpoint({
        baseURL: 'http://localhost:8080', boxBaseURL: 'http://127.0.0.1:8080',
    }), { baseURL: 'http://127.0.0.1:8080', port: '8080' });
    assert.deepEqual(resolveWebttyBoxEndpoint({
        baseURL: 'http://127.0.0.1:18080/',
    }), { baseURL: 'http://127.0.0.1:18080', port: '18080' });
    assert.deepEqual(resolveWebttyBoxEndpoint({
        baseURL: 'http://localhost', boxBaseURL: 'http://127.0.0.1:80/',
    }), { baseURL: 'http://127.0.0.1:80', port: '80' });
    assert.throws(() => resolveWebttyBoxEndpoint({
        baseURL: 'http://localhost:8080', boxBaseURL: 'http://127.0.0.1:18080',
    }), /same loopback Router host port/);
    assert.throws(() => resolveWebttyBoxEndpoint({ baseURL: 'http://localhost:8080' }), /SMOKE_BOX_BASE_URL/);
});

test('WebTTY endpoint binding rejects remote, ambiguous, credential-bearing, and non-origin URLs', () => {
    const invalid = [
        'https://127.0.0.1:8080', 'http://0.0.0.0:8080', 'http://remote.example:8080',
        'http://127.1:8080', 'http://2130706433:8080', 'http://127.0.0.1:8080/..',
        'http://127.0.0.1:8080/path', 'http://user@127.0.0.1:8080',
        'http://127.0.0.1:8080?x=1', 'http://127.0.0.1:8080#fragment',
        'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:08080',
    ];
    for (const value of invalid) {
        assert.throws(() => resolveWebttyBoxEndpoint({
            baseURL: value, boxBaseURL: 'http://127.0.0.1:8080',
        }), /WebTTY/);
        assert.throws(() => resolveWebttyBoxEndpoint({
            baseURL: 'http://localhost:8080', boxBaseURL: value,
        }), /WebTTY/);
    }
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-runtime-evidence-')));
  fs.mkdirSync(path.join(root, 'project', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ploinky', 'isolated'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    selected: path.join(root, 'project', 'nested'),
  };
}

function bind(source, destination, rw = true) {
  return { Type: 'bind', Source: source, Destination: destination, RW: rw };
}

test('independent evidence derives global and read-only folder mappings', (t) => {
  const { root, selected } = fixture(t);
  assert.deepEqual(
    independentlyTranslateMount(selected, [bind(root, root)], root),
    { translatedCwd: path.join(root, 'project/nested'), access: 'rw' },
  );
  assert.deepEqual(
    independentlyTranslateMount(selected, [
      bind(root, root),
      bind(path.join(root, 'project'), '/project-data', false),
    ], root),
    { translatedCwd: '/project-data/nested', access: 'ro' },
  );
});

test('independent evidence excludes isolated, ambiguous, and shadowed mounts', (t) => {
  const { root, selected } = fixture(t);
  assert.equal(
    independentlyTranslateMount(selected, [bind(path.join(root, '.ploinky/isolated'), '/root')], root),
    null,
  );
  assert.equal(
    independentlyTranslateMount(selected, [
      bind(root, '/workspace-a'),
      bind(root, '/workspace-b'),
    ], root),
    null,
  );
  assert.equal(
    independentlyTranslateMount(selected, [
      bind(root, root),
      { Type: 'volume', Source: 'shadow', Destination: path.join(root, 'project'), RW: true },
    ], root),
    null,
  );
});

test('workspace ownership hash is bound to the canonical workspace path', (t) => {
  const { root } = fixture(t);
  assert.match(workspaceHash(fs.realpathSync(root)), /^[a-f0-9]{12}$/);
  assert.notEqual(
    workspaceHash(fs.realpathSync(root)),
    workspaceHash(path.join(fs.realpathSync(root), 'different')),
  );
});

test('independent mount evidence rejects legacy aliases, sibling paths and symlink escapes', (t) => {
  const { root, selected } = fixture(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-foreign-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const alias = path.join(root, 'foreign-link');
  fs.symlinkSync(outside, alias, 'dir');
  for (const source of ['/workspace', `${root}-sibling`, alias]) {
    assert.equal(independentlyTranslateMount(selected, [bind(source, root)], root), null);
  }
});

test('runtime evidence rejects an aliased, foreign or read-only outer workspace before agent inspection', (t) => {
  const { root, selected } = fixture(t);
  for (const patch of [
    { destination: '/workspace' },
    { source: '/foreign/workspace' },
    { readWrite: false },
    { type: 'volume' },
  ]) {
    assert.throws(() => collectWebttyRuntimeEvidence({
      baseURL: 'http://127.0.0.1:8080', workspaceRoot: root, selectedDirectory: selected,
      command() { assert.fail('unproven outer workspace must never reach agent inspection'); },
      collectLiveBox: () => ({
        box: { containerId: OUTER_ID },
        workspaceSourceMount: { type: 'bind', source: root, destination: root, readWrite: true, ...patch },
      }),
    }), /exact writable same-path workspace bind/);
  }
});

test('runtime evidence binds an immutable prebuilt Box to explicit identity, image, and source pins', (t) => {
  const { root, selected } = fixture(t);
  fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({ _config: {} }));
  const expectedPloinkySource = fs.realpathSync(root);
  let received = null;
  const evidence = collectWebttyRuntimeEvidence({
    baseURL: 'http://localhost:8080',
    boxBaseURL: 'http://127.0.0.1:8080',
    workspaceRoot: root,
    selectedDirectory: selected,
    expectedContainerName: 'ploinky-box-release-audit',
    expectedImageId: `sha256:${'c'.repeat(64)}`,
    expectedImageRef: 'docker.io/assistos/ploinky-box:immutable-candidate',
    expectedPloinkySource,
    requireFreshImage: false,
    command: () => {
      throw new Error('the injected Box collector must own outer runtime commands');
    },
    collectLiveBox(options) {
      received = options;
      return {
        box: { containerId: OUTER_ID },
        workspaceSourceMount: {
          type: 'bind',
          source: root,
          destination: root,
          readWrite: true,
        },
      };
    },
  });
  assert.equal(evidence.outerContainerId, OUTER_ID);
  assert.deepEqual(received, {
    baseURL: 'http://127.0.0.1:8080',
    expectedContainerName: 'ploinky-box-release-audit',
    expectedImageId: `sha256:${'c'.repeat(64)}`,
    expectedImageRef: 'docker.io/assistos/ploinky-box:immutable-candidate',
    expectedPloinkySource,
    expectedWorkspaceSource: expectedPloinkySource,
    requireFreshImage: false,
    command: received.command,
  });
  assert.equal(typeof received.command, 'function');
  assert.equal(evidence.workspaceRoot, root);
  assert.equal(evidence.workspaceHash, workspaceHash(root));
  assert.notEqual(evidence.workspaceHash, workspaceHash('/workspace'));
});

test('runtime proof refuses a different Box port before filesystem or container inspection', () => {
    assert.throws(() => collectWebttyRuntimeEvidence({
        baseURL: 'http://localhost:8080',
        boxBaseURL: 'http://127.0.0.1:18080',
        workspaceRoot: '/nonexistent-webtty-workspace',
        collectLiveBox() { assert.fail('foreign Box must not be inspected'); },
    }), /same loopback Router host port/);
});

test('collected agent evidence preserves the exact runtime identity required by Router crash recovery', (t) => {
  const { root, selected } = fixture(t);
  fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
    _config: {},
    [AGENT.containerName]: {
      type: 'agent',
      runtime: AGENT.runtime,
      containerId: AGENT.containerId,
      instanceId: AGENT.instanceId,
      enableGeneration: AGENT.enableGeneration,
      repoName: 'AchillesIDE',
      agentName: 'gitAgent',
      runMode: 'global',
    },
  }));
  const evidence = collectWebttyRuntimeEvidence({
    baseURL: 'http://127.0.0.1:8080',
    workspaceRoot: root,
    selectedDirectory: selected,
    expectedContainerName: 'ploinky-box-release-audit',
    expectedImageId: `sha256:${'c'.repeat(64)}`,
    expectedImageRef: 'docker.io/assistos/ploinky-box:immutable-candidate',
    expectedPloinkySource: fs.realpathSync(root),
    requireFreshImage: false,
    command: (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ['exec', OUTER_ID, '/usr/bin/podman']);
      return [{
        Id: AGENT.containerId,
        Name: `/${AGENT.containerName}`,
        State: { Running: true },
        HostConfig: { Init: true },
        Config: {
          User: '1000:1000',
          Hostname: 'git-agent',
          Labels: {
            'io.assistos.ploinky.managed': '1',
            'io.assistos.ploinky.resource': 'agent',
            'io.assistos.ploinky.network-schema': '2',
            'io.assistos.ploinky.workspace': workspaceHash(root),
            'io.assistos.ploinky.network-contract': 'd'.repeat(64),
            'io.assistos.ploinky.instance-id': AGENT.instanceId,
            'io.assistos.ploinky.enable-generation': AGENT.enableGeneration,
          },
        },
        ExecIDs: [],
        Mounts: [bind(root, root)],
      }];
    },
    collectLiveBox: () => ({
      box: { containerId: OUTER_ID },
      workspaceSourceMount: {
        type: 'bind',
        source: root,
        destination: root,
        readWrite: true,
      },
    }),
  });
  const agent = requireAgentEvidence(evidence, 'gitAgent', { eligible: true });
  assert.equal(agent.runtime, 'podman');
  let crashInvocation = null;
  assert.doesNotThrow(() => crashExactRoutingServer(evidence, agent, {
    command: (command, args) => {
      crashInvocation = { command, args };
      return {
        watchdogPid: 40,
        watchdogStartTime: '987650',
        routerPid: 41,
        routerStartTime: '987654',
        recoveryRecord: {
          recordCount: 1,
          targetKind: 'agent',
          ptyState: 'pty-ready',
          matchesExpectedTarget: true,
        },
      };
    },
  }));
  assert.equal(crashInvocation.command, 'podman');
  assert.deepEqual(
    JSON.parse(Buffer.from(crashInvocation.args[11], 'base64url').toString('utf8')),
    AGENT,
  );
});

test('nested inspection accepts only exact immutable-ID not-found as absence', () => {
  assert.equal(inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({
    ok: false,
    status: 125,
    stderr: `Error: no such container ${AGENT_ID}`,
  })), null);
  assert.throws(
    () => inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({
      ok: false,
      status: 126,
      stderr: `Error: no such container "${AGENT_ID}"`,
    })),
    /failed closed/,
  );
  assert.equal(inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({
    ok: false,
    status: 125,
    stderr: `Error: no such container "${AGENT_ID}"\n`,
  })), null);
  assert.throws(
    () => inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({
      ok: false,
      status: 125,
      stderr: `Error: no such container ${OUTER_ID}`,
    })),
    /failed closed/,
  );
  assert.throws(
    () => inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({
      ok: false,
      status: 126,
      stderr: 'Error: permission denied',
    })),
    /failed closed/,
  );
  for (const stderr of [
    `Error: cannot connect while inspecting ${AGENT_ID}: runtime database does not exist`,
    `Error: permission database does not exist for container ${AGENT_ID}`,
    `Error: cannot connect to nested runtime: no such container ${AGENT_ID}`,
    `Error: permission denied; container ${AGENT_ID} does not exist in cached database`,
  ]) {
    assert.throws(
      () => inspectNestedContainer(OUTER_ID, AGENT_ID, () => ({ ok: false, status: 125, stderr })),
      /failed closed/,
    );
  }
});

test('agent process evidence uses the exact PID namespace without requiring nested cgroups', () => {
  const pidNamespace = 'pid:[4026533001]';
  const inspected = {
    Id: AGENT_ID,
    State: { Running: true, Pid: 3519, StartedAt: '2026-08-29T10:00:00.123456789Z' },
  };
  const invocations = [];
  const output = collectAgentProcessRows({ outerContainerId: OUTER_ID }, AGENT, {
    command(command, args, options) {
      invocations.push({ command, args, options });
      if (args.includes('--eval')) {
        return {
          containerInit: { pid: 3519, startToken: '1001', pidNamespace },
          rows: [
            {
              pid: 3519,
              ppid: 3516,
              startToken: '1001',
              pidNamespace,
              args: '/run/podman-init -- /Agent/server/AgentEntrypoint.sh',
            },
            {
              pid: 3544,
              ppid: 3519,
              startToken: '1002',
              pidNamespace,
              args: '/bin/sh /Agent/server/AgentEntrypoint.sh',
            },
            {
              pid: 3667,
              ppid: 1,
              startToken: '1003',
              pidNamespace,
              args: 'node /Agent/server/AgentServer.mjs ploinky-webtty-marker:abcdefghijklmnopqrstuvwx',
            },
          ],
        };
      }
      return [inspected];
    },
  });
  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations[0].args, [
    'exec', OUTER_ID,
    '/usr/bin/podman', 'container', 'inspect', AGENT_ID,
  ]);
  assert.equal(invocations[1].command, 'podman');
  assert.deepEqual(invocations[1].args.slice(0, 5), [
    'exec', OUTER_ID,
    '/usr/local/bin/node', '--input-type=module', '--eval',
  ]);
  assert.doesNotMatch(invocations[1].args.join(' '), /\/usr\/bin\/podman top/);
  assert.match(invocations[1].args[5], /\/ns\/pid/);
  assert.match(invocations[1].args[5], /startToken/);
  assert.match(invocations[1].args[5], /ENOENT.*ESRCH/s);
  assert.equal(invocations[1].args.at(-1), '3519');
  assert.deepEqual(invocations[1].options, { json: true });
  assert.deepEqual(invocations[2].args, invocations[0].args);
  assert.equal(output.length, 3);
  assert.match(output[2], /ploinky-webtty-marker:abcdefghijklmnopqrstuvwx/);
});

test('agent process evidence rejects foreign namespaces and init-PID replacement', () => {
  const pidNamespace = 'pid:[4026533001]';
  const inspected = {
    Id: AGENT_ID,
    State: { Running: true, Pid: 3519, StartedAt: '2026-08-29T10:00:00.123456789Z' },
  };
  assert.throws(
    () => collectAgentProcessRows({ outerContainerId: OUTER_ID }, AGENT, {
      command(_command, args) {
        if (args.includes('--eval')) {
          return {
            containerInit: { pid: 3519, startToken: '1001', pidNamespace },
            rows: [
              {
                pid: 3519,
                ppid: 3516,
                startToken: '1001',
                pidNamespace,
                args: 'init',
              },
              {
                pid: 9999,
                ppid: 1,
                startToken: '2001',
                pidNamespace: 'pid:[4026533999]',
                args: 'foreign',
              },
            ],
          };
        }
        return [inspected];
      },
    }),
    /invalid row/,
  );

  let inspections = 0;
  assert.throws(
    () => collectAgentProcessRows({ outerContainerId: OUTER_ID }, AGENT, {
      command(_command, args) {
        if (args.includes('--eval')) {
          return {
            containerInit: { pid: 3519, startToken: '1001', pidNamespace },
            rows: [{
              pid: 3519,
              ppid: 3516,
              startToken: '1001',
              pidNamespace,
              args: 'init',
            }],
          };
        }
        inspections += 1;
        return inspections === 1
          ? [inspected]
          : [{
            ...inspected,
            State: {
              Running: true,
              Pid: 3519,
              StartedAt: '2026-08-29T10:00:01.123456789Z',
            },
          }];
      },
    }),
    /changed during its process snapshot/,
  );
});

test('nested event audit binds exact cursors and immutable target identity without a sampling gap', () => {
  const evidence = { outerContainerId: OUTER_ID };
  const since = '2026-08-28T10:00:00.000Z';
  const until = '2026-08-28T10:00:01.000Z';
  assert.equal(captureNestedPodmanEventCursor(evidence, {
    command(command, args) {
      assert.equal(command, 'podman');
      assert.deepEqual(args, [
        'exec', OUTER_ID,
        '/usr/local/bin/node', '--eval', 'process.stdout.write(new Date().toISOString())',
      ]);
      return since;
    },
  }), since);

  let invocation = null;
  const events = collectNestedContainerEvents(evidence, AGENT, {
    since,
    until,
    command(command, args) {
      invocation = { command, args };
      return `${JSON.stringify({
        ID: AGENT_ID,
        Type: 'container',
        Status: 'exec',
        time: 1_787_900_000,
        timeNano: 1_787_900_000_100_000_000,
        Attributes: {},
      })}\n${JSON.stringify({
        ID: AGENT_ID,
        Type: 'container',
        Status: 'exec_died',
        time: 1_787_900_000,
        timeNano: 1_787_900_000_200_000_000,
        Attributes: { execID: 'c'.repeat(64) },
      })}\n`;
    },
  });
  assert.deepEqual(events.map((event) => event.status), ['exec', 'exec_died']);
  assert.equal(invocation.command, 'podman');
  assert.deepEqual(invocation.args, [
    'exec', OUTER_ID,
    '/usr/bin/podman', 'events',
    '--stream=false', '--no-trunc=true',
    '--since', since, '--until', until,
    '--filter', `container=${AGENT_ID}`,
    '--format', 'json',
  ]);
  assert.throws(
    () => collectNestedContainerEvents(evidence, AGENT, {
      since,
      until,
      command: () => JSON.stringify({
        ID: OUTER_ID,
        Type: 'container',
        Status: 'exec',
        time: 1,
        timeNano: 1,
      }),
    }),
    /invalid or foreign event/,
  );
});

test('RoutingServer crash is issued only inside the exact live Box and requires process evidence', () => {
  let invocation = null;
  const result = crashExactRoutingServer(ROUTER_EVIDENCE, AGENT, {
    command(command, args, options) {
      invocation = { command, args, options };
      return {
        watchdogPid: 40,
        watchdogStartTime: '987650',
        routerPid: 41,
        routerStartTime: '987654',
        recoveryRecord: {
          recordCount: 1,
          targetKind: 'agent',
          ptyState: 'pty-ready',
          matchesExpectedTarget: true,
        },
      };
    },
  });
  assert.deepEqual(result, {
    watchdogPid: 40,
    watchdogStartTime: '987650',
    routerPid: 41,
    routerStartTime: '987654',
    recoveryRecord: {
      recordCount: 1,
      targetKind: 'agent',
      ptyState: 'pty-ready',
      matchesExpectedTarget: true,
    },
  });
  assert.equal(invocation.command, 'podman');
  assert.deepEqual(invocation.args.slice(0, 8), [
    'exec', '--user', 'podman', '--workdir', ROUTER_EVIDENCE.workspaceRoot, OUTER_ID, '/usr/local/bin/node', '--input-type=module',
  ]);
  assert.equal(invocation.args[8], '--eval');
  assert.match(invocation.args[9], /process\.kill\(revalidated\.router\.pid, 'SIGKILL'\)/);
  assert.equal(invocation.args[10], ROUTER_EVIDENCE.workspaceRoot);
  assert.deepEqual(JSON.parse(Buffer.from(invocation.args[11], 'base64url').toString('utf8')), AGENT);
  assert.deepEqual(invocation.options, { json: true });

  assert.throws(
    () => crashExactRoutingServer(ROUTER_EVIDENCE, AGENT, {
      command: () => ({ routerPid: 0, routerStartTime: '' }),
    }),
    /exact process identity evidence/,
  );
  assert.throws(
    () => crashExactRoutingServer({ outerContainerId: 'short' }, AGENT, { command: () => ({}) }),
    /Exact live Box identity/,
  );

  const observed = collectExactRoutingServerIdentity(ROUTER_EVIDENCE, {
    command: (_command, args) => {
      assert.doesNotMatch(args[9], /process\.kill/);
      assert.equal(args[10], ROUTER_EVIDENCE.workspaceRoot);
      return {
        watchdogPid: 40,
        watchdogStartTime: '987650',
        routerPid: 42,
        routerStartTime: '987655',
      };
    },
  });
  assert.deepEqual(observed, {
    watchdogPid: 40,
    watchdogStartTime: '987650',
    routerPid: 42,
    routerStartTime: '987655',
  });

  assert.deepEqual(collectWebttyRecoveryDirectoryState(ROUTER_EVIDENCE, {
    command: () => ({ recordCount: 0, temporaryCount: 0, otherCount: 0 }),
  }), { recordCount: 0, temporaryCount: 0, otherCount: 0 });
});

test('Router recovery refuses missing or mismatched workspace proof before running a command', () => {
  for (const evidence of [
    { outerContainerId: OUTER_ID },
    { ...ROUTER_EVIDENCE, workspaceRoot: 'relative' },
    { ...ROUTER_EVIDENCE, workspaceRoot: '/srv/foreign' },
    { ...ROUTER_EVIDENCE, workspaceHash: workspaceHash('/workspace') },
  ]) {
    const options = { command() { assert.fail('invalid workspace proof must not execute'); } };
    assert.throws(() => collectExactRoutingServerIdentity(evidence, options), /workspace/);
    assert.throws(() => crashExactRoutingServer(evidence, AGENT, options), /workspace/);
    assert.throws(() => collectWebttyRecoveryDirectoryState(evidence, options), /workspace/);
  }
});

test('actual Router observer script reads only the proved same-path pid file and rejects foreign Box environment', (t) => {
  const { root } = fixture(t);
  const evidence = { outerContainerId: OUTER_ID, workspaceRoot: root, workspaceHash: workspaceHash(root) };
  let invocation;
  collectExactRoutingServerIdentity(evidence, {
    command(_command, args) {
      invocation = args;
      return { watchdogPid: 40, watchdogStartTime: '987650', routerPid: 41, routerStartTime: '987654' };
    },
  });
  const run = workspaceRoot => spawnSync(process.execPath,
    ['--input-type=module', '--eval', invocation[9], invocation[10]], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspaceRoot },
    });
  const absent = run(root);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /ENOENT/);
  assert.ok(absent.stderr.includes(path.join(root, '.ploinky', 'running', 'router.pid')));
  const foreign = run('/foreign/workspace');
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /Box workspace identity mismatch/);
  assert.doesNotMatch(foreign.stderr, /ENOENT/);
});
