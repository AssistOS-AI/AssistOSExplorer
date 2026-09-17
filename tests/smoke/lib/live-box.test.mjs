import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseLocalScreenBaseUrl,
  sameLiveBoxGeneration,
  selectLocalScreenContainer,
  validateBoxFreshness,
  validateLiveBoxEvidence,
  validateReadOnlyPloinkySourceMount,
  validateWorkspaceSourceMount,
  validateVerifiedSeccompRuntime,
  verifyNetworkLaneCompletion,
} from './live-box.mjs';

const NOW = Date.parse('2026-07-16T10:10:00.000Z');
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

function container(bindings, overrides = {}) {
  return {
    Id: 'c'.repeat(64),
    Name: '/ploinky-box-screen',
    Image: IMAGE_ID,
    State: { Running: true, StartedAt: '2026-07-16T10:05:00.000Z' },
    Config: { Labels: {
      'io.assistos.ploinky-box.role': 'box',
      'io.assistos.ploinky-box.router-host-port': bindings['8080/tcp']?.[0]?.HostPort,
      'io.assistos.ploinky-box.media-host-port': bindings['7882/udp']?.[0]?.HostPort,
    } },
    HostConfig: { PortBindings: bindings },
    ...overrides,
  };
}

function exactBindings(port = '8080', mediaPort = '7882') {
  return {
    '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: port }],
    '7882/udp': [{ HostIp: '', HostPort: mediaPort }],
  };
}

function evidence() {
  return {
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-16T10:00:00.000Z',
    generationMaxAgeMs: 600_000,
    imageMaxAgeMs: 3_600_000,
    box: {
      containerName: 'ploinky-box-screen',
      containerId: 'c'.repeat(64),
      startedAt: '2026-07-16T10:05:00.000Z',
      running: true,
      semanticLabels: {
        role: 'box',
        pathHash: 'd'.repeat(12),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        routerHostPort: '8080',
        mediaHostPort: '7882',
        seccompFingerprint: 'd'.repeat(64),
        dependenciesFingerprint: 'e'.repeat(64),
        imagesFingerprint: 'f'.repeat(64),
        agentLibMode: 'managed',
        agentLibSourceIdHash: '1'.repeat(64),
        agentLibFingerprint: '2'.repeat(64),
        agentLibSourceRelativePath: `.ploinky/agentlib/generations/${'3'.repeat(40)}-${'2'.repeat(12)}`,
        agentLibCommit: '3'.repeat(40),
      },
      imageRef: 'docker.io/assistos/ploinky-box:runtime',
      imageId: IMAGE_ID,
      baseURL: 'http://127.0.0.1:8080',
      publicIPv4: '',
      selectedRouterHostPort: '8080',
      normalizedPortBindings: exactBindings(),
      securityOptions: [
        'label=disable',
        'seccomp=/verified/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
        'unmask=all',
      ],
    },
  };
}

