import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { activeRuntimeProbe, collectLocalSnapshotSourceBindings, inside, overlaps } from './local-snapshot-bindings.mjs';

const hash = character => character.repeat(64);
const bind = (Source, Destination, RW = false) => ({ Type: 'bind', Source, Destination, RW });

// The Box mounts the workspace at its own host path, so every runtime path below is the host path itself.
function fixture(t, prefix = 'snapshot-bindings-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositories = {
    ploinky: { repositoryPath: path.join(root, 'ploinky'), treeSha256: hash('9') },
    achillesAgentLib: { repositoryPath: path.join(root, 'achillesAgentLib'), treeSha256: hash('d') },
  };
  const agentSource = path.join(repositories.ploinky.repositoryPath, 'Agent');
  fs.mkdirSync(path.join(agentSource, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(agentSource, 'index.mjs'), 'verified runtime');
  fs.writeFileSync(path.join(agentSource, 'nested/start.sh'), 'verified executable', { mode: 0o755 });
  fs.mkdirSync(repositories.achillesAgentLib.repositoryPath);
  fs.mkdirSync(path.join(root, '.ploinky/box/dependencies'), { recursive: true });
  const containers = [];
  const active = { generation: `sha256:${hash('1')}`, activationId: 'activation-1', bindings: {} };
  for (const [name, dir] of [['explorer', 'explorer'], ['achillesCLI', 'achilles-cli']]) {
    const repositoryPath = path.join(root, '.ploinky/repos', name);
    const source = path.join(repositoryPath, dir);
    const runtimeSource = source;
    const staging = path.join(root, '.ploinky/container-runtime', name);
    const code = path.join(staging, 'code');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(code, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.mjs'), 'example');
    fs.symlinkSync(`${runtimeSource}/index.mjs`, path.join(code, 'index.mjs'));
    fs.cpSync(agentSource, path.join(staging, 'Agent'), { recursive: true });
    // Production staged node_modules resolves through a separate self mount.
    const dependencies = `${root}/.ploinky/cache/${name}/node_modules`;
    fs.symlinkSync(dependencies, path.join(code, 'node_modules'));
    fs.symlinkSync(dependencies, path.join(staging, 'Agent/node_modules'));
    repositories[name] = { repositoryPath, treeSha256: hash('a') };
    const containerId = hash(name === 'explorer' ? 'b' : 'c');
    const containerName = `repo-${dir}`;
    active.bindings[dir] = {
      route: { repo: name, agent: dir, container: containerName, hostPath: runtimeSource, hasServiceTargets: false },
      record: { type: 'agent', repoName: name, agentName: dir, runtime: 'podman', containerId,
        instanceId: `${dir}-instance`, enableGeneration: `${dir}-enable` },
    };
    containers.push({ id: containerId, running: true, mounts: [
      bind(runtimeSource, runtimeSource),
      bind('/opt/ploinky-agentlib', '/opt/ploinky-agentlib'),
      bind(`${root}/.ploinky/container-runtime/${name}/code`, '/code'),
      bind(`${root}/.ploinky/container-runtime/${name}/Agent`, '/Agent'),
      bind(dependencies, dependencies),
    ] });
  }
  const outerMounts = [
    bind(root, root, true),
    bind(repositories.ploinky.repositoryPath, '/opt/ploinky'),
    bind(repositories.achillesAgentLib.repositoryPath, '/opt/ploinky-agentlib'),
    bind(repositories.achillesAgentLib.repositoryPath, repositories.achillesAgentLib.repositoryPath),
    bind(path.join(root, '.ploinky/box/dependencies'), '/opt/ploinky/node_modules', true),
  ];
  const calls = [];
  let activeReads = 0;
  const options = {
    repositories,
    liveBox: { workspaceSourceMount: { source: root }, box: { containerId: hash('e'), selectedRouterHostPort: '38080', semanticLabels: { mediaHostPort: '37882' } } },
    run: args => {
      calls.push(args);
      if (args[0] === 'container') return JSON.stringify(outerMounts);
      if (args.includes('node')) {
        // The Box loader fails closed unless the exec carries the exact selected physical host ports.
        if (!args.includes('PLOINKY_ROUTER_HOST_PORT=38080') || !args.includes('PLOINKY_MEDIA_HOST_PORT=37882')
            || args.indexOf('--env') > args.indexOf(hash('e'))) {
          throw new Error('active edge routing generation was compiled for a different physical Router host port; coordinated apply is required');
        }
        activeReads++;
        return JSON.stringify(options.onActiveRead?.(activeReads, active) || active);
      }
      if (args.includes('ps')) return containers.map(row => row.id).join('\n');
      return containers.map(row => JSON.stringify(row)).join('\n');
    },
  };
  return { options, containers, active, outerMounts, root, agentSource, calls };
}

function collect(fixture) { return collectLocalSnapshotSourceBindings(fixture.options); }

// All inspection commands are replaced by deterministic read-only responses;
// these tests never contact a live Box or mutate a deployment.
test('snapshot binds the verified active route, exact container, shared library and copied Agent bytes', t => {
  const f = fixture(t);
  const result = collect(f);
  assert.equal(result.explorer.active, true);
  assert.equal(result.explorer.containerId, hash('b'));
  assert.equal(result.explorer.instanceId, 'explorer-instance');
  assert.equal(result.explorer.enableGeneration, 'explorer-enable');
  assert.equal(result.achillesCLI.treeSha256, hash('a'));
  assert.equal(result.ploinkyAgent.source, f.agentSource);
  assert.equal(result.ploinkyAgent.runtimeSource, '/Agent');
  assert.match(result.ploinkyAgent.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.achillesAgentLib.runtimeSource, '/opt/ploinky-agentlib');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.values(result).every(Object.isFrozen), true);
  assert.equal('generation' in result, false);
  const probes = f.calls.filter(args => args.includes('node'));
  assert.equal(probes.length, 2);
  // The admitted root reaches the in-Box probe as one JSON string literal, never as the retired /workspace alias.
  assert.ok(probes[0].at(-1).includes(`const workspaceRoot = ${JSON.stringify(f.root)};`));
  assert.match(probes[0].at(-1), /loadActiveEdgeRoutingGeneration\(\{ workspaceRoot \}\)/);
  assert.doesNotMatch(probes[0].at(-1), /'\/workspace'/);
  assert.doesNotMatch(probes[0].at(-1), /JSON\.stringify\(generation\)/);
});

