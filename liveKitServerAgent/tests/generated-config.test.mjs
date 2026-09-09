import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(agentRoot, 'scripts/generate-config.mjs');

function runGenerator(topology, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-config-test-'));
  const agentLib = path.join(root, 'agent-lib');
  const generated = path.join(root, 'generated');
  const topologyFile = path.join(root, 'topology.json');
  fs.mkdirSync(path.join(agentLib, 'lib'), { recursive: true });
  fs.writeFileSync(topologyFile, JSON.stringify(topology));
  fs.writeFileSync(path.join(agentLib, 'lib/edgeTopology.mjs'), `
    import fs from 'node:fs';
    export function readEdgeTopology({ file }) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  `);
  const result = spawnSync(process.execPath, [generator, generated], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLOINKY_EDGE_TOPOLOGY_FILE: topologyFile,
      PLOINKY_AGENT_LIB_DIR: agentLib,
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret-never-log',
      ...env,
    },
  });
  return { root, generated, result };
}

test('attested runtime generation recovers local media configuration when operator topology is absent', () => {
  const run = runGenerator({}, { PLOINKY_MEDIA_PUBLIC_IP: '192.168.50.10' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const generated = path.join(run.generated, 'livekit.yaml');
    assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, '192.168.50.10');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('authoritative media topology ignores the local deployment override', () => {
  const run = runGenerator(validTopology(), { PLOINKY_MEDIA_PUBLIC_IP: '192.168.50.10' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const generated = path.join(run.generated, 'livekit.yaml');
    assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, '8.8.8.8');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('local media generation prefers the manifest-resolved host-reachable IPv4 over interface discovery', () => {
  const run = runGenerator({}, {
    PLOINKY_MEDIA_PUBLIC_IP: '',
    PLOINKY_HOST_REACHABLE_IPV4: '192.168.77.20',
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const generated = path.join(run.generated, 'livekit.yaml');
    assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, '192.168.77.20');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('the explicit local media override outranks the host-reachable IPv4 hint', () => {
  const run = runGenerator({}, {
    PLOINKY_MEDIA_PUBLIC_IP: '192.168.50.10',
    PLOINKY_HOST_REACHABLE_IPV4: '192.168.77.20',
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const generated = path.join(run.generated, 'livekit.yaml');
    assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, '192.168.50.10');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('authoritative media topology ignores the host-reachable IPv4 hint', () => {
  const run = runGenerator(validTopology(), {
    PLOINKY_MEDIA_PUBLIC_IP: '',
    PLOINKY_HOST_REACHABLE_IPV4: '192.168.77.20',
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const generated = path.join(run.generated, 'livekit.yaml');
    assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, '8.8.8.8');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('local media generation rejects non-host host-reachable addresses without generating active config', () => {
  for (const [label, address] of [
    ['loopback address', '127.0.0.1'],
    ['link-local address', '169.254.10.20'],
    ['malformed address', 'not-an-ip'],
  ]) {
    const run = runGenerator({}, {
      PLOINKY_MEDIA_PUBLIC_IP: '',
      PLOINKY_HOST_REACHABLE_IPV4: address,
    });
    try {
      assert.notEqual(run.result.status, 0, `${label} (${address}) was accepted`);
      assert.match(run.result.stderr, /PLOINKY_HOST_REACHABLE_IPV4 must be a usable literal IPv4 address/, label);
      assert.equal(
        fs.existsSync(path.join(run.generated, 'livekit.yaml')),
        false,
        `${label} generated an active LiveKit config`,
      );
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test('empty local media variables fall through to interface discovery', () => {
  const run = runGenerator({}, {
    PLOINKY_MEDIA_PUBLIC_IP: '',
    PLOINKY_HOST_REACHABLE_IPV4: '',
  });
  try {
    // Empty strings must be treated as absent: neither variable's rejection
    // error may fire, and the generator must reach interface discovery —
    // which either finds a usable address or fails with its own message.
    assert.doesNotMatch(
      run.result.stderr,
      /PLOINKY_MEDIA_PUBLIC_IP|PLOINKY_HOST_REACHABLE_IPV4/,
      'empty local media variables must not be validated as values',
    );
    if (run.result.status === 0) {
      const generated = path.join(run.generated, 'livekit.yaml');
      const nodeIp = JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip;
      assert.match(nodeIp, /^\d{1,3}(?:\.\d{1,3}){3}$/, 'discovered node_ip must be a literal IPv4');
      const interfaceAddresses = new Set(
        Object.values(os.networkInterfaces())
          .flat()
          .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address),
      );
      assert.ok(
        interfaceAddresses.has(nodeIp),
        `discovered node_ip ${nodeIp} must belong to a non-internal IPv4 interface`,
      );
    } else {
      assert.match(run.result.stderr, /Unable to detect a usable local IPv4 address/);
    }
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('local media variables trim surrounding whitespace before canonical validation', () => {
  for (const [label, env, expected] of [
    [
      'explicit local media override',
      {
        PLOINKY_MEDIA_PUBLIC_IP: ' 192.168.50.10 ',
        PLOINKY_HOST_REACHABLE_IPV4: '',
      },
      '192.168.50.10',
    ],
    [
      'host-reachable IPv4 hint',
      {
        PLOINKY_MEDIA_PUBLIC_IP: '',
        PLOINKY_HOST_REACHABLE_IPV4: ' 192.168.77.20 ',
      },
      '192.168.77.20',
    ],
  ]) {
    const run = runGenerator({}, env);
    try {
      assert.equal(run.result.status, 0, `${label}: ${run.result.stderr}`);
      const generated = path.join(run.generated, 'livekit.yaml');
      assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, expected, label);
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  }
});

const rejectedLocalMediaAddresses = [
  ['this-network address', '0.1.2.3'],
  ['loopback address', '127.0.0.1'],
  ['link-local address', '169.254.10.20'],
  ['IETF protocol assignment', '192.0.0.9'],
  ['documentation address', '192.0.2.1'],
  ['benchmark address', '198.18.0.1'],
  ['multicast address', '224.0.0.1'],
  ['reserved address', '240.0.0.1'],
  ['limited broadcast address', '255.255.255.255'],
];

test('attested runtime generation rejects non-host explicit local media addresses', () => {
  for (const [label, address] of rejectedLocalMediaAddresses) {
    const run = runGenerator({}, { PLOINKY_MEDIA_PUBLIC_IP: address });
    try {
      assert.notEqual(run.result.status, 0, `${label} (${address}) was accepted`);
      assert.match(run.result.stderr, /usable literal IPv4 address/, label);
      assert.equal(
        fs.existsSync(path.join(run.generated, 'livekit.yaml')),
        false,
        `${label} generated an active LiveKit config`,
      );
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  }
});

function validTopology(overrides = {}) {
  return {
    media: {
      publicIPv4: '8.8.8.8',
      udpPort: 7882,
      addressMode: 'direct',
      ...overrides,
    },
  };
}

for (const addressMode of ['direct', 'nat-forward']) {
test(`attested runtime generation generates literal ${addressMode} LiveKit and fixed private Egress config`, () => {
  const run = runGenerator(validTopology({ addressMode }));
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.result.stdout.includes('test-secret'), false);
    const generated = run.generated;
    const livekit = JSON.parse(fs.readFileSync(path.join(generated, 'livekit.yaml'), 'utf8'));
    const egress = JSON.parse(fs.readFileSync(path.join(generated, 'egress.yaml'), 'utf8'));
    const redis = fs.readFileSync(path.join(generated, 'redis.conf'), 'utf8');
    assert.deepEqual(livekit.rtc, {
      node_ip: '8.8.8.8',
      tcp_port: 0,
      udp_port: 7882,
      use_external_ip: false,
    });
    assert.deepEqual(livekit.bind_addresses, ['127.0.0.1']);
    assert.equal(livekit.port, 7880);
    assert.deepEqual(livekit.turn, { enabled: false });
    assert.deepEqual(livekit.redis, { address: '127.0.0.1:6379' });
    assert.equal('port_range_start' in livekit.rtc, false);
    assert.equal('port_range_end' in livekit.rtc, false);
    assert.equal(egress.template_port, 7980);
    assert.equal(egress.health_port, 7981);
    assert.equal(egress.ws_url, 'ws://127.0.0.1:7880');
    assert.deepEqual(egress.chrome_flags, {
      'disable-features': [
        'AudioServiceOutOfProcess',
        'site-per-process',
        'Translate',
        'TranslateUI',
        'BlinkGenPropertyTrees',
        'WebRtcHideLocalIpsWithMdns',
      ].join(','),
    });
    assert.match(redis, /^bind 127\.0\.0\.1$/m);
    assert.match(redis, /^protected-mode yes$/m);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});
}

const rejectedPublicIpv4Cases = [
  ['missing value', undefined],
  ['null value', null],
  ['numeric value', 16843009],
  ['array value', ['1.1.1.1']],
  ['empty value', ''],
  ['surrounding whitespace', ' 1.1.1.1'],
  ['non-decimal octet', '1.2.3.a'],
  ['too few octets', '1.2.3'],
  ['too many octets', '1.2.3.4.5'],
  ['out-of-range octet', '1.2.3.256'],
  ['non-canonical leading zeroes', '001.2.3.4'],
  ['this-network lower boundary', '0.0.0.0'],
  ['this-network upper boundary', '0.255.255.255'],
  ['private 10/8 lower boundary', '10.0.0.0'],
  ['private 10/8 upper boundary', '10.255.255.255'],
  ['CGNAT lower boundary', '100.64.0.0'],
  ['CGNAT upper boundary', '100.127.255.255'],
  ['loopback lower boundary', '127.0.0.0'],
  ['loopback upper boundary', '127.255.255.255'],
  ['link-local lower boundary', '169.254.0.0'],
  ['link-local upper boundary', '169.254.255.255'],
  ['private 172/12 lower boundary', '172.16.0.0'],
  ['private 172/12 upper boundary', '172.31.255.255'],
  ['IETF protocol assignments', '192.0.0.9'],
  ['TEST-NET-1', '192.0.2.1'],
  ['AS112 service prefix', '192.31.196.1'],
  ['AMT relay anycast prefix', '192.52.193.1'],
  ['deprecated 6to4 relay prefix', '192.88.99.1'],
  ['private 192.168/16 lower boundary', '192.168.0.0'],
  ['private 192.168/16 upper boundary', '192.168.255.255'],
  ['direct-delegation AS112 prefix', '192.175.48.1'],
  ['benchmark lower boundary', '198.18.0.0'],
  ['benchmark upper boundary', '198.19.255.255'],
  ['TEST-NET-2', '198.51.100.44'],
  ['TEST-NET-3', '203.0.113.20'],
  ['multicast lower boundary', '224.0.0.0'],
  ['multicast upper boundary', '239.255.255.255'],
  ['reserved lower boundary', '240.0.0.0'],
  ['limited broadcast', '255.255.255.255'],
];

test('attested runtime generation rejects every non-global IPv4 class without generating active config', () => {
  for (const [label, publicIPv4] of rejectedPublicIpv4Cases) {
    const run = runGenerator(validTopology({ publicIPv4 }));
    try {
      assert.notEqual(run.result.status, 0, `${label} (${JSON.stringify(publicIPv4)}) was accepted`);
      assert.match(run.result.stderr, /globally routable unicast IPv4/, label);
      assert.equal(run.result.stderr.includes('test-secret-never-log'), false, label);
      assert.equal(
        fs.existsSync(path.join(run.generated, 'livekit.yaml')),
        false,
        `${label} generated an active LiveKit config`,
      );
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  }
});

for (const publicIPv4 of [
  '1.1.1.1',
  '100.63.255.255',
  '100.128.0.0',
  '169.253.255.255',
  '169.255.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.254',
]) {
  test(`attested runtime generation accepts literal global unicast boundary ${publicIPv4}`, () => {
    const run = runGenerator(validTopology({ publicIPv4 }));
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const generated = path.join(run.generated, 'livekit.yaml');
      assert.equal(JSON.parse(fs.readFileSync(generated, 'utf8')).rtc.node_ip, publicIPv4);
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  });
}

for (const [label, topology, message] of [
  ['wrong mux', validTopology({ udpPort: 7881 }), /udpPort must equal/],
  ['discovery mode', validTopology({ addressMode: 'discover' }), /addressMode must be direct or nat-forward/],
]) {
  test(`attested runtime generation rejects ${label} without generating an active config`, () => {
    const run = runGenerator(topology);
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, message);
      assert.equal(run.result.stderr.includes('test-secret-never-log'), false);
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  });
}

test('generation fails closed before creating config when attested topology is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-config-missing-topology-'));
  const generated = path.join(root, 'generated');
  const agentLib = path.join(root, 'agent-lib');
  const missingTopology = path.join(root, 'missing-topology.json');
  try {
    fs.mkdirSync(path.join(agentLib, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(agentLib, 'lib/edgeTopology.mjs'), `
      import fs from 'node:fs';
      export function readEdgeTopology({ file }) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    `);
    const result = spawnSync(process.execPath, [generator, generated], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LIVEKIT_API_KEY: 'test-key',
        LIVEKIT_API_SECRET: 'test-secret-never-log',
        PLOINKY_AGENT_LIB_DIR: agentLib,
        PLOINKY_EDGE_TOPOLOGY_FILE: missingTopology,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT|no such file/i);
    assert.equal(result.stderr.includes('test-secret-never-log'), false);
    assert.equal(fs.existsSync(path.join(generated, 'livekit.yaml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime defaults to the Ploinky-mounted topology path when no locator env is injected', () => {
  const source = fs.readFileSync(generator, 'utf8');
  assert.match(source, /DEFAULT_EDGE_TOPOLOGY_FILE = '\/run\/ploinky-edge-topology\/current\.json'/);
  assert.match(
    source,
    /process\.env\.PLOINKY_EDGE_TOPOLOGY_FILE \|\| DEFAULT_EDGE_TOPOLOGY_FILE/,
  );
});

test('manifest defers generated config until the attested runtime starts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'manifest.json'), 'utf8'));
  for (const [profile, config] of Object.entries(manifest.profiles)) {
    assert.equal('preinstall' in config, false, `${profile} still executes a pre-attestation hook`);
    assert.deepEqual(
      config.env.find(({ name }) => name === 'PLOINKY_MEDIA_PUBLIC_IP'),
      { name: 'PLOINKY_MEDIA_PUBLIC_IP', required: false },
      `${profile} cannot receive the explicit local media address`,
    );
    assert.deepEqual(
      config.env.find(({ name }) => name === 'PLOINKY_HOST_REACHABLE_IPV4'),
      { name: 'PLOINKY_HOST_REACHABLE_IPV4', required: false },
      `${profile} cannot receive the manifest-resolved host-reachable address`,
    );
  }
  assert.deepEqual(manifest.volumeOptions['/working-data/generated'], {
    generated: true,
    required: false,
  });

  const source = fs.readFileSync(path.join(agentRoot, 'scripts/start-livekit-server-agent.sh'), 'utf8');
  const generationIndex = source.indexOf('node /code/scripts/generate-config.mjs');
  const firstConfigReadIndex = source.indexOf('require_file "$LIVEKIT_CONFIG"');
  assert.notEqual(generationIndex, -1);
  assert.ok(generationIndex < firstConfigReadIndex, 'runtime must generate config before reading it');
});
