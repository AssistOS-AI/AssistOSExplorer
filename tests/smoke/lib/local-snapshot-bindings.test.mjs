import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { activeRuntimeProbe, collectLocalSnapshotSourceBindings, inside, overlaps } from './local-snapshot-bindings.mjs';
import { collectCopilotReleaseEvidence } from './copilot-release-evidence.mjs';

const hash = character => character.repeat(64);
const bind = (Source, Destination, RW = false) => ({ Type: 'bind', Source, Destination, RW });

// The two repository sources Ploinky selects for AchillesIDE: the managed copy, or a checkout directly inside the
// workspace that Ploinky uses in place (here under the folder name of its origin).
const MANAGED = '.ploinky/repos/AchillesIDE';
const CHECKOUT = 'AssistOSExplorer';
// roboTeamAgent/manifest.json declares these link-install repositories; Explorer declares none.
const LINKED = ['AdvancedLanguageAgent', 'DocumentationSkills'];
const MANIFESTS = {
  explorer: { agent: 'node /code/server.mjs' },
  roboTeamAgent: { 'link-install': LINKED.map(name => `https://github.com/AssistOS-AI/${name}.git`) },
};
// Ploinky's ensureRepositoryLink writes each link relative to its runtime parent /Agent/linked.
const ploinkyLink = checkout => path.posix.relative('/Agent/linked', checkout);