test('primary: a canonical same-path workspace containing a space and Unicode is accepted end to end', t => {
  const f = fixture(t, 'fresh workspace ü ');
  assert.match(f.root, / ü /);
  const result = collect(f);
  assert.equal(result.explorer.active, true);
  assert.equal(result.explorer.runtimeSource, path.join(f.root, '.ploinky/repos/explorer/explorer'));
  assert.equal(result.explorer.codeRoot, path.join(f.root, '.ploinky/container-runtime/explorer/code'));
  assert.equal(result.achillesAgentLib.source, path.join(f.root, 'achillesAgentLib'));
});

test('the active-generation probe carries the exact selected Router and media host ports verified in the live Box', t => {
  const f = fixture(t);
  collect(f);
  const probes = f.calls.filter(args => args.includes('node'));
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.deepEqual(probe.slice(0, 5), ['exec', '--env', 'PLOINKY_ROUTER_HOST_PORT=38080', '--env', 'PLOINKY_MEDIA_HOST_PORT=37882']);
    assert.equal(probe[5], hash('e'));
    assert.deepEqual(probe.slice(6, 9), ['node', '--input-type=module', '-e']);
  }
});

test('a probe without the selected port environment is rejected by the Box loader and never yields evidence', t => {
  // Reproduces the original defect: a bare `podman exec` resolves the default ports and the loader fails closed.
  const f = fixture(t);
  const inner = f.options.run;
  f.options.run = args => inner(args.includes('node') ? args.filter(token => token !== '--env' && !token.startsWith('PLOINKY_')) : args);
  assert.throws(() => collect(f), /different physical Router host port/);
});

for (const [label, box] of [
  ['missing router port', { containerId: hash('e'), semanticLabels: { mediaHostPort: '37882' } }],
  ['missing media port label', { containerId: hash('e'), selectedRouterHostPort: '38080', semanticLabels: {} }],
  ['non-numeric router port', { containerId: hash('e'), selectedRouterHostPort: '38080;rm', semanticLabels: { mediaHostPort: '37882' } }],
  ['out-of-range media port', { containerId: hash('e'), selectedRouterHostPort: '38080', semanticLabels: { mediaHostPort: '65536' } }],
]) {
  test(`selected host ports are required before inspection: ${label}`, t => {
    const f = fixture(t);
    f.options.liveBox = { ...f.options.liveBox, box };
    assert.throws(() => collect(f), /exact selected Router and media host ports/);
    assert.equal(f.calls.length, 0);
  });
}

