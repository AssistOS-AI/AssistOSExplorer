import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function requireEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const DEFAULT_EDGE_TOPOLOGY_FILE = '/run/ploinky-edge-topology/current.json';
const topologyFile = String(
  process.env.PLOINKY_EDGE_TOPOLOGY_FILE || DEFAULT_EDGE_TOPOLOGY_FILE,
).trim() || DEFAULT_EDGE_TOPOLOGY_FILE;
const agentLibDir = String(process.env.PLOINKY_AGENT_LIB_DIR || '/Agent').trim();
const generatedDir = path.resolve(process.argv[2] || '/working-data/generated');
const apiKey = requireEnvironment('LIVEKIT_API_KEY');
const apiSecret = requireEnvironment('LIVEKIT_API_SECRET');

const moduleUrl = pathToFileURL(path.join(agentLibDir, 'lib', 'edgeTopology.mjs')).href;
const { readEdgeTopology } = await import(moduleUrl);
const topology = readEdgeTopology({ file: topologyFile });
const media = topology?.media;

function parseLiteralIpv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const sourceOctets = value.split('.');
  const octets = sourceOctets.map(Number);
  if (octets.some((octet, index) => octet > 255 || String(octet) !== sourceOctets[index])) return null;
  return octets.reduce((result, octet) => (result * 256) + octet, 0) >>> 0;
}

const NON_GLOBAL_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, prefix]) => [parseLiteralIpv4(base), prefix]);

const NON_HOST_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, prefix]) => [parseLiteralIpv4(base), prefix]);

function isIpv4InCidrs(address, cidrs) {
  return cidrs.some(([base, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return ((address & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function isLiteralGlobalUnicastIpv4(value) {
  const address = parseLiteralIpv4(value);
  if (address === null) return false;
  return !isIpv4InCidrs(address, NON_GLOBAL_IPV4_CIDRS);
}

function isUsableLocalIpv4(value) {
  const address = parseLiteralIpv4(value);
  if (address === null) return false;
  return !isIpv4InCidrs(address, NON_HOST_IPV4_CIDRS);
}

function detectLocalIpv4() {
  const override = String(process.env.PLOINKY_MEDIA_PUBLIC_IP || '').trim();
  if (override) {
    if (!isUsableLocalIpv4(override)) throw new Error('PLOINKY_MEDIA_PUBLIC_IP must be a usable literal IPv4 address');
    return override;
  }
  // Ploinky normally computes the browser-reachable host IPv4 at start time and
  // supplies it as PLOINKY_HOST_REACHABLE_IPV4. It remains an ordinary optional
  // manifest env, so operator configuration can replace that detected value in
  // local mode. Preferring the resolved hint over interface discovery keeps the
  // advertised candidate reachable from a host or LAN browser; the container's
  // own bridge address almost never is.
  const hostReachable = String(process.env.PLOINKY_HOST_REACHABLE_IPV4 || '').trim();
  if (hostReachable) {
    if (!isUsableLocalIpv4(hostReachable)) throw new Error('PLOINKY_HOST_REACHABLE_IPV4 must be a usable literal IPv4 address');
    return hostReachable;
  }
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter(isUsableLocalIpv4);
  if (!candidates.length) throw new Error('Unable to detect a usable local IPv4 address for LiveKit media');
  const rank = (value) => value.startsWith('192.168.') || value.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(value) ? 0 : 1;
  return candidates.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))[0];
}

const configuredMedia = media !== undefined;
const mediaAddress = configuredMedia ? media?.publicIPv4 : detectLocalIpv4();
if (configuredMedia && !isLiteralGlobalUnicastIpv4(mediaAddress)) {
  throw new Error('LiveKit media.publicIPv4 must be a literal globally routable unicast IPv4 address');
}
if (!configuredMedia && !isUsableLocalIpv4(mediaAddress)) {
  throw new Error('LiveKit local media address must be a usable literal IPv4 address');
}
if (configuredMedia && media?.udpPort !== 7882) {
  throw new Error('LiveKit media.udpPort must equal the box-owned port 7882');
}
if (configuredMedia && !['direct', 'nat-forward'].includes(media?.addressMode)) {
  throw new Error('LiveKit media.addressMode must be direct or nat-forward');
}

const livekitConfig = {
  port: 7880,
  bind_addresses: ['127.0.0.1'],
  logging: { level: 'info' },
  rtc: {
    node_ip: mediaAddress,
    tcp_port: 0,
    udp_port: 7882,
    use_external_ip: false,
  },
  turn: { enabled: false },
  redis: { address: '127.0.0.1:6379' },
  keys: { [apiKey]: apiSecret },
};
const egressConfig = {
  api_key: apiKey,
  api_secret: apiSecret,
  ws_url: 'ws://127.0.0.1:7880',
  insecure: true,
  redis: { address: '127.0.0.1:6379' },
  template_port: 7980,
  health_port: 7981,
  chrome_flags: {
    'disable-features': [
      'AudioServiceOutOfProcess',
      'site-per-process',
      'Translate',
      'TranslateUI',
      'BlinkGenPropertyTrees',
      'WebRtcHideLocalIpsWithMdns',
    ].join(','),
  },
};

fs.mkdirSync(generatedDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(generatedDir, 'livekit.yaml'), `${JSON.stringify(livekitConfig, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(generatedDir, 'egress.yaml'), `${JSON.stringify(egressConfig, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(
  path.join(generatedDir, 'redis.conf'),
  'bind 127.0.0.1\nprotected-mode yes\nport 6379\ndir /data/redis\nsave 60 1\nloglevel warning\nappendonly no\n',
  { mode: 0o600 },
);

console.log('[liveKitServerAgent] generated fixed LiveKit/Egress/Redis configuration from the attested topology (credentials redacted)');