test('live Box URL and container discovery require the exact loopback boundary', () => {
  assert.deepEqual(parseLocalScreenBaseUrl('http://127.0.0.1:18080'), {
    baseURL: 'http://127.0.0.1:18080', port: '18080',
  });
  for (const value of ['https://127.0.0.1:8080', 'http://localhost:8080', 'http://0.0.0.0:8080', 'http://127.0.0.1:8080/path']) {
    assert.throws(() => parseLocalScreenBaseUrl(value), /requires SMOKE_BASE_URL|loopback HTTP/);
  }

  const selected = selectLocalScreenContainer([
    container({ '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }),
    container(exactBindings()),
  ], '8080');
  assert.equal(selected.Id, 'c'.repeat(64));
  assert.throws(() => selectLocalScreenContainer([
    container(exactBindings()), container(exactBindings(), { Id: 'd'.repeat(64) }),
  ], '8080'), /exactly one/);
  assert.throws(() => selectLocalScreenContainer([
    container({ ...exactBindings(), '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '8081' }] }),
  ], '8080'), /found 0/);
});

test('live Box discovery isolates coexisting Boxes by their selected Router and labeled media ports', () => {
  const ordinary = container(exactBindings('18080', '7882'));
  const isolated = container(exactBindings('28080', '27882'), {
    Id: 'd'.repeat(64), Name: '/ploinky-box-isolated',
  });
  const containers = [ordinary, isolated];
  const before = structuredClone(containers);
  assert.equal(selectLocalScreenContainer(containers, '28080'), isolated);
  assert.equal(selectLocalScreenContainer(containers, '18080'), ordinary);
  assert.deepEqual(containers, before);
  assert.throws(() => selectLocalScreenContainer(containers, '38080'), /found 0/);
  assert.throws(() => selectLocalScreenContainer([
    isolated,
    container(exactBindings('28080', '37882'), { Id: 'e'.repeat(64) }),
  ], '28080'), /found 2/);
});

test('explicit bound-container selection requires the configured address and matching binding label', () => {
  const bindings = exactBindings('28080', '27882');
  bindings['8080/tcp'][0].HostIp = '0.0.0.0';
  const bound = container(bindings);
  const bindingLabel = 'io.assistos.ploinky-box.router-bind-address';
  bound.Config.Labels[bindingLabel] = '0.0.0.0';
  const options = { expectedRouterBindAddress: '0.0.0.0' };
  assert.equal(selectLocalScreenContainer([bound], '28080', options), bound);
  assert.throws(() => selectLocalScreenContainer([bound], '28080'), /found 0/);
  assert.throws(() => selectLocalScreenContainer([container(exactBindings('28080', '27882'))], '28080', options), /found 0/);
  assert.throws(() => selectLocalScreenContainer([bound], '28080', { expectedRouterBindAddress: '::' }), /canonical IPv4/);
  delete bound.Config.Labels[bindingLabel];
  assert.throws(() => selectLocalScreenContainer([bound], '28080', options), /found 0/);
  bound.Config.Labels[bindingLabel] = '192.168.1.50';
  assert.throws(() => selectLocalScreenContainer([bound], '28080', options), /found 0/);
});

test('live Box discovery rejects missing, malformed, or mismatched port labels', () => {
  for (const label of ['router-host-port', 'media-host-port']) {
    for (const value of [undefined, '', '0', '-1', '65536', '27882.5', '027882', ' 27882 ', '1e4', 'wrong', '7881']) {
      const candidate = container(exactBindings('28080', '27882'));
      const key = `io.assistos.ploinky-box.${label}`;
      if (value === undefined) delete candidate.Config.Labels[key];
      else candidate.Config.Labels[key] = value;
      assert.throws(() => selectLocalScreenContainer([candidate], '28080'), /found 0/);
    }
  }
});

test('live Box discovery preserves exact target, protocol, IP, and mapping-count boundaries with an alternate media port', () => {
  const candidate = container(exactBindings('28080', '27882'));
  for (const bindings of [
    { ...exactBindings('28080', '27882'), '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '28081' }] },
    { ...exactBindings('28080', '27882'), '7882/udp': [
      { HostIp: '0.0.0.0', HostPort: '27882' }, { HostIp: '0.0.0.0', HostPort: '37882' },
    ] },
    { ...exactBindings('28080', '27882'), '8080/tcp': [
      { HostIp: '127.0.0.1', HostPort: '28080' }, { HostIp: '127.0.0.1', HostPort: '38080' },
    ] },
    { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '28080' }], '7882/tcp': [{ HostIp: '0.0.0.0', HostPort: '27882' }] },
    { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '28080' }], '7881/udp': [{ HostIp: '0.0.0.0', HostPort: '27882' }] },
    { ...exactBindings('28080', '27882'), '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '28080' }] },
    { ...exactBindings('28080', '27882'), '7882/udp': [{ HostIp: '127.0.0.1', HostPort: '27882' }] },
    { ...exactBindings('28080', '27882'), '7882/udp': [{ HostIp: '::', HostPort: '27882' }] },
    { ...exactBindings('28080', '27882'), '7882/udp': [{ HostIp: '0.0.0.0', HostPort: ' 27882 ' }] },
  ]) {
    assert.throws(() => selectLocalScreenContainer([
      { ...candidate, HostConfig: { PortBindings: bindings } },
    ], '28080'), /found 0/);
  }
});

test('alternate media port evidence remains bound to both labels and the exact pre/post publication', () => {
  const before = evidence();
  before.box.baseURL = 'http://127.0.0.1:28080';
  before.box.selectedRouterHostPort = '28080';
  before.box.semanticLabels.routerHostPort = '28080';
  before.box.semanticLabels.mediaHostPort = '27882';
  before.box.normalizedPortBindings = exactBindings('28080', '27882');
  const context = { baseURL: before.box.baseURL, nowMs: NOW };
  const validated = validateLiveBoxEvidence(before, context);
  assert.equal(validated.box.semanticLabels.mediaHostPort, '27882');
  assert.equal(sameLiveBoxGeneration(validated, structuredClone(validated)), true);

  const after = structuredClone(before);
  after.box.semanticLabels.mediaHostPort = '37882';
  assert.throws(() => validateLiveBoxEvidence(after, context), /media-host-port label does not match/);
  after.box.normalizedPortBindings = exactBindings('28080', '37882');
  assert.equal(sameLiveBoxGeneration(validated, validateLiveBoxEvidence(after, context)), false);
});

test('live Box evidence is exact, fresh, and generation-comparable', () => {
  const validated = validateLiveBoxEvidence(evidence(), {
    baseURL: 'http://127.0.0.1:8080', nowMs: NOW,
  });
  assert.equal(validated.box.imageId, IMAGE_ID);
  assert.equal(sameLiveBoxGeneration(validated, structuredClone(validated)), true);

  const staleGeneration = evidence();
  staleGeneration.box.startedAt = '2026-07-16T09:00:00.000Z';
  assert.throws(() => validateLiveBoxEvidence(staleGeneration, {
    baseURL: 'http://127.0.0.1:8080', nowMs: NOW,
  }), /generation is not fresh/);

  const staleImage = evidence();
  staleImage.imageCreatedAt = '2026-07-16T08:00:00.000Z';
  assert.throws(() => validateLiveBoxEvidence(staleImage, {
    baseURL: 'http://127.0.0.1:8080', nowMs: NOW,
  }), /image is not fresh/);
});

test('live Box source evidence requires the exact verified read-only Ploinky bind', () => {
  const realpathSync = (value) => value.replace('/private', '');
  assert.deepEqual(validateReadOnlyPloinkySourceMount([{
    Type: 'bind',
    Source: '/private/work/ploinky',
    Destination: '/opt/ploinky',
    RW: false,
  }], '/work/ploinky', { realpathSync }), {
    type: 'bind',
    source: '/work/ploinky',
    destination: '/opt/ploinky',
    readWrite: false,
  });
  assert.throws(() => validateReadOnlyPloinkySourceMount([{
    Type: 'bind', Source: '/work/ploinky', Destination: '/opt/ploinky', RW: true,
  }], '/work/ploinky', { realpathSync }), /read-only bind/);
  assert.throws(() => validateReadOnlyPloinkySourceMount([{
    Type: 'bind', Source: '/work/other', Destination: '/opt/ploinky', RW: false,
  }], '/work/ploinky', { realpathSync }), /does not equal/);
});

test('live Box workspace evidence requires the exact host source as one writable same-path bind', () => {
  const mounts = [{
    Type: 'bind',
    Source: '/host/workspace',
    Destination: '/host/workspace',
    RW: true,
  }];
  const realpathSync = (value) => value;
  assert.deepEqual(validateWorkspaceSourceMount(mounts, '/host/workspace', { realpathSync }), {
    type: 'bind',
    source: '/host/workspace',
    destination: '/host/workspace',
    readWrite: true,
  });
  assert.throws(
    () => validateWorkspaceSourceMount([{ ...mounts[0], RW: false }], '/host/workspace', { realpathSync }),
    /writable bind mount/,
  );
  assert.throws(
    () => validateWorkspaceSourceMount(mounts, '/different/workspace', { realpathSync }),
    /exactly one/,
  );
  assert.throws(
    () => validateWorkspaceSourceMount([...mounts, mounts[0]], '/host/workspace', { realpathSync }),
    /exactly one/,
  );
  assert.throws(
    () => validateWorkspaceSourceMount([{ ...mounts[0], Destination: '/workspace' }], '/host/workspace', { realpathSync }),
    /exactly one/,
  );
  assert.throws(
    () => validateWorkspaceSourceMount([...mounts, { ...mounts[0], Destination: '/alias' }], '/host/workspace', { realpathSync }),
    /another alias/,
  );
});

test('live Box seccomp evidence binds exact SecurityOpt to verified candidate profile bytes', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verified-ploinky-seccomp-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, 'ploinky-box', 'seccomp', 'podman-nested-pid-fallback.json');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const profileBytes = Buffer.from(JSON.stringify({
    defaultAction: 'SCMP_ACT_ERRNO',
    syscalls: [{ names: ['name_to_handle_at'], action: 'SCMP_ACT_ERRNO', errnoRet: 95 }],
  }));
  fs.writeFileSync(profilePath, profileBytes);
  const fingerprint = crypto.createHash('sha256').update(profileBytes).digest('hex');
  const securityOptions = ['label=disable', `seccomp=${profilePath}`, 'unmask=all'].sort();
  const runtime = {
    semanticLabels: { seccompFingerprint: fingerprint },
    securityOptions,
  };
  assert.deepEqual(validateVerifiedSeccompRuntime(runtime, root), {
    path: profilePath,
    fingerprint,
    securityOptions,
  });
  assert.throws(
    () => validateVerifiedSeccompRuntime({
      ...runtime,
      semanticLabels: { seccompFingerprint: 'a'.repeat(64) },
    }, root),
    /does not match the verified Ploinky profile bytes/,
  );
  assert.throws(
    () => validateVerifiedSeccompRuntime({
      ...runtime,
      securityOptions: ['label=disable', 'seccomp=/different/profile.json', 'unmask=all'].sort(),
    }, root),
    /does not apply the verified Ploinky seccomp profile exactly/,
  );
});