test('the active container wins even when an unrelated running container mounts the same source', t => {
  const f = fixture(t);
  f.containers.push({ ...f.containers[0], id: hash('f') });
  assert.equal(collect(f).explorer.containerId, hash('b'));
  f.active.bindings.explorer.record.containerId = hash('8');
  assert.throws(() => collect(f), /active container is not running/);
});

test('the shipped Explorer repository-parent self mount preserves the verified source', t => {
  const f = fixture(t);
  const mount = bind(`${f.root}/.ploinky/repos`, `${f.root}/.ploinky/repos`, true);
  f.containers[0].mounts.push(mount);
  assert.equal(collect(f).explorer.active, true);
  mount.Source = `${f.root}/other-repos`;
  assert.throws(() => collect(f), /mount shadowing/);
});

test('a global CLI workspace self mount preserves its exact source binding', t => {
  const f = fixture(t);
  f.containers[1].mounts.push(bind(f.root, f.root, true));
  assert.equal(collect(f).achillesCLI.active, true);
  f.containers[1].mounts.at(-1).Source = `${f.root}-other`;
  assert.throws(() => collect(f), /mount shadowing/);
});

test('prepared dependency mount must be read-only and cannot contain shadow mounts', t => {
  const f = fixture(t);
  const dependency = f.containers[0].mounts[4];
  dependency.RW = true;
  assert.throws(() => collect(f), /exact verified read-only/);
  dependency.RW = false;
  f.containers[0].mounts.push(bind(`${f.root}/other`, `${dependency.Destination}/package.mjs`));
  assert.throws(() => collect(f), /mount shadowing/);
});

for (const [label, mutate] of [
  ['wrong host source', f => { f.active.bindings.explorer.route.hostPath = `${f.root}/other/explorer`; }],
  ['wrong captured repo', f => { f.active.bindings.explorer.record.repoName = 'other'; }],
  ['wrong captured agent', f => { f.active.bindings.explorer.record.agentName = 'other'; }],
  ['wrong alias', f => { f.active.bindings.explorer.record.alias = 'other'; }],
  ['missing instance', f => { delete f.active.bindings.explorer.record.instanceId; }],
  ['missing enable generation', f => { delete f.active.bindings.explorer.record.enableGeneration; }],
  ['invalid captured container', f => { f.active.bindings.explorer.record.containerId = 'short'; }],
  ['draining route', f => { f.active.bindings.explorer.route.draining = true; }],
]) {
  test(`active runtime binding rejects ${label}`, t => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  });
}

test('inactive CLI is allowed only in preflight, has immutable source identity and no container fields', t => {
  const f = fixture(t);
  f.active.bindings['achilles-cli'] = null;
  f.containers.pop();
  assert.throws(() => collect(f), /achillesCLI requires an active/);
  f.options.requireActiveAchillesCLI = false;
  const inactive = collect(f);
  assert.deepEqual(Object.keys(inactive.achillesCLI).sort(), ['active', 'runtimeSource', 'source', 'treeSha256']);
  assert.equal(inactive.achillesCLI.active, false);
  assert.equal(Object.isFrozen(inactive.achillesCLI), true);
  f.active.bindings.explorer = null;
  assert.throws(() => collect(f), /explorer requires an active/);
});

test('an active CLI is verified even when preflight permits an inactive CLI', t => {
  const f = fixture(t);
  f.options.requireActiveAchillesCLI = false;
  f.containers[1].running = false;
  assert.throws(() => collect(f), /achillesCLI active container is not running/);
});

test('targetless CLI preparation is inactive only for preflight and never hides an admitted mismatch', t => {
  const f = fixture(t);
  const cli = f.active.bindings['achilles-cli'];
  delete cli.record.containerId;
  delete cli.record.runtime;
  f.options.requireActiveAchillesCLI = false;
  const result = collect(f);
  assert.deepEqual(Object.keys(result.achillesCLI).sort(), ['active', 'runtimeSource', 'source', 'treeSha256']);
  assert.equal(result.achillesCLI.active, false);
  f.options.requireActiveAchillesCLI = true;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  f.options.requireActiveAchillesCLI = false;
  cli.route.hostPort = 41001;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  delete cli.route.hostPort;
  cli.route.hasServiceTargets = true;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  cli.route.hasServiceTargets = false;
  cli.record.runtime = 'podman';
  cli.record.containerId = hash('7');
  assert.throws(() => collect(f), /active container is not running/);
});