// The Box mounts the workspace at its own host path, so every runtime path below is the host path itself.
// Each container carries the mounts Ploinky's agentServiceManager.js emits for a Podman agent: the agent folder
// bound at its own path and directly read-only at /code, the staged /Agent copy, the AgentLib grant, and the prepared
// dependency tree read-only at its own path and over /code/node_modules.
function fixture(t, prefix = 'snapshot-bindings-', { checkout = MANAGED } = {}) {
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
  for (const [name, dir] of [['explorer', 'explorer'], ['roboTeamAgent', 'roboTeamAgent']]) {
    const repositoryPath = path.join(root, checkout);
    const source = path.join(repositoryPath, dir);
    const runtimeSource = source;
    const staging = path.join(root, '.ploinky/container-runtime', name);
    // Ploinky creates the empty /code/node_modules mount point inside the agent source.
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'index.mjs'), 'example');
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(MANIFESTS[name]));
    fs.cpSync(agentSource, path.join(staging, 'Agent'), { recursive: true });
    // RoboTeam's staged copy gains linked/<name> for each link-install checkout, which is bound at its own path.
    const linkedMounts = [];
    if (MANIFESTS[name]['link-install']) {
      fs.mkdirSync(path.join(staging, 'Agent/linked'));
      for (const repo of LINKED) {
        const linkedCheckout = path.join(root, repo);
        fs.mkdirSync(linkedCheckout);
        fs.symlinkSync(ploinkyLink(linkedCheckout), path.join(staging, 'Agent/linked', repo));
        linkedMounts.push(bind(linkedCheckout, linkedCheckout, true));
      }
    }
    const dependencies = `${root}/.ploinky/deps/store/objects/${name}/payload/node_modules`;
    fs.symlinkSync(dependencies, path.join(staging, 'Agent/node_modules'));
    repositories.explorer = { repositoryPath, treeSha256: hash('a') };
    const containerId = hash(name === 'explorer' ? 'b' : 'c');
    const containerName = `repo-${dir}`;
    active.bindings[dir] = {
      route: { repo: 'AchillesIDE', agent: dir, container: containerName, hostPath: runtimeSource, hasServiceTargets: false },
      record: { type: 'agent', repoName: 'AchillesIDE', agentName: dir, runtime: 'podman', containerId,
        instanceId: `${dir}-instance`, enableGeneration: `${dir}-enable` },
    };
    containers.push({ id: containerId, running: true, mounts: [
      bind(runtimeSource, runtimeSource),
      bind('/opt/ploinky-agentlib', '/opt/ploinky-agentlib'),
      bind(runtimeSource, '/code'),
      bind(`${staging}/Agent`, '/Agent'),
      bind(dependencies, dependencies),
      bind(dependencies, '/code/node_modules'),
      ...linkedMounts,
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
  assert.equal(result.roboTeamAgent.treeSha256, hash('a'));
  assert.deepEqual(Object.keys(f.options.repositories).sort(), ['achillesAgentLib', 'explorer', 'ploinky']);
  assert.deepEqual(Object.keys(result).sort(), ['achillesAgentLib', 'explorer', 'ploinkyAgent', 'roboTeamAgent']);
  for (const name of ['explorer', 'roboTeamAgent']) {
    assert.equal(result[name].source, path.join(f.options.repositories.explorer.repositoryPath, name));
    assert.equal(result[name].runtimeSource, result[name].source);
    assert.equal(result[name].treeSha256, f.options.repositories.explorer.treeSha256);
    assert.equal(result[name].routeKey, name);
  }
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
  assert.match(probes[0].at(-1), /\['explorer', 'roboTeamAgent'\]/);
  assert.doesNotMatch(probes[0].at(-1), /achilles-cli|AchillesCLI/);
});

test('release evidence collects real bindings from the three-repository current-owner schema', async t => {
  const f = fixture(t);
  const imageDigest = `sha256:${hash('f')}`;
  const commit = '3'.repeat(40);
  f.options.repositories.achillesAgentLib.commit = commit;
  Object.assign(f.options.liveBox.box, { imageId: imageDigest });
  Object.assign(f.options.liveBox.box.semanticLabels, { agentLibMode: 'local', agentLibCommit: commit });
  f.options.liveBox.ploinkySourceMount = { source: f.options.repositories.ploinky.repositoryPath };
  const source = { verificationMode: 'local-snapshot', imageDigest, repositories: f.options.repositories };
  const options = {
    manifestPath: path.join(f.root, 'snapshot.json'),
    verifierPath: path.join(f.root, 'verifier.mjs'),
    verificationMode: 'local-snapshot',
    baseURL: 'http://127.0.0.1:38080',
    loadVerifier: async () => ({ verifyManifestFile: () => source }),
    collectLiveBox: () => f.options.liveBox,
    collectSnapshotBindings: args => collectLocalSnapshotSourceBindings({ ...args, run: f.options.run }),
  };
  const evidence = await collectCopilotReleaseEvidence(options);
  assert.deepEqual(Object.keys(evidence.repositories).sort(), ['achillesAgentLib', 'explorer', 'ploinky']);
  for (const name of ['explorer', 'roboTeamAgent']) {
    assert.equal(evidence.sourceBindings[name].active, true);
    assert.equal(evidence.sourceBindings[name].source, path.join(source.repositories.explorer.repositoryPath, name));
    assert.equal(evidence.sourceBindings[name].treeSha256, source.repositories.explorer.treeSha256);
  }
  f.active.bindings.roboTeamAgent = null;
  const prepared = await collectCopilotReleaseEvidence({ ...options, requireActiveRoboTeamAgent: false });
  assert.equal(prepared.sourceBindings.roboTeamAgent.active, false);
  await assert.rejects(collectCopilotReleaseEvidence({ ...options, requireActiveRoboTeamAgent: true }), /roboTeamAgent requires an active/);
});

for (const name of ['explorer', 'roboTeamAgent']) {
  for (const owner of ['AchillesCLI', 'explorer', 'other']) {
    test(`${name} rejects mutually consistent routes and records owned by ${owner}`, t => {
      const f = fixture(t);
      f.active.bindings[name].route.repo = owner;
      f.active.bindings[name].record.repoName = owner;
      assert.throws(() => collect(f), /exact active route and captured runtime identity/);
      f.options.requireActiveRoboTeamAgent = false;
      assert.throws(() => collect(f), /exact active route and captured runtime identity/);
    });
  }
}

test('the retired CLI route cannot satisfy active RoboTeam evidence', t => {
  const f = fixture(t);
  f.active.bindings['achilles-cli'] = f.active.bindings.roboTeamAgent;
  delete f.active.bindings.roboTeamAgent;
  assert.throws(() => collect(f), /roboTeamAgent requires an active/);
  f.active.bindings.roboTeamAgent = f.active.bindings['achilles-cli'];
  f.active.bindings.roboTeamAgent.route.agent = 'achilles-cli';
  f.active.bindings.roboTeamAgent.record.agentName = 'achilles-cli';
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
});

test('RoboTeam rejects foreign source mounts, shadows and stale staged bytes', t => {
  const f = fixture(t);
  const source = f.containers[1].mounts[0];
  source.Source = `${f.root}/old/roboTeamAgent`;
  assert.throws(() => collect(f), /exact verified source mount/);
  source.Source = source.Destination;
  f.containers[1].mounts.push(bind(`${f.root}/foreign`, `${source.Destination}/index.mjs`));
  assert.throws(() => collect(f), /mount shadowing/);
  f.containers[1].mounts.pop();
  fs.writeFileSync(path.join(f.root, '.ploinky/container-runtime/roboTeamAgent/Agent/index.mjs'), 'stale');
  assert.throws(() => collect(f), /staged \/Agent differs/);
});

for (const checkout of [MANAGED, CHECKOUT]) {
  test(`primary: a canonical same-path workspace containing a space and Unicode is accepted end to end (${checkout})`, t => {
    const f = fixture(t, 'fresh workspace ü ', { checkout });
    assert.match(f.root, / ü /);
    const result = collect(f);
    for (const name of ['explorer', 'roboTeamAgent']) {
      assert.equal(result[name].active, true);
      assert.equal(result[name].runtimeSource, path.join(f.root, checkout, name));
      // /code is the verified agent folder itself; only /Agent is staged.
      assert.equal(result[name].codeRoot, result[name].runtimeSource);
      assert.equal(result[name].agentRuntimeRoot, path.join(f.root, '.ploinky/container-runtime', name, 'Agent'));
      assert.equal('mappingSha256' in result[name], false);
    }
    assert.equal(result.achillesAgentLib.source, path.join(f.root, 'achillesAgentLib'));
  });
}

// The observed failure: workspace root /home/user, Explorer used in place from /home/user/AssistOSExplorer as
// AchillesIDE. Explorer (the static agent) and global RoboTeam both receive the workspace bind, so Ploinky also emits
// the read-only `<root>/.ploinky` controller pin, the writable `.ploinky/repos` root and the controller data guard.
test('a workspace checkout used in place is accepted with the mounts Ploinky emits beside a workspace bind', t => {
  const f = fixture(t, 'snapshot-bindings-', { checkout: CHECKOUT });
  fs.mkdirSync(path.join(f.root, '.ploinky/repos'), { recursive: true });
  for (const container of f.containers) {
    container.mounts.push(
      bind(f.root, f.root, true),
      bind(`${f.root}/.ploinky`, `${f.root}/.ploinky`),
      bind(`${f.root}/.ploinky/repos`, `${f.root}/.ploinky/repos`, true),
      bind('/tmp/ploinky-runtime-guards/0123456789abcdef01234567/data', `${f.root}/.ploinky/data`),
    );
  }
  const result = collect(f);
  assert.equal(result.explorer.codeRoot, path.join(f.root, 'AssistOSExplorer/explorer'));
  assert.equal(result.roboTeamAgent.codeRoot, path.join(f.root, 'AssistOSExplorer/roboTeamAgent'));
  assert.equal(result.explorer.treeSha256, f.options.repositories.explorer.treeSha256);
  // The pin is accepted only as Ploinky emits it: read-only and backed by the workspace's own controller root.
  const pin = f.containers[0].mounts.find(mount => mount.Destination === `${f.root}/.ploinky`);
  pin.RW = true;
  assert.throws(() => collect(f), /mount shadowing a verified source or runtime/);
  pin.RW = false;
  pin.Source = `${f.root}/foreign`;
  assert.throws(() => collect(f), /mount shadowing a verified source or runtime/);
});

for (const checkout of [MANAGED, CHECKOUT]) {
  for (const [label, codeSource] of [
    ['the retired staged code tree', root => `${root}/.ploinky/container-runtime/explorer/code`],
    ['the unresolved .ploinky/code link', root => `${root}/.ploinky/code/explorer`],
    ['the other repository source', root => `${root}/${checkout === MANAGED ? CHECKOUT : MANAGED}/explorer`],
    ['the checkout root', root => `${root}/${checkout}`],
    ['the sibling agent folder', root => `${root}/${checkout}/roboTeamAgent`],
    ['a folder below the agent source', root => `${root}/${checkout}/explorer/code`],
    ['a prefix-lookalike of the agent source', root => `${root}/${checkout}/explorer-old`],
    ['a source outside the admitted root', root => `${root}-evil/${checkout}/explorer`],
  ]) {
    test(`/code must be the verified agent folder: ${label} is rejected (${checkout})`, t => {
      const f = fixture(t, 'snapshot-bindings-', { checkout });
      f.containers[0].mounts[2].Source = codeSource(f.root);
      assert.throws(() => collect(f), /explorer has an unverified runtime mount at \/code/);
    });
  }

  test(`/code must be one read-only bind of the verified agent folder (${checkout})`, t => {
    const f = fixture(t, 'snapshot-bindings-', { checkout });
    const code = f.containers[0].mounts[2];
    code.RW = true;
    assert.throws(() => collect(f), /exact verified read-only source mount at \/code/);
    code.RW = false;
    code.Type = 'volume';
    assert.throws(() => collect(f), /exact verified read-only source mount at \/code/);
    code.Type = 'bind';
    f.containers[0].mounts.push(structuredClone(code));
    assert.throws(() => collect(f), /unverified runtime mount at \/code/);
    f.containers[0].mounts.pop();
    f.containers[0].mounts.splice(2, 1);
    assert.throws(() => collect(f), /unverified runtime mount at \/code/);
  });
}

for (const [label, checkout, message] of [
  ['nested below a workspace folder', 'work/AssistOSExplorer', /neither a workspace checkout nor the managed repository copy/],
  ['a hidden workspace entry', '.AssistOSExplorer', /neither a workspace checkout nor the managed repository copy/],
  ['the workspace node_modules entry', 'node_modules', /neither a workspace checkout nor the managed repository copy/],
  ['a managed copy of another repository', '.ploinky/repos/OtherIDE', /neither a workspace checkout nor the managed repository copy/],
]) {
  test(`the verified checkout must be a source Ploinky selects: ${label} is rejected`, t => {
    // Route and mounts agree with the checkout, so only its location can reject it.
    const f = fixture(t, 'snapshot-bindings-', { checkout });
    assert.throws(() => collect(f), message);
    assert.equal(f.calls.filter(args => args.includes('podman')).length, 0, 'No nested inspection runs for an unselectable checkout.');
  });
}

test('the verified checkout must hold each agent folder itself, not a link to another workspace tree', t => {
  const f = fixture(t, 'snapshot-bindings-', { checkout: CHECKOUT });
  const source = path.join(f.root, CHECKOUT, 'explorer');
  fs.renameSync(source, path.join(f.root, 'elsewhere'));
  fs.symlinkSync(path.join(f.root, 'elsewhere'), source);
  for (const mount of f.containers[0].mounts) {
    if (mount.Source === source) mount.Source = path.join(f.root, 'elsewhere');
    if (mount.Destination === source) mount.Destination = path.join(f.root, 'elsewhere');
  }
  f.active.bindings.explorer.route.hostPath = path.join(f.root, 'elsewhere');
  assert.throws(() => collect(f), /explorer source is not an agent folder of the verified checkout/);
});

test('/code/node_modules must be the read-only dependency tree the staged /Agent links', t => {
  const f = fixture(t);
  const dependencies = f.containers[0].mounts[5];
  dependencies.RW = true;
  assert.throws(() => collect(f), /exact verified read-only source mount at \/code\/node_modules/);
  dependencies.RW = false;
  dependencies.Source = `${f.root}/.ploinky/deps/store/objects/other/payload/node_modules`;
  assert.throws(() => collect(f), /explorer dependency adapters do not share the prepared workspace dependency tree/);
  f.containers[0].mounts.splice(5, 1);
  assert.throws(() => collect(f), /explorer dependency adapters do not share the prepared workspace dependency tree/);
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

test('a global RoboTeam workspace self mount preserves its exact source binding', t => {
  const f = fixture(t);
  f.containers[1].mounts.push(bind(f.root, f.root, true));
  assert.equal(collect(f).roboTeamAgent.active, true);
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

test('inactive RoboTeam is allowed only in preflight, has immutable source identity and no container fields', t => {
  const f = fixture(t);
  f.active.bindings['roboTeamAgent'] = null;
  f.containers.pop();
  assert.throws(() => collect(f), /roboTeamAgent requires an active/);
  f.options.requireActiveRoboTeamAgent = false;
  const inactive = collect(f);
  assert.deepEqual(Object.keys(inactive.roboTeamAgent).sort(), ['active', 'runtimeSource', 'source', 'treeSha256']);
  assert.equal(inactive.roboTeamAgent.active, false);
  assert.equal(Object.isFrozen(inactive.roboTeamAgent), true);
  f.active.bindings.explorer = null;
  assert.throws(() => collect(f), /explorer requires an active/);
});

test('an active RoboTeam is verified even when preflight permits an inactive CLI', t => {
  const f = fixture(t);
  f.options.requireActiveRoboTeamAgent = false;
  f.containers[1].running = false;
  assert.throws(() => collect(f), /roboTeamAgent active container is not running/);
});

test('targetless RoboTeam preparation is inactive only for preflight and never hides an admitted mismatch', t => {
  const f = fixture(t);
  const roboTeam = f.active.bindings['roboTeamAgent'];
  delete roboTeam.record.containerId;
  delete roboTeam.record.runtime;
  f.options.requireActiveRoboTeamAgent = false;
  const result = collect(f);
  assert.deepEqual(Object.keys(result.roboTeamAgent).sort(), ['active', 'runtimeSource', 'source', 'treeSha256']);
  assert.equal(result.roboTeamAgent.active, false);
  f.options.requireActiveRoboTeamAgent = true;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  f.options.requireActiveRoboTeamAgent = false;
  roboTeam.route.hostPort = 41001;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  delete roboTeam.route.hostPort;
  roboTeam.route.hasServiceTargets = true;
  assert.throws(() => collect(f), /exact active route and captured runtime identity/);
  roboTeam.route.hasServiceTargets = false;
  roboTeam.record.runtime = 'podman';
  roboTeam.record.containerId = hash('7');
  assert.throws(() => collect(f), /active container is not running/);
});

test('RoboTeam lifecycle changes preserve stable source evidence and full Explorer evidence', t => {
  const f = fixture(t);
  const before = collect(f);
  const old = path.join(f.root, '.ploinky/container-runtime/roboTeamAgent');
  const next = path.join(f.root, '.ploinky/container-runtime/roboTeamAgent-next');
  fs.renameSync(old, next);
  f.containers[1].mounts.forEach(mount => { mount.Source = mount.Source.replace('/container-runtime/roboTeamAgent/', '/container-runtime/roboTeamAgent-next/'); });
  f.containers[1].id = hash('7');
  Object.assign(f.active.bindings['roboTeamAgent'].record, { containerId: hash('7'), instanceId: 'new-instance', enableGeneration: 'new-enable' });
  f.active.generation = `sha256:${hash('2')}`;
  f.active.activationId = 'activation-2';
  const after = collect(f);
  for (const key of ['source', 'runtimeSource', 'treeSha256']) assert.equal(after.roboTeamAgent[key], before.roboTeamAgent[key]);
  assert.notEqual(after.roboTeamAgent.containerId, before.roboTeamAgent.containerId);
  // A new container gets a new staged /Agent, while /code stays the verified source folder.
  assert.notEqual(after.roboTeamAgent.agentRuntimeRoot, before.roboTeamAgent.agentRuntimeRoot);
  assert.equal(after.roboTeamAgent.codeRoot, before.roboTeamAgent.codeRoot);
  for (const key of ['explorer', 'ploinkyAgent', 'achillesAgentLib']) assert.deepEqual(after[key], before[key]);
});

for (const field of ['generation', 'activationId']) {
  test(`a changed active ${field} during inspection cannot produce mixed evidence`, t => {
    const f = fixture(t);
    f.options.onActiveRead = (number, active) => number === 2 ? { ...active, [field]: field === 'generation' ? `sha256:${hash('2')}` : 'new-activation' } : active;
    assert.throws(() => collect(f), /active routing generation changed/);
  });
}

for (const relative of ['/code/index.mjs', '/code/node_modules', '/Agent/index.mjs', '/Agent/node_modules', '/opt', '/opt/ploinky-agentlib/lib.mjs', '<root>/.ploinky/repos/AchillesIDE', '<root>/.ploinky/repos/AchillesIDE/explorer/index.mjs']) {
  test(`inner mount shadow is rejected at ${relative}`, t => {
    const f = fixture(t);
    const destination = relative.replace('<root>', f.root);
    f.containers[0].mounts.push(bind(`${f.root}/substitute`, destination));
    assert.throws(() => collect(f), /mount shadowing/);
  });
}

for (const relative of ['/opt', '/opt/ploinky/cli', '/opt/ploinky/Agent/index.mjs', '/opt/ploinky/node_modules/extra', '<root>/.ploinky', '<root>/.ploinky/repos/AchillesIDE/explorer/index.mjs', '<root>/.ploinky/container-runtime/explorer/Agent/index.mjs']) {
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

// ---------------------------------------------------------------------------------------------------------
// link-install: Ploinky adds /Agent/linked/<name> to the staged copy for each repository the agent manifest
// declares, and binds each workspace checkout at its own path. Everything else still matches byte for byte.
// ---------------------------------------------------------------------------------------------------------
const stagedAgent = (f, name = 'roboTeamAgent') => path.join(f.root, '.ploinky/container-runtime', name, 'Agent');
const linkedEntry = (f, repo) => path.join(stagedAgent(f), 'linked', repo);
const checkoutOf = (f, repo) => path.join(f.root, repo);
const relink = (f, repo, text) => {
  fs.rmSync(linkedEntry(f, repo), { recursive: true, force: true });
  fs.symlinkSync(text, linkedEntry(f, repo));
};
const writeManifest = (f, name, manifest) => fs.writeFileSync(
  path.join(f.options.repositories.explorer.repositoryPath, name, 'manifest.json'),
  typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
const checkoutMountIndex = (f, repo) => f.containers[1].mounts.findIndex(mount => mount.Destination === checkoutOf(f, repo));

test('link-install: RoboTeam staged /Agent accepts exactly the relative links Ploinky creates to same-path checkouts', t => {
  const f = fixture(t, 'fresh workspace ü ');
  for (const repo of LINKED) {
    const text = fs.readlinkSync(linkedEntry(f, repo));
    assert.equal(path.posix.isAbsolute(text), false);
    assert.equal(path.posix.resolve('/Agent/linked', text), checkoutOf(f, repo));
  }
  const result = collect(f);
  assert.equal(result.roboTeamAgent.active, true);
  // The links are proven, not reported: the evidence shape is unchanged.
  assert.deepEqual(Object.keys(result.roboTeamAgent).sort(), Object.keys(result.explorer).sort());
  // An isolated profile binds the checkouts read-only; that is equally Ploinky's layout.
  for (const repo of LINKED) f.containers[1].mounts[checkoutMountIndex(f, repo)].RW = false;
  assert.equal(collect(f).roboTeamAgent.active, true);
});

test('link-install: link names follow Ploinky\'s Git URL forms, one link per repository', t => {
  const f = fixture(t);
  writeManifest(f, 'roboTeamAgent', { 'link-install': [
    'https://github.com/AssistOS-AI/AdvancedLanguageAgent',
    'git+https://github.com/AssistOS-AI/AdvancedLanguageAgent.git/',
    'git@github.com:AssistOS-AI/DocumentationSkills.git',
  ] });
  assert.equal(collect(f).roboTeamAgent.active, true);
});

for (const [label, declaration] of [
  ['a declaration that is not an array', 'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git'],
  ['an empty entry', ['']],
  ['a non-string entry', [42]],
  ['a plain HTTP URL', ['http://github.com/AssistOS-AI/AdvancedLanguageAgent.git']],
  ['an embedded credential', ['https://user:secret@github.com/AssistOS-AI/AdvancedLanguageAgent.git']],
  ['a ref fragment', ['https://github.com/AssistOS-AI/AdvancedLanguageAgent.git#main']],
  ['a node_modules repository name', ['https://github.com/AssistOS-AI/node_modules.git']],
  ['one name for two repositories', ['https://github.com/AssistOS-AI/AdvancedLanguageAgent.git', 'https://gitlab.com/other/AdvancedLanguageAgent.git']],
]) {
  test(`link-install: a manifest with ${label} is rejected`, t => {
    const f = fixture(t);
    writeManifest(f, 'roboTeamAgent', { 'link-install': declaration });
    assert.throws(() => collect(f), /roboTeamAgent manifest has an unverifiable link-install declaration/);
  });
}

test('link-install: a missing or unreadable verified manifest is rejected', t => {
  const f = fixture(t);
  writeManifest(f, 'roboTeamAgent', '{ not json');
  assert.throws(() => collect(f), /roboTeamAgent link-install declarations cannot be read/);
  fs.unlinkSync(path.join(f.options.repositories.explorer.repositoryPath, 'roboTeamAgent/manifest.json'));
  assert.throws(() => collect(f), /roboTeamAgent link-install declarations cannot be read/);
});

for (const [label, mutate, message] of [
  ['a missing link', f => fs.unlinkSync(linkedEntry(f, 'DocumentationSkills')), 'does not hold exactly the declared'],
  ['an extra link to another workspace checkout', f => {
    fs.mkdirSync(checkoutOf(f, 'Extra'));
    fs.symlinkSync(ploinkyLink(checkoutOf(f, 'Extra')), linkedEntry(f, 'Extra'));
  }, 'does not hold exactly the declared'],
  ['an extra regular file', f => fs.writeFileSync(linkedEntry(f, 'notes.txt'), 'unverified'), 'does not hold exactly the declared'],
  ['a link swapped to the other declared checkout', f => relink(f, 'AdvancedLanguageAgent', ploinkyLink(checkoutOf(f, 'DocumentationSkills'))), 'entry AdvancedLanguageAgent does not link'],
  ['an absolute spelling of the checkout', f => relink(f, 'AdvancedLanguageAgent', checkoutOf(f, 'AdvancedLanguageAgent')), 'entry AdvancedLanguageAgent does not link'],
  ['a link relative to the host staging directory', f => relink(f, 'AdvancedLanguageAgent', path.relative(path.dirname(linkedEntry(f, 'AdvancedLanguageAgent')), checkoutOf(f, 'AdvancedLanguageAgent'))), 'entry AdvancedLanguageAgent does not link'],
  ['a link to a prefix-lookalike outside the workspace', f => relink(f, 'AdvancedLanguageAgent', ploinkyLink(`${f.root}-evil/AdvancedLanguageAgent`)), 'entry AdvancedLanguageAgent does not link'],
  ['a link into a subdirectory of the checkout', f => relink(f, 'AdvancedLanguageAgent', ploinkyLink(`${checkoutOf(f, 'AdvancedLanguageAgent')}/src`)), 'entry AdvancedLanguageAgent does not link'],
  ['a copied directory instead of a link', f => {
    fs.unlinkSync(linkedEntry(f, 'AdvancedLanguageAgent'));
    fs.mkdirSync(linkedEntry(f, 'AdvancedLanguageAgent'));
  }, 'entry AdvancedLanguageAgent does not link'],
  ['a linked directory that is itself a symlink', f => {
    fs.renameSync(path.join(stagedAgent(f), 'linked'), `${f.root}/linked-elsewhere`);
    fs.symlinkSync(`${f.root}/linked-elsewhere`, path.join(stagedAgent(f), 'linked'));
  }, 'is not the staged link-install directory'],
  ['a missing linked directory', f => fs.rmSync(path.join(stagedAgent(f), 'linked'), { recursive: true }), 'is not the staged link-install directory'],
]) {
  test(`link-install: staged /Agent/linked rejects ${label}`, t => {
    const f = fixture(t, 'fresh workspace ü ');
    mutate(f);
    assert.throws(() => collect(f), new RegExp(`roboTeamAgent staged /Agent/linked ${message}`));
  });
}

test('link-install: a new declaration without its staged link is rejected', t => {
  const f = fixture(t);
  fs.mkdirSync(checkoutOf(f, 'Extra'));
  f.containers[1].mounts.push(bind(checkoutOf(f, 'Extra'), checkoutOf(f, 'Extra'), true));
  writeManifest(f, 'roboTeamAgent', { 'link-install': [...MANIFESTS.roboTeamAgent['link-install'], 'https://github.com/AssistOS-AI/Extra.git'] });
  assert.throws(() => collect(f), /roboTeamAgent staged \/Agent\/linked does not hold exactly the declared/);
});

test('link-install: without declarations a staged linked directory is extra Agent content', t => {
  const f = fixture(t);
  writeManifest(f, 'roboTeamAgent', {});
  assert.throws(() => collect(f), /roboTeamAgent staged \/Agent differs/);
  const g = fixture(t);
  fs.cpSync(path.join(stagedAgent(g), 'linked'), path.join(stagedAgent(g, 'explorer'), 'linked'), { recursive: true, verbatimSymlinks: true });
  assert.throws(() => collect(g), /explorer staged \/Agent differs/);
});

test('link-install: every other staged entry still matches the Ploinky Agent source byte for byte', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(stagedAgent(f), 'index.mjs'), 'stale');
  assert.throws(() => collect(f), /roboTeamAgent staged \/Agent differs/);
  // Only the root linked directory is set aside; a nested one is ordinary Agent content.
  const g = fixture(t);
  fs.mkdirSync(path.join(stagedAgent(g), 'nested/linked'));
  assert.throws(() => collect(g), /roboTeamAgent staged \/Agent differs/);
  // Ploinky never stages over a root linked entry of its own Agent source, so that source cannot pass.
  const h = fixture(t);
  fs.mkdirSync(path.join(h.agentSource, 'linked'));
  fs.writeFileSync(path.join(h.agentSource, 'linked/readme.txt'), 'source');
  fs.cpSync(path.join(h.agentSource, 'linked'), path.join(stagedAgent(h, 'explorer'), 'linked'), { recursive: true });
  assert.throws(() => collect(h), /roboTeamAgent staged \/Agent differs/);
});

for (const [label, mutate, message] of [
  ['a missing checkout mount', f => f.containers[1].mounts.splice(checkoutMountIndex(f, 'DocumentationSkills'), 1), /exact verified source mount/],
  ['a duplicated checkout mount', f => f.containers[1].mounts.push(bind(checkoutOf(f, 'DocumentationSkills'), checkoutOf(f, 'DocumentationSkills'), true)), /exact verified source mount/],
  ['a checkout mount from a foreign source', f => { f.containers[1].mounts[checkoutMountIndex(f, 'AdvancedLanguageAgent')].Source = `${f.root}/foreign`; }, /exact verified source mount/],
  ['checkout mounts swapped between repositories', f => { f.containers[1].mounts[checkoutMountIndex(f, 'AdvancedLanguageAgent')].Source = checkoutOf(f, 'DocumentationSkills'); }, /exact verified source mount/],
  ['a checkout mount that is not a bind', f => { f.containers[1].mounts[checkoutMountIndex(f, 'AdvancedLanguageAgent')].Type = 'volume'; }, /exact verified source mount/],
  ['a missing checkout directory', f => fs.rmSync(checkoutOf(f, 'AdvancedLanguageAgent'), { recursive: true }), /checkout AdvancedLanguageAgent is not the exact workspace directory/],
  ['a checkout that is a symlink to another directory', f => {
    fs.renameSync(checkoutOf(f, 'AdvancedLanguageAgent'), `${f.root}/elsewhere`);
    fs.symlinkSync(`${f.root}/elsewhere`, checkoutOf(f, 'AdvancedLanguageAgent'));
  }, /checkout AdvancedLanguageAgent is not the exact workspace directory/],
  ['a checkout that is a regular file', f => {
    fs.rmSync(checkoutOf(f, 'AdvancedLanguageAgent'), { recursive: true });
    fs.writeFileSync(checkoutOf(f, 'AdvancedLanguageAgent'), 'not a checkout');
  }, /checkout AdvancedLanguageAgent is not the exact workspace directory/],
  ['an inner mount shadowing inside a checkout', f => f.containers[1].mounts.push(bind(`${f.root}/foreign`, `${checkoutOf(f, 'AdvancedLanguageAgent')}/src`)), /mount shadowing/],
  ['an inner mount over a staged link', f => f.containers[1].mounts.push(bind(`${f.root}/foreign`, '/Agent/linked/AdvancedLanguageAgent')), /mount shadowing/],
  ['an outer mount shadowing a checkout in the Box', f => f.outerMounts.push(bind(`${f.root}-foreign`, checkoutOf(f, 'DocumentationSkills'))), /mount shadowing/],
]) {
  test(`link-install: checkout binding rejects ${label}`, t => {
    const f = fixture(t, 'fresh workspace ü ');
    mutate(f);
    assert.throws(() => collect(f), message);
  });
}

test('missing /Agent mount, writable AgentLib, and substituted code are rejected', t => {
  const f = fixture(t);
  const mount = f.containers[0].mounts.splice(3, 1)[0];
  assert.throws(() => collect(f), /unverified runtime mount at \/Agent/);
  f.containers[0].mounts.push(mount);
  f.outerMounts[2].RW = true;
  assert.throws(() => collect(f), /exact verified read-only/);
  f.outerMounts[2].RW = false;
  // A byte-identical copy of the verified agent folder is still another source.
  const copy = path.join(f.root, 'copy/explorer');
  fs.cpSync(path.join(f.options.repositories.explorer.repositoryPath, 'explorer'), copy, { recursive: true });
  f.containers[0].mounts[2].Source = copy;
  assert.throws(() => collect(f), /unverified runtime mount at \/code/);
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
  ['a /code bound outside the admitted root', f => { f.containers[0].mounts[2].Source = `${f.root}-evil/.ploinky/repos/AchillesIDE/explorer`; }, /unverified runtime mount at \/code/],
  ['a /code from the retired container-runtime code staging', f => { f.containers[0].mounts[2].Source = `${f.root}/.ploinky/container-runtime/explorer/code`; }, /unverified runtime mount at \/code/],
  ['an /Agent staged outside the admitted root', f => { f.containers[0].mounts[3].Source = `${f.root}-evil/.ploinky/container-runtime/explorer/Agent`; }, /unverified runtime mount at \/Agent/],
  ['a duplicated source bind', f => { f.containers[0].mounts.push(structuredClone(f.containers[0].mounts[0])); }, /exact verified source mount/],
  ['a source bind sourced from a foreign directory', f => { f.containers[0].mounts[0].Source = `${f.root}-evil/explorer`; }, /exact verified source mount/],
  ['a foreign source mounted at /code', f => { f.containers[0].mounts.push(bind(`${f.root}/foreign`, '/code')); }, /unverified runtime mount at \/code/],
  ['a dependency tree outside the admitted root', f => {
    const outside = `${f.root}-evil/.ploinky/deps/store/objects/explorer/payload/node_modules`;
    const adapter = path.join(f.root, '.ploinky/container-runtime/explorer/Agent/node_modules');
    fs.rmSync(adapter);
    fs.symlinkSync(outside, adapter);
    for (const index of [4, 5]) f.containers[0].mounts[index].Source = outside;
    f.containers[0].mounts[4].Destination = outside;
  }, /do not share the prepared workspace dependency tree/],
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