test('native gates enforce the same fresh image and container generation contract', () => {
  const box = evidence().box;
  assert.equal(validateBoxFreshness({
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-16T10:00:00.000Z',
    box,
    generationMaxAgeMs: 600_000,
    imageMaxAgeMs: 3_600_000,
  }, { nowMs: NOW }).imageCreatedAt, '2026-07-16T10:00:00.000Z');
  assert.throws(() => validateBoxFreshness({
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-16T08:00:00.000Z',
    box,
    generationMaxAgeMs: 600_000,
    imageMaxAgeMs: 3_600_000,
  }, { nowMs: NOW }), /image is not fresh/);

  const ancient = { ...box, startedAt: '2026-07-15T10:05:00.000Z' };
  assert.throws(() => validateBoxFreshness({
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-15T10:00:00.000Z',
    box: ancient,
    generationMaxAgeMs: 10 * 24 * 60 * 60_000,
    imageMaxAgeMs: 10 * 24 * 60 * 60_000,
  }, { nowMs: NOW }), /generation is not fresh/);
});

test('an immutable release image may be old only when the caller still pins a fresh Box generation', () => {
  const box = evidence().box;
  const validated = validateBoxFreshness({
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-01T10:00:00.000Z',
    box,
    generationMaxAgeMs: 600_000,
    imageMaxAgeMs: null,
    requireFreshImage: false,
  }, { nowMs: NOW });
  assert.equal(validated.requireFreshImage, false);
  assert.equal(validated.imageMaxAgeMs, null);

  const staleGeneration = { ...box, startedAt: '2026-07-16T09:00:00.000Z' };
  assert.throws(() => validateBoxFreshness({
    capturedAt: '2026-07-16T10:10:00.000Z',
    imageCreatedAt: '2026-07-01T10:00:00.000Z',
    box: staleGeneration,
    generationMaxAgeMs: 600_000,
    requireFreshImage: false,
  }, { nowMs: NOW }), /generation is not fresh/);
});

test('failed network lanes still re-inspect and aggregate post-lane generation failures', () => {
  const beforeBox = evidence().box;
  let reinspected = 0;
  assert.throws(() => verifyNetworkLaneCompletion({
    lane: 'direct-udp',
    laneResult: { status: 1 },
    beforeBox,
    collectAfter() {
      reinspected += 1;
      return { box: { ...beforeBox, containerId: 'd'.repeat(64) } };
    },
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /lane failed with exit 1/);
    assert.match(error.errors[1].message, /generation changed/);
    return true;
  });
  assert.equal(reinspected, 1);
});