test('CLI lifecycle changes preserve stable source evidence and full Explorer evidence', t => {
  const f = fixture(t);
  const before = collect(f);
  const old = path.join(f.root, '.ploinky/container-runtime/achillesCLI');
  const next = path.join(f.root, '.ploinky/container-runtime/achillesCLI-next');
  fs.renameSync(old, next);
  f.containers[1].mounts.forEach(mount => { mount.Source = mount.Source.replace('/container-runtime/achillesCLI/', '/container-runtime/achillesCLI-next/'); });
  f.containers[1].id = hash('7');
  Object.assign(f.active.bindings['achilles-cli'].record, { containerId: hash('7'), instanceId: 'new-instance', enableGeneration: 'new-enable' });
  f.active.generation = `sha256:${hash('2')}`;
  f.active.activationId = 'activation-2';
  const after = collect(f);
  for (const key of ['source', 'runtimeSource', 'treeSha256']) assert.equal(after.achillesCLI[key], before.achillesCLI[key]);
  assert.notEqual(after.achillesCLI.containerId, before.achillesCLI.containerId);
  assert.notEqual(after.achillesCLI.codeRoot, before.achillesCLI.codeRoot);
  for (const key of ['explorer', 'ploinkyAgent', 'achillesAgentLib']) assert.deepEqual(after[key], before[key]);
});

for (const field of ['generation', 'activationId']) {
  test(`a changed active ${field} during inspection cannot produce mixed evidence`, t => {
    const f = fixture(t);
    f.options.onActiveRead = (number, active) => number === 2 ? { ...active, [field]: field === 'generation' ? `sha256:${hash('2')}` : 'new-activation' } : active;
    assert.throws(() => collect(f), /active routing generation changed/);
  });
}

for (const relative of ['/code/index.mjs', '/code/node_modules', '/Agent/index.mjs', '/Agent/node_modules', '/opt', '/opt/ploinky-agentlib/lib.mjs', '<root>/.ploinky/repos/explorer', '<root>/.ploinky/repos/explorer/explorer/index.mjs']) {
  test(`inner mount shadow is rejected at ${relative}`, t => {
    const f = fixture(t);
    const destination = relative.replace('<root>', f.root);
    f.containers[0].mounts.push(bind(`${f.root}/substitute`, destination));
    assert.throws(() => collect(f), /mount shadowing/);
  });
}

for (const relative of ['/opt', '/opt/ploinky/cli', '/opt/ploinky/Agent/index.mjs', '/opt/ploinky/node_modules/extra', '<root>/.ploinky', '<root>/.ploinky/repos/explorer/explorer/index.mjs', '<root>/.ploinky/container-runtime/explorer/Agent/index.mjs']) {
  test(`outer mount shadow is rejected at ${relative}`, t => {
    const f = fixture(t);
    const destination = relative.replace('<root>', f.root);
    // A foreign source shadows the verified path; the workspace source itself is covered by the alias test below.
    f.outerMounts.push(bind(`${f.root}-foreign`, destination));
    assert.throws(() => collect(f), /mount shadowing/);
  });

  test(`an outer alias of the workspace source at ${relative} is rejected`, t => {
    const f = fixture(t);
    f.outerMounts.push(bind(f.root, relative.replace('<root>', f.root)));
    assert.throws(() => collect(f), /another alias of its workspace source/);
  });
}

for (const [label, mutate] of [
  ['stale copied bytes', agent => fs.writeFileSync(path.join(agent, 'index.mjs'), 'old runtime')],
  ['missing runtime file', agent => fs.unlinkSync(path.join(agent, 'index.mjs'))],
  ['extra runtime file', agent => fs.writeFileSync(path.join(agent, 'extra.mjs'), 'unverified')],
  ['changed executable bit', agent => fs.chmodSync(path.join(agent, 'nested/start.sh'), 0o644)],
  ['changed entry type', agent => { fs.unlinkSync(path.join(agent, 'index.mjs')); fs.symlinkSync('/other/index.mjs', path.join(agent, 'index.mjs')); }],
  ['nested node_modules content', agent => { fs.mkdirSync(path.join(agent, 'nested/node_modules')); fs.writeFileSync(path.join(agent, 'nested/node_modules/extra.mjs'), 'unverified'); }],
]) {
  test(`/Agent byte proof rejects ${label}`, t => {
    const f = fixture(t);
    mutate(path.join(f.root, '.ploinky/container-runtime/explorer/Agent'));
    assert.throws(() => collect(f), /staged \/Agent differs/);
  });
}

