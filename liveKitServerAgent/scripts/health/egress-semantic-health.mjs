import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HEALTH_URL = 'http://127.0.0.1:7981/';
const DEFAULT_TEMPLATE_URL = 'http://127.0.0.1:7980/';
const MAX_PROBE_BYTES = 128 * 1024;

async function boundedBody(response, maxBytes = MAX_PROBE_BYTES) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response declares ${declared} bytes (limit ${maxBytes})`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchBounded(url, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { response, body: await boundedBody(response) };
}

export async function probeEgressEndpoints({
  healthUrl = process.env.EGRESS_HEALTH_URL || DEFAULT_HEALTH_URL,
  templateUrl = process.env.EGRESS_TEMPLATE_URL || DEFAULT_TEMPLATE_URL,
  timeoutMs = 2_000,
  fetchImpl = fetch,
} = {}) {
  const health = await fetchBounded(healthUrl, fetchImpl, timeoutMs);
  const healthType = String(health.response.headers.get('content-type') || '').toLowerCase();
  if (!healthType.startsWith('application/json')) {
    throw new Error(`Egress health endpoint returned non-JSON content type ${healthType || '<missing>'}`);
  }
  let status;
  try {
    status = JSON.parse(health.body);
  } catch (error) {
    throw new Error(`Egress health endpoint returned invalid JSON: ${error.message}`);
  }
  if (!Number.isFinite(status?.CpuLoad) || status.CpuLoad < 0) {
    throw new Error('Egress health endpoint did not return a finite non-negative CpuLoad');
  }

  const template = await fetchBounded(templateUrl, fetchImpl, timeoutMs);
  const templateType = String(template.response.headers.get('content-type') || '').toLowerCase();
  if (!templateType.startsWith('text/html')) {
    throw new Error(`Egress template endpoint returned non-HTML content type ${templateType || '<missing>'}`);
  }
  if (!template.body.includes('LiveKit Egress')) {
    throw new Error('Egress template endpoint did not return the pinned LiveKit Egress application');
  }

  return {
    health: { cpuLoad: status.CpuLoad },
    template: { bytes: Buffer.byteLength(template.body) },
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await probeEgressEndpoints();
  process.stdout.write('ok\n');
}