test('root node_modules is excluded from the Agent copy proof', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.agentSource, 'node_modules'));
  fs.writeFileSync(path.join(f.agentSource, 'node_modules/dependency.mjs'), 'not copied');
  assert.equal(collect(f).explorer.active, true);
});

test('missing /Agent mount, writable AgentLib, and substituted code are rejected', t => {
  const f = fixture(t);
  const mount = f.containers[0].mounts.splice(3, 1)[0];
  assert.throws(() => collect(f), /unverified runtime mount at \/Agent/);
  f.containers[0].mounts.push(mount);
  f.outerMounts[2].RW = true;
  assert.throws(() => collect(f), /exact verified read-only/);
  f.outerMounts[2].RW = false;
  const code = path.join(f.root, '.ploinky/container-runtime/explorer/code/index.mjs');
  fs.unlinkSync(code);
  fs.writeFileSync(code, 'substitute');
  assert.throws(() => collect(f), /not linked to the verified source/);
});

test('a same-commit alternate mount and a symlinked staging directory are rejected', t => {
  const f = fixture(t);
  f.containers[0].mounts[0].Source = `${f.root}/other/explorer`;
  assert.throws(() => collect(f), /exact verified source mount/);
  f.containers[0].mounts[0].Source = f.containers[0].mounts[0].Destination;
  const stage = path.join(f.root, '.ploinky/container-runtime/explorer/Agent');
  fs.renameSync(stage, `${stage}-other`);
  fs.symlinkSync(`${stage}-other`, stage);
  assert.throws(() => collect(f), /runtime staging is not a real workspace directory/);
});

// ---------------------------------------------------------------------------------------------------------
// Same-path workspace policy: exact outer root, strict nested mounts, lexical and canonical containment.
// ---------------------------------------------------------------------------------------------------------
for (const [name, mutate, message] of [
  ['a retired /workspace alias', f => { f.outerMounts[0] = bind(f.root, '/workspace', true); }, /exactly one .* source mount/],
  ['a missing root bind', f => { f.outerMounts.splice(0, 1); }, /exactly one .* source mount/],
  ['a duplicate root bind', f => { f.outerMounts.push(bind(f.root, f.root, true)); }, /exactly one .* source mount/],
  ['a read-only root bind', f => { f.outerMounts[0].RW = false; }, /writable bind/],
  ['a root bind sourced from a prefix-lookalike directory', f => { f.outerMounts[0].Source = `${f.root}-evil`; }, /source does not equal its destination/],
  ['a second alias of the workspace source', f => { f.outerMounts.push(bind(f.root, '/srv/alias', true)); }, /another alias of its workspace source/],
  ['a volume instead of a bind', f => { f.outerMounts[0].Type = 'volume'; }, /absolute writable bind/],
]) {
  test(`the exact outer root proof rejects ${name}`, t => {
    const f = fixture(t, 'fresh workspace ü ');
    mutate(f);
    assert.throws(() => collect(f), message);
  });
}

test('an unclean admitted root is rejected before any inspection command runs', t => {
  for (const prefix of ['fresh:workspace ', 'fresh\nworkspace ', 'fresh\\workspace ']) {
    const f = fixture(t, prefix);
    assert.throws(() => collect(f), /clean absolute host path/, JSON.stringify(prefix));
    assert.equal(f.calls.length, 0);
  }
});

test('verified sources must lie inside the admitted root, lexically and canonically', t => {
  const f = fixture(t, 'fresh workspace ü ');
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'explorer'));
  const repository = f.options.repositories.explorer.repositoryPath;
  const original = repository;
  // A prefix-lookalike sibling of the root is not inside it.
  const lookalike = `${f.root}-evil/explorer-repo`;
  fs.mkdirSync(path.join(lookalike, 'explorer'), { recursive: true });
  t.after(() => fs.rmSync(`${f.root}-evil`, { recursive: true, force: true }));
  f.options.repositories.explorer.repositoryPath = lookalike;
  assert.throws(() => collect(f), /outside the inspected workspace/);
  f.options.repositories.explorer.repositoryPath = outside;
  assert.throws(() => collect(f), /outside the inspected workspace/);
  // A source directory that is a symlink to an outside tree resolves outside the root.
  fs.rmSync(path.join(original, 'explorer'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'explorer'), path.join(original, 'explorer'));
  f.options.repositories.explorer.repositoryPath = original;
  assert.throws(() => collect(f), /outside the inspected workspace/);
  // The AgentLib source follows the same rule.
  const g = fixture(t, 'fresh workspace ü ');
  g.options.repositories.achillesAgentLib.repositoryPath = outside;
  g.outerMounts[2].Source = outside;
  assert.throws(() => collect(g), /outside the inspected workspace/);
});

for (const [name, mutate, message] of [
  ['a /code staged outside the admitted root', f => { f.containers[0].mounts[2].Source = `${f.root}-evil/.ploinky/container-runtime/explorer/code`; }, /unverified runtime mount at \/code/],
  ['a /code outside the container-runtime staging root', f => { f.containers[0].mounts[2].Source = `${f.root}/.ploinky/other/code`; }, /unverified runtime mount at \/code/],
  ['an /Agent staged outside the admitted root', f => { f.containers[0].mounts[3].Source = `${f.root}-evil/.ploinky/container-runtime/explorer/Agent`; }, /unverified runtime mount at \/Agent/],
  ['a duplicated source bind', f => { f.containers[0].mounts.push(structuredClone(f.containers[0].mounts[0])); }, /exact verified source mount/],
  ['a source bind sourced from a foreign directory', f => { f.containers[0].mounts[0].Source = `${f.root}-evil/explorer`; }, /exact verified source mount/],
  ['a foreign source mounted at /code', f => { f.containers[0].mounts.push(bind(`${f.root}/foreign`, '/code')); }, /unverified runtime mount at \/code/],
  ['a dependency tree outside the admitted root', f => { fs.rmSync(path.join(f.root, '.ploinky/container-runtime/explorer/code/node_modules')); fs.symlinkSync(`${f.root}-evil/.ploinky/cache/explorer/node_modules`, path.join(f.root, '.ploinky/container-runtime/explorer/code/node_modules')); fs.rmSync(path.join(f.root, '.ploinky/container-runtime/explorer/Agent/node_modules')); fs.symlinkSync(`${f.root}-evil/.ploinky/cache/explorer/node_modules`, path.join(f.root, '.ploinky/container-runtime/explorer/Agent/node_modules')); }, /do not share the prepared workspace dependency tree/],
]) {
  test(`inner mounts reject ${name}`, t => {
    const f = fixture(t, 'fresh workspace ü ');
    mutate(f);
    assert.throws(() => collect(f), message);
  });
}

test('legitimate nested binds are accepted: the read-only controller pin and the controller data guard', t => {
  const f = fixture(t, 'fresh workspace ü ');
  const pin = bind(`${f.root}/.ploinky`, `${f.root}/.ploinky`, false);
  f.containers[0].mounts.push(pin, bind('/tmp/ploinky-runtime-guards/0123456789abcdef01234567/data', `${f.root}/.ploinky/data`, false));
  assert.equal(collect(f).explorer.active, true);
  // The same destinations sourced from anywhere else are hostile shadows of the verified source tree.
  pin.Source = `${f.root}/foreign`;
  assert.throws(() => collect(f), /mount shadowing/);
});

test('root and path helpers treat the filesystem root and prefix-lookalikes exactly', () => {
  assert.equal(inside('/', '/anything'), true);
  assert.equal(inside('/srv/a', '/srv/a'), true);
  assert.equal(inside('/srv/a', '/srv/a/b'), true);
  assert.equal(inside('/srv/a', '/srv/ab'), false);
  assert.equal(overlaps('/', '/srv/a'), true);
  assert.equal(overlaps('/srv/a/b', '/srv/a'), true);
  assert.equal(overlaps('/srv/ab', '/srv/a'), false);
});

for (const root of ["/srv/it's $HOME `x` ${y} \"q\"", '/Volumes/Ünïcode ws/ñ 数据 café', '/srv/fresh workspace']) {
  test(`the in-Box probe carries ${JSON.stringify(root)} as one JSON string literal and parses`, t => {
    const text = activeRuntimeProbe(root);
    assert.ok(text.includes(`const workspaceRoot = ${JSON.stringify(root)};`));
    assert.ok(!text.includes('/workspace'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'probe.mjs');
    fs.writeFileSync(file, text);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  });
}
