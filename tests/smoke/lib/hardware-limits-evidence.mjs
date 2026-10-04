// Evidence helpers for the hardware-limits browser executors (specs 90, 91, 92).
//
// Everything here is read-only observation and pure analysis. A helper that
// cannot make an observation throws; it never returns a value that looks like
// success. Commands run through an injectable `run` (default: execFile with
// argv arrays, a deadline and a bounded output; a fake may answer synchronously), so the unit tests exercise
// the real parsers with fake engines and a fake clock.
//
// Contents: the nested-engine "core observer" (leaf reader and running-set
// reader, spec 18.7), the GPU idle gate with amendment A5, runner identity
// (three MPS keys only), the in-flight sampler (every observation bound to its
// own request window), the analysis loader for the deployed Ploinky clone, and
// evidence redaction.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIB = 1024 * 1024;
export const CPU_PERIOD_US = 100000;
export const MIN_MEMORY_BYTES = 64 * MIB;

// The complete Explorer graph of the E2E workspace (plan C2, E2E-A).
export const EXPECTED_GRAPH_RUNTIMES = 16;

// The three names Apply gives a share client, and the product's own CUDA cache variable.
export const MPS_RUNNER_NAMES = Object.freeze(['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY']);
export const RUNNER_PRODUCT_CUDA = Object.freeze(['CUDA_CACHE_PATH']);
export const MPS_PIPE_DIRECTORY = '/run/ploinky-mps-pipe';

// The small model of E2E-D (local-llms catalog, models.json: qwen2.5-0.5b-instruct-q4_k_m).
export const SMALL_MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m';
export const SMALL_MODEL_SHA256 = '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db';

// The least number of observations that must be taken WHILE a request is outstanding.
export const INFERENCE_MIN_IN_FLIGHT = Object.freeze({ cgroup: 3, gpu: 2 });
export const INFERENCE_CADENCE = Object.freeze({ sampleMs: 250, gpuMs: 500 });

// Amendment A5: at most one recorded display process (type exactly G, at most 64 MiB) is tolerated.
export const A5_TOLERATED_MAX = 1;
export const A5_TOLERATED_MAX_MIB = 64;
export const GPU_PROCESS_TYPES = Object.freeze(['C', 'G', 'C+G', 'M', 'M+C', 'M+G', 'M+C+G']);

export class EvidenceBlocked extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvidenceBlocked';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Command execution

export function defaultRun(command, args, { timeoutMs = 20_000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error && typeof error.code !== 'number' ? error : null,
      });
    });
    child.stdin?.end();
  });
}

// `run` may be synchronous (a fake engine) or asynchronous (the default); every caller awaits it.
export function checked(result, label) {
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error ? result.error.message : `exit ${result?.status ?? 'unknown'}${result?.signal ? ` signal ${result.signal}` : ''}: ${String(result?.stderr || '').trim().slice(0, 300)}`;
    throw new Error(`${label} failed (${detail}).`);
  }
  return result.stdout;
}

export function checkedJson(result, label) {
  const text = checked(result, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function validateBoxName(name) {
  if (!BOX_NAME.test(String(name || ''))) throw new Error('The Box container name is missing or malformed (set SMOKE_PLOINKY_BOX_CONTAINER).');
  return String(name);
}

// `podman container exec --user podman <box>`: the uid-1000 core observer inside the Box (spec 18.7).
export function coreArgs(boxName) {
  return ['container', 'exec', '--user', 'podman', validateBoxName(boxName)];
}

export function nestedArgs(boxName) {
  return [...coreArgs(boxName), 'podman', '--cgroup-manager=cgroupfs'];
}

// ---------------------------------------------------------------------------
// Arithmetic that mirrors the product (resolve.mjs, cpuQuota.mjs)

export function resolveMemoryPercent(percent, envelopeBytes) {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('memoryPercent must be an integer from 1 to 100.');
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes <= 0) throw new Error('The Box memory envelope is unknown.');
  const bytes = Math.floor((percent * envelopeBytes) / 100 / MIB) * MIB;
  if (bytes < MIN_MEMORY_BYTES) throw new Error(`memoryPercent ${percent} resolves to ${bytes} bytes, below the 64 MiB minimum.`);
  return bytes;
}

// The exact share the product pins for a VRAM percentage of the physical device (liveGpuCommands.shareMemoryMiB).
export const shareMemoryMiB = (vramPercent, deviceMiB) => Math.floor(vramPercent * deviceMiB / 100);

// The typed code of a refused tool call: the `error` of a JSON document, else an `admission_*` word of the message.
export function refusalCode(text) {
  const raw = String(text ?? '').replace(/^MCP error -?\d+:\s*/, '');
  try {
    const document = JSON.parse(raw);
    if (document && typeof document.error === 'string') return document.error.slice(0, 80);
  } catch { /* not JSON */ }
  return (/\b(admission_[a-z_]+|busy|runner_[a-z_]+|licence_required|invalid_[a-z_]+)\b/.exec(raw) || [])[1] ?? null;
}

// Amendment A3: a value with at most two decimals reads back as the exact quota N or N-1 at period 100000.
export function cpuMaxMatches(value, cpus) {
  const read = /^([0-9]+) ([0-9]+)$/.exec(String(value ?? '').trim());
  const wanted = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(String(cpus));
  if (!read || !wanted) return false;
  const hundredths = Number(wanted[1]) * 100 + Number(String(wanted[2] || '').padEnd(2, '0'));
  const exact = hundredths * 1000;
  return Number(read[2]) === CPU_PERIOD_US && (Number(read[1]) === exact || Number(read[1]) === exact - 1);
}

// ---------------------------------------------------------------------------
// Leaf reader: the agent leaf's cgroup interface files, read by the Box user

const LEAF_FILES = ['cpu.stat', 'cpu.max', 'memory.max', 'memory.swap.max', 'memory.current', 'memory.swap.current', 'memory.peak', 'memory.events', 'pids.max', 'pids.current'];

// Runs inside the Box. The container ID is validated here again; the path must be canonical beneath
// /sys/fs/cgroup/ploinky/agents. Nothing is written.
export const LEAF_SAMPLE_PROGRAM = String.raw`
const fs=require('node:fs');
const id=process.argv[1];
if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid container identity');
let p=null;
for(const name of ['libpod-'+id,'libpod-'+id+'.scope']){
 const candidate='/sys/fs/cgroup/ploinky/agents/'+name;
 try{if(fs.realpathSync(candidate)===candidate){p=candidate;break;}}catch(e){if(e.code!=='ENOENT')throw e;}
}
if(p===null)throw Error('No canonical cgroup leaf for the container');
const read=(n)=>{try{return fs.readFileSync(p+'/'+n,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const cpuStat=read('cpu.stat');const atNs=process.hrtime.bigint().toString();
const out={leaf:p,atNs,'cpu.stat':cpuStat};
for(const n of ${JSON.stringify(LEAF_FILES.filter((name) => name !== 'cpu.stat'))})out[n]=read(n);
process.stdout.write(JSON.stringify(out));`;

const numberOrNull = (value) => (value === null || value === undefined ? null : /^[0-9]+$/.test(String(value).trim()) ? Number(String(value).trim()) : null);
const keyed = (text) => Object.fromEntries(String(text ?? '').split('\n').map((line) => /^([a-z_]+) ([0-9]+)$/.exec(line.trim())).filter(Boolean).map((found) => [found[1], Number(found[2])]));

// A raw leaf sample as numbers; anything unreadable stays null so the analysis can say so.
// The shape is the one the deployed analysis (liveLlmCommands.analyzeInference) reads.
export function parseLeafSample(raw) {
  const cpu = keyed(raw['cpu.stat']);
  const events = keyed(raw['memory.events']);
  const atNs = /^[0-9]{1,20}$/.test(String(raw.atNs)) ? BigInt(raw.atNs) : null;
  const text = (value) => (value === null || value === undefined ? null : String(value).trim());
  return {
    atUs: atNs === null ? null : Number(atNs / 1000n),
    usageUsec: cpu.usage_usec ?? null,
    nrPeriods: cpu.nr_periods ?? null,
    nrThrottled: cpu.nr_throttled ?? null,
    throttledUsec: cpu.throttled_usec ?? null,
    cpuMax: text(raw['cpu.max']),
    memoryMax: text(raw['memory.max']),
    swapMax: text(raw['memory.swap.max']),
    pidsMax: text(raw['pids.max']),
    memoryCurrent: numberOrNull(raw['memory.current']),
    memoryPeak: numberOrNull(raw['memory.peak']),
    swapCurrent: numberOrNull(raw['memory.swap.current']),
    oom: events.oom ?? null,
    oomKill: events.oom_kill ?? null,
    memoryHigh: events.high ?? null,
    memoryMaxEvents: events.max ?? null,
  };
}

export async function readLeaf({ run = defaultRun, boxName, containerId }) {
  const raw = checkedJson(await run('podman', [...coreArgs(boxName), 'node', '-e', LEAF_SAMPLE_PROGRAM, String(containerId)], { timeoutMs: 20_000 }), 'Leaf read');
  if (!raw || typeof raw !== 'object' || !/^\/sys\/fs\/cgroup\/ploinky\/agents\/libpod-[a-f0-9]{64}(?:\.scope)?$/.test(String(raw.leaf))) {
    throw new Error('Leaf read returned a leaf outside the agents hierarchy.');
  }
  return { leaf: raw.leaf, ...parseLeafSample(raw) };
}

// ---------------------------------------------------------------------------
// Running-set reader: each nested container's ID, name and StartedAt (spec 18.7)

export async function readRunningSet({ run = defaultRun, boxName }) {
  const ids = checked(await run('podman', [...nestedArgs(boxName), 'container', 'ls', '--quiet', '--no-trunc'], { timeoutMs: 30_000 }), 'Nested container listing')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Nested container listing returned a malformed identity.');
  if (!ids.length) return [];
  const inspected = checkedJson(await run('podman', [...nestedArgs(boxName), 'container', 'inspect', ...ids], { timeoutMs: 30_000 }), 'Nested container inspection');
  if (!Array.isArray(inspected) || inspected.length !== ids.length) throw new Error('Nested container inspection did not return one record per container.');
  const set = inspected.map((record) => {
    const id = String(record?.Id || '');
    const name = String(record?.Name || '').replace(/^\//, '');
    const startedAt = String(record?.State?.StartedAt || '');
    if (!/^[a-f0-9]{64}$/.test(id) || !name || !startedAt || record?.State?.Running !== true) throw new Error('Nested container inspection returned an incomplete or stopped record.');
    return { id, name, startedAt };
  });
  if (new Set(set.map((entry) => entry.id)).size !== set.length) throw new Error('Nested container inspection returned a duplicate identity.');
  return set.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

// The identities that differ between two running sets: names added, removed, or recreated (another ID or StartedAt).
export function diffRunningSets(before, after) {
  const index = (set) => new Map(set.map((entry) => [entry.name, entry]));
  const left = index(before);
  const right = index(after);
  const added = [...right.keys()].filter((name) => !left.has(name)).sort();
  const removed = [...left.keys()].filter((name) => !right.has(name)).sort();
  const restarted = [...right.keys()].filter((name) => left.has(name) && (left.get(name).id !== right.get(name).id || left.get(name).startedAt !== right.get(name).startedAt)).sort();
  return { added, removed, restarted, changed: [...new Set([...added, ...removed, ...restarted])].sort() };
}

// True only when the changed identities are exactly `expected` (every one of them changed, none other did).
export function onlyExpectedChanged(diff, expected) {
  const wanted = [...new Set(expected)].sort();
  return JSON.stringify(diff.changed) === JSON.stringify(wanted);
}

// ---------------------------------------------------------------------------
// Runner identity: exactly the three MPS keys of the saved share, one non-root user

export const RUNNER_PROCESSES_PROGRAM = String.raw`
const fs=require('node:fs');
const out=[];
for(const name of fs.readdirSync('/proc').filter((n)=>/^[1-9][0-9]*$/.test(n)).slice(0,4096)){
 try{
  const exe=fs.readlinkSync('/proc/'+name+'/exe');
  if(!exe.endsWith('/llama-server'))continue;
  const env=fs.readFileSync('/proc/'+name+'/environ','utf8').split('\0').filter(Boolean);
  const at=(e)=>e.indexOf('=');
  const stat=fs.readFileSync('/proc/'+name+'/stat','utf8');const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  const status=fs.readFileSync('/proc/'+name+'/status','utf8');const uid=(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)||[]).slice(1,5).map(Number);
  out.push({pid:Number(name),exe,start:tail[19],uid,envNames:env.map((e)=>e.slice(0,at(e))).sort().slice(0,96),cuda:Object.fromEntries(env.filter((e)=>e.startsWith('CUDA_')).map((e)=>[e.slice(0,at(e)),e.slice(at(e)+1,at(e)+161)]))});
 }catch(e){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))throw e;}
}
process.stdout.write(JSON.stringify({processes:out}));`;

const SECRET_WORDS = new Set(['KEY', 'KEYS', 'APIKEY', 'TOKEN', 'TOKENS', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'CREDENTIALS', 'COOKIE', 'COOKIES']);
export const isSecretName = (name) => String(name).toUpperCase().split(/[^A-Z0-9]+/).some((word) => SECRET_WORDS.has(word));

// `memory` is the share's CUDA_MPS_PINNED_DEVICE_MEM_LIMIT value, e.g. "0=3072M".
export function runnerIdentity(runnerProcess, { share, label = 'runner' }) {
  const problems = [];
  const cuda = runnerProcess.cuda ?? {};
  const names = Object.keys(cuda).sort();
  const missing = MPS_RUNNER_NAMES.filter((name) => !names.includes(name));
  const foreign = names.filter((name) => !MPS_RUNNER_NAMES.includes(name) && !RUNNER_PRODUCT_CUDA.includes(name));
  if (missing.length || foreign.length) problems.push(`${label}: the runner ${runnerProcess.pid} has CUDA variables ${names.join(',')}, not exactly the three MPS variables`);
  if (cuda.CUDA_MPS_PIPE_DIRECTORY !== MPS_PIPE_DIRECTORY || cuda.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE !== String(share.smPercent) || cuda.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT !== share.memory) {
    problems.push(`${label}: the runner ${runnerProcess.pid} sees ${JSON.stringify(Object.fromEntries(MPS_RUNNER_NAMES.map((name) => [name, cuda[name]])))}, not the saved share ${share.smPercent}% / ${share.memory}`);
  }
  if (Object.hasOwn(cuda, 'CUDA_CACHE_PATH') && !(typeof cuda.CUDA_CACHE_PATH === 'string' && /^\/[^\0]*$/.test(cuda.CUDA_CACHE_PATH) && !/^\/(?:data|shared)(?:\/|$)/.test(cuda.CUDA_CACHE_PATH))) {
    problems.push(`${label}: the runner ${runnerProcess.pid} keeps its CUDA cache outside the container's own filesystem`);
  }
  const secrets = (runnerProcess.envNames ?? []).filter((name) => isSecretName(name));
  if (secrets.length) problems.push(`${label}: the runner ${runnerProcess.pid} inherits secret-looking variables: ${secrets.join(',')}`);
  const uid = runnerProcess.uid ?? [];
  if (!(uid.length >= 2 && uid.every((value) => value === uid[0]) && uid[0] > 0)) problems.push(`${label}: the runner ${runnerProcess.pid} does not run as one non-root user`);
  // Only names and the three share values leave this function: never another value.
  return {
    ok: problems.length === 0,
    problems,
    identity: {
      pid: runnerProcess.pid,
      uid: uid[0] ?? null,
      mps: Object.fromEntries(MPS_RUNNER_NAMES.map((name) => [name, cuda[name] ?? null])),
      cudaNames: names,
    },
  };
}

export async function readRunnerProcesses({ run = defaultRun, boxName, agentName }) {
  validateBoxName(agentName);
  const parsed = checkedJson(await run('podman', [...nestedArgs(boxName), 'container', 'exec', agentName, 'node', '-e', RUNNER_PROCESSES_PROGRAM], { timeoutMs: 20_000 }), 'Runner process read');
  if (!parsed || !Array.isArray(parsed.processes)) throw new Error('Runner process read returned no process list.');
  return parsed.processes;
}

// ---------------------------------------------------------------------------
// GPU: inventory parsers (nvidia-smi -q -x), the A5 idle gate and the host observer

function textTag(xml, tag) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (matches.length !== 1) throw new Error(`Unsupported GPU ${tag} reply`);
  return matches[0][1].trim();
}
function optionalTag(xml, tag) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (matches.length > 1) throw new Error(`Unsupported GPU ${tag} reply`);
  return matches.length ? matches[0][1].trim() : null;
}

export const gpuQueryArgv = (uuid) => ['-q', '-x', '-i', uuid];

export function parseGpuInventory(xml, expectedUuid) {
  if (typeof xml !== 'string' || xml.length > 1048576 || /<!ENTITY|&(?!(?:amp|lt|gt|quot|apos);)|<!\[/.test(xml)
      || !xml.includes('</nvidia_smi_log>') || (xml.match(/<gpu\s+id=/g) || []).length !== 1) throw new Error('Unsupported GPU inventory');
  if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(String(expectedUuid)) || textTag(xml, 'uuid') !== expectedUuid || textTag(xml, 'compute_mode') !== 'Default') {
    throw new Error('GPU device or compute mode mismatch');
  }
  const device = /<gpu\s+id=[^>]*>([\s\S]*?)<\/gpu>/.exec(xml);
  const sections = [...xml.matchAll(/<processes>([\s\S]*?)<\/processes>/g)];
  const opens = (xml.match(/<processes>/g) || []).length;
  const closes = (xml.match(/<\/processes>/g) || []).length;
  if (!device || (xml.match(/<\/gpu>/g) || []).length !== 1) throw new Error('Unsupported GPU inventory');
  if (opens !== closes || sections.length !== opens || sections.length > 1) throw new Error('Ambiguous GPU process inventory structure');
  const section = sections[0];
  if (!section || !device[1].includes(section[0])) throw new Error('GPU activity inventory unavailable');
  const rows = [...section[1].matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)];
  const outside = section[1].replace(/<process_info>[\s\S]*?<\/process_info>/g, '').trim();
  if (/N\/A|Not Supported/i.test(outside)) throw new Error('GPU activity inventory unavailable');
  if (outside) throw new Error('Unknown GPU activity grammar');
  const details = rows.map((row) => {
    const pid = textTag(row[1], 'pid');
    const type = textTag(row[1], 'type');
    if (!/^[1-9][0-9]{0,9}$/.test(pid) || !GPU_PROCESS_TYPES.includes(type)) throw new Error('Malformed GPU process');
    const memory = optionalTag(row[1], 'used_memory');
    const found = memory === null ? null : /^([0-9]{1,9}) MiB$/.exec(memory);
    if (memory !== null && memory !== 'N/A' && !found) throw new Error('Malformed GPU process');
    return { pid: Number(pid), type, name: optionalTag(row[1], 'process_name')?.slice(0, 256) ?? null, memoryMiB: found ? Number(found[1]) : null };
  });
  return { uuid: expectedUuid, processes: details.map(({ pid, type }) => ({ pid, type })), details };
}

export function parseGpuMemory(xml) {
  const sections = typeof xml === 'string' ? [...xml.matchAll(/<fb_memory_usage>([\s\S]*?)<\/fb_memory_usage>/g)] : [];
  if (sections.length !== 1) throw new Error('Unsupported GPU memory reply');
  const read = (tag) => {
    const found = [...sections[0][1].matchAll(new RegExp(`<${tag}>([0-9]{1,9}) MiB</${tag}>`, 'g'))];
    if (found.length !== 1) throw new Error(`Unsupported GPU memory ${tag} reply`);
    return Number(found[0][1]);
  };
  const memory = { totalMiB: read('total'), usedMiB: read('used'), freeMiB: read('free') };
  if (memory.totalMiB <= 0 || memory.usedMiB > memory.totalMiB || memory.freeMiB > memory.totalMiB) throw new Error('Inconsistent GPU memory reply');
  return memory;
}

export function parseGpuUtilization(xml) {
  if (typeof xml !== 'string') return null;
  const sections = [...xml.matchAll(/<utilization>([\s\S]*?)<\/utilization>/g)];
  if (sections.length !== 1) return null;
  const found = [...sections[0][1].matchAll(/<gpu_util>([0-9]{1,3}) %<\/gpu_util>/g)];
  return found.length === 1 && Number(found[0][1]) <= 100 ? Number(found[0][1]) : null;
}

export function cgroupWithin(candidate, prefix) {
  return typeof candidate === 'string' && typeof prefix === 'string' && prefix.startsWith('/') && prefix.length > 1
    && (candidate === prefix || candidate.startsWith(`${prefix}/`));
}

// Host /proc observer: the identity of a process (boot ID, PID, start time), its cgroup, uid and PID namespaces.
export function createHostObserver({ fsApi = fs, procRoot = '/proc' } = {}) {
  const bootId = () => fsApi.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
  const observe = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid host PID');
    try {
      const stat = fsApi.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const status = fsApi.readFileSync(`${procRoot}/${pid}/status`, 'utf8');
      const cgroup = fsApi.readFileSync(`${procRoot}/${pid}/cgroup`, 'utf8');
      const uid = (/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status) || []).slice(1, 5).map(Number);
      const nspid = (/^NSpid:\s+([0-9\s]+)$/m.exec(status) || [, ''])[1].trim().split(/\s+/).filter(Boolean).map(Number);
      const unified = /^0::(\/.*)$/m.exec(cgroup);
      return {
        hostPid: pid,
        bootId: bootId(),
        startIdentity: String(tail[19]),
        ppid: Number(tail[1]),
        cgroup: unified ? unified[1] : '',
        uid,
        nspid,
      };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
      throw error;
    }
  };
  const scan = () => fsApi.readdirSync(procRoot).filter((name) => /^[1-9][0-9]*$/.test(name)).map(Number);
  return { bootId, observe, scan };
}

// Map an in-agent runner process (its PID in the agent's namespace and its start time) to exactly one host process of
// the agent's own container: a three-level PID namespace chain whose innermost PID and start identity are the same.
export function hostRunnerIdentities({ inner, containerId, observer, candidates = observer.scan() }) {
  if (!/^[a-f0-9]{64}$/.test(String(containerId))) throw new Error('Invalid agent container identity');
  return inner.map((process) => {
    const matches = candidates.map((pid) => observer.observe(pid)).filter((seen) => seen
      && seen.nspid.length === 3 && seen.nspid.at(-1) === process.pid && String(seen.startIdentity) === String(process.start)
      && seen.cgroup.includes(`libpod-${containerId}`));
    if (matches.length !== 1) throw new EvidenceBlocked(`The runner process ${process.pid} cannot be mapped to exactly one host process of the agent's cgroup (${matches.length}).`);
    return { hostPid: matches[0].hostPid, bootId: matches[0].bootId, startIdentity: matches[0].startIdentity, innerPid: process.pid };
  });
}

// The Box's own cgroup on the host, from the Box's main process.
export async function boxCgroupPrefix({ run = defaultRun, boxName, observer = createHostObserver() }) {
  const pid = Number(String(checked(await run('podman', ['container', 'inspect', '--format', '{{.State.Pid}}', validateBoxName(boxName)], { timeoutMs: 15_000 }), 'Box inspection')).trim());
  if (!Number.isSafeInteger(pid) || pid < 2) throw new EvidenceBlocked('The Box has no running main process.');
  const seen = observer.observe(pid);
  if (!seen || seen.cgroup.length < 2) throw new EvidenceBlocked('The Box main process has no readable cgroup.');
  return seen.cgroup;
}

function verifyOwned(record, observed, { bootId, boxCgroupPrefix: prefix }) {
  return Boolean(record && observed && observed.hostPid === record.hostPid && observed.bootId === record.bootId && bootId && observed.bootId === bootId
    && String(observed.startIdentity) === String(record.startIdentity) && cgroupWithin(observed.cgroup, prefix));
}

// Plan 15.5 with amendment A5, as a pure function over one parsed inventory.
//   owned:    records {hostPid, bootId, startIdentity} of processes the run created; each is re-observed.
//   tolerate: {mode: 'record'|'subset', recorded: [...]}; 'record' is the run's FIRST check.
// Returns {state: 'idle', tolerated, vanished} or {state: 'blocked', reason, ...}.
export function evaluateIdleGate({ inventory, owned = [], observe, bootId, boxCgroupPrefix: prefix, initial = false, tolerate = { mode: 'subset', recorded: [] } }) {
  const rows = inventory.details;
  const pids = rows.map((row) => row.pid);
  const withinLimit = (row) => row.type === 'G' && Number.isSafeInteger(row.memoryMiB) && row.memoryMiB >= 0 && row.memoryMiB <= A5_TOLERATED_MAX_MIB;
  const identityOf = (pid) => {
    let seen = null;
    try { seen = observe(pid); } catch { return null; }
    return seen && bootId && seen.bootId === bootId && seen.hostPid === pid && seen.startIdentity ? { bootId: seen.bootId, startIdentity: String(seen.startIdentity) } : null;
  };
  if (initial && tolerate.mode === 'record') {
    if (!pids.length) return { state: 'idle', tolerated: [], vanished: [] };
    const refused = rows.filter((row) => !withinLimit(row));
    if (refused.length) return { state: 'blocked', reason: 'gpu_busy', foreign: refused.map((row) => row.pid), why: 'not_tolerable' };
    if (rows.length > A5_TOLERATED_MAX) return { state: 'blocked', reason: 'gpu_busy', foreign: pids, why: 'too_many' };
    const tolerated = [];
    for (const row of rows) {
      const identity = identityOf(row.pid);
      if (!identity) return { state: 'blocked', reason: 'display_identity_unproved', hostPid: row.pid };
      tolerated.push({ kind: 'gpu-tolerated', hostPid: row.pid, bootId: identity.bootId, startIdentity: identity.startIdentity, name: row.name ?? null, type: 'G', memoryMiB: row.memoryMiB });
    }
    return { state: 'idle', tolerated, vanished: [] };
  }
  const verified = new Set();
  for (const record of owned) {
    if (!verifyOwned(record, observe(record.hostPid), { bootId, boxCgroupPrefix: prefix })) return { state: 'blocked', reason: 'owned_provenance_unproved', hostPid: record?.hostPid ?? null };
    verified.add(record.hostPid);
  }
  const recorded = new Map((tolerate.recorded || []).map((record) => [record.hostPid, record]));
  const stillTolerated = new Set();
  const present = [];
  const changed = [];
  for (const row of rows) {
    if (verified.has(row.pid)) continue;
    const record = recorded.get(row.pid);
    if (!record) continue;
    const identity = identityOf(row.pid);
    const same = identity && identity.bootId === record.bootId && identity.startIdentity === String(record.startIdentity);
    if (same && withinLimit(row)) { stillTolerated.add(row.pid); present.push(record); }
    else changed.push({ pid: row.pid, why: !same ? 'identity_changed' : row.type !== 'G' ? 'type_changed' : 'memory_over_limit' });
  }
  if (changed.length) return { state: 'blocked', reason: 'gpu_busy', foreign: changed.map((entry) => entry.pid), why: changed[0].why, changed };
  const foreign = pids.filter((pid) => !verified.has(pid) && !stillTolerated.has(pid));
  if (foreign.length) return { state: 'blocked', reason: 'gpu_busy', foreign, why: 'not_recorded' };
  const listed = new Set(pids);
  return { state: 'idle', tolerated: present, vanished: [...recorded.keys()].filter((pid) => !listed.has(pid)) };
}

// The GPU part of one gate check, reduced to what the analysis reads. `runnerHostPids` are the runner's host PIDs.
export function summarizeGpuCheck(label, checkedGpu, runnerHostPids, at = Date.now()) {
  const rows = checkedGpu.inventory.details.map((row) => ({ pid: row.pid, type: row.type, memoryMiB: row.memoryMiB }));
  const sum = (list) => (list.length && list.every((row) => Number.isFinite(row.memoryMiB)) ? list.reduce((total, row) => total + row.memoryMiB, 0) : null);
  const mine = rows.filter((row) => runnerHostPids.includes(row.pid));
  const ownedRows = rows.filter((row) => (checkedGpu.owned ?? []).includes(row.pid));
  return {
    label,
    at,
    usedMiB: checkedGpu.memory?.usedMiB ?? null,
    utilizationPercent: checkedGpu.utilization ?? null,
    rows,
    runnerMiB: sum(mine),
    ownedMiB: sum(ownedRows),
    runnerListed: mine.length,
    ownedListed: ownedRows.length,
  };
}

// The idle gate bound to one device. `query()` returns the raw `nvidia-smi -q -x -i UUID` text; a query or
// parse failure, a mode or device mismatch, an unsupported activity inventory or any foreign process BLOCKS.
// Once a foreign process has appeared the gate is tripped: no later check passes.
export function createIdleGate({ query, uuid, observer, boxPrefix, ownedPrefix = `${boxPrefix}/ploinky`, now = Date.now, sleep = realSleep }) {
  if (typeof query !== 'function' || !/^GPU-[a-fA-F0-9-]{8,64}$/.test(String(uuid)) || !observer || typeof boxPrefix !== 'string' || !boxPrefix.startsWith('/')) {
    throw new Error('The GPU gate needs its query, device UUID, host observer and Box cgroup prefix.');
  }
  const ownedRecords = new Map();
  const tolerated = new Map();
  const history = [];
  let tripped = null;
  let baseline = null;
  const read = async (label) => {
    let text;
    try { text = await query(); } catch (error) { throw new EvidenceBlocked(`GPU idle gate blocked: query_error (${String(error.message).slice(0, 200)})`, { reason: 'query_error', label }); }
    try {
      let parsed = { inventory: parseGpuInventory(text, uuid), memory: parseGpuMemory(text), utilization: parseGpuUtilization(text) };
      // A listed process may exit before the host can be asked about it (the MPS server leaves a moment after its last
      // client). Such a vanished PID is not evidence of foreign activity: the inventory is read again, a few times at most.
      for (let attempt = 0; attempt < 3 && parsed.inventory.processes.some((row) => observer.observe(row.pid) === null); attempt += 1) {
        await sleep(100);
        text = await query();
        parsed = { inventory: parseGpuInventory(text, uuid), memory: parseGpuMemory(text), utilization: parseGpuUtilization(text) };
      }
      return parsed;
    } catch (error) {
      const reason = /mismatch/.test(error.message) ? 'device_or_mode_mismatch' : /activity inventory unavailable|Unknown GPU activity/.test(error.message) ? 'activity_unknown' : 'unsupported_output';
      throw new EvidenceBlocked(`GPU idle gate blocked: ${reason} (${String(error.message).slice(0, 200)})`, { reason, label });
    }
  };
  const decide = (label, parsed, options) => {
    const outcome = evaluateIdleGate({ inventory: parsed.inventory, owned: [...ownedRecords.values()].filter((record) => parsed.inventory.processes.some((row) => row.pid === record.hostPid)),
      observe: (pid) => observer.observe(pid), bootId: observer.bootId(), boxCgroupPrefix: boxPrefix, ...options });
    history.push({ label, at: now(), listed: parsed.inventory.processes.map((row) => row.pid), freeMiB: parsed.memory.freeMiB, usedMiB: parsed.memory.usedMiB, tolerated: (outcome.tolerated || []).map((record) => record.hostPid), ...(outcome.vanished?.length ? { vanished: outcome.vanished } : {}) });
    if (history.length > 400) history.shift();
    if (outcome.state !== 'idle') {
      tripped = new EvidenceBlocked(`GPU idle gate blocked: ${outcome.reason}${outcome.why ? ` (${outcome.why})` : ''}`, { ...outcome, label });
      throw tripped;
    }
    return outcome;
  };
  return {
    get baseline() { return baseline; },
    get tripped() { return tripped; },
    history,
    registerOwned(record) {
      if (!record || !Number.isSafeInteger(record.hostPid)) throw new Error('An owned GPU process needs its host PID and identity.');
      ownedRecords.set(record.hostPid, { hostPid: record.hostPid, bootId: record.bootId, startIdentity: String(record.startIdentity) });
    },
    // The run's FIRST check: records what A5 tolerates (never more than one display process).
    async initial() {
      const parsed = await read('initial');
      const outcome = decide('initial', parsed, { initial: true, tolerate: { mode: 'record', recorded: [] } });
      for (const record of outcome.tolerated) tolerated.set(record.hostPid, record);
      baseline = Object.freeze({ uuid, computeMode: 'Default', memory: parsed.memory, at: now(), tolerated: outcome.tolerated.map((record) => ({ ...record })) });
      return baseline;
    },
    async check(label, { minFreeMiB = 0 } = {}) {
      if (tripped) throw tripped;
      if (!baseline) throw new EvidenceBlocked('The GPU gate was used before its initial check.');
      const parsed = await read(label);
      // A listed process whose host cgroup lies beneath the exact Box's delegated hierarchy belongs to this test's Box
      // (its MPS server, daemon and agent leaves); its tuple is recorded here and re-proved by every later check.
      for (const row of parsed.inventory.processes) {
        if (ownedRecords.has(row.pid) || tolerated.has(row.pid)) continue;
        const seen = observer.observe(row.pid);
        if (seen && cgroupWithin(seen.cgroup, ownedPrefix)) ownedRecords.set(row.pid, { hostPid: row.pid, bootId: seen.bootId, startIdentity: String(seen.startIdentity) });
      }
      const outcome = decide(label, parsed, { tolerate: { mode: 'subset', recorded: [...tolerated.values()] } });
      if (parsed.memory.freeMiB < minFreeMiB) {
        tripped = new EvidenceBlocked(`GPU idle gate blocked: insufficient_free_memory (${parsed.memory.freeMiB} MiB free, ${minFreeMiB} MiB needed)`, { reason: 'insufficient_free_memory', label });
        throw tripped;
      }
      return { ...parsed, owned: parsed.inventory.processes.map((row) => row.pid).filter((pid) => ownedRecords.has(pid)), tolerated: outcome.tolerated, vanished: outcome.vanished };
    },
  };
}

// ---------------------------------------------------------------------------
// The in-flight sampler. Every observation carries the real time its read started and returned, and is
// labelled only against the request windows (M-LLM-06): `in-flight` when the whole [startedAt, endedAt] lies
// inside ONE settled request window; `late` when it overlaps a window without lying inside it; otherwise
// `between-requests`. Only `in-flight` counts toward the minimums. A request that starts later never vouches
// for an earlier request's late sample.

export function classifyObservation(sample, windows) {
  const inside = windows.some((window) => window.settled !== null && sample.startedAt >= window.sent && sample.endedAt < window.settled);
  if (inside) return 'in-flight';
  const overlaps = windows.some((window) => sample.startedAt < (window.settled ?? Infinity) && sample.endedAt >= window.sent);
  return overlaps ? 'late' : 'between-requests';
}

export function inFlightCounts(cgroup, gpu) {
  return { cgroup: cgroup.filter((sample) => sample.label === 'in-flight').length, gpu: gpu.filter((sample) => sample.label === 'in-flight').length };
}

export function meetsInFlightMinimums(cgroup, gpu, minimums = INFERENCE_MIN_IN_FLIGHT) {
  const counts = inFlightCounts(cgroup, gpu);
  return counts.cgroup >= minimums.cgroup && counts.gpu >= minimums.gpu;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sustained load while sampling. `request(first)` sends one prompt and resolves with its reply;
 * `sampleLeaf(label)` resolves with one parsed leaf sample; `sampleGpu(label)` resolves with one
 * summarizeGpuCheck row. A reply may carry `window: {sent, settled}`, the exact request interval. Requests run back to back until both minimums were met by observations taken while a
 * request was outstanding, bounded in time and in count. The first valid reply is the evidence; a later reply
 * without text is a breach recorded in `load.invalidResponses`.
 */
export async function measureInference({
  request, sampleLeaf, sampleGpu, classify = classifyObservation, now = Date.now, sleep = realSleep,
  sampleMs = INFERENCE_CADENCE.sampleMs, gpuMs = INFERENCE_CADENCE.gpuMs, minInFlight = INFERENCE_MIN_IN_FLIGHT,
  sustainedMs = 60_000, maxRequests = 8,
}) {
  const cgroup = [];
  const gpu = [];
  const windows = [];
  const load = { boundMs: sustainedMs, maxRequests, requests: 0, completionTokens: 0, invalidResponses: 0, stoppedBy: null };
  const relabel = () => {
    for (const sample of [...cgroup, ...gpu]) {
      if (!['pending', 'in-flight', 'late', 'between-requests'].includes(sample.label)) continue;
      sample.label = classify(sample, windows);
    }
  };
  const takeLeaf = async (label) => {
    const startedAt = now();
    const taken = await sampleLeaf(label);
    cgroup.push({ label, startedAt, endedAt: now(), ...taken });
  };
  const takeGpu = async (label) => {
    const startedAt = now();
    const taken = await sampleGpu(label);
    gpu.push({ ...taken, label, startedAt, endedAt: now() });
  };
  let kept = null;
  let failure = null;
  const startedAt = now();
  try {
    await takeLeaf('before-send');
    await takeGpu('before-send');
    const oneRequest = async (first) => {
      let done = false;
      const window = { sent: now(), settled: null };
      windows.push(window);
      const pending = Promise.resolve(request(first)).finally(() => { done = true; window.settled = now(); });
      const settled = pending.then(() => null, () => null);
      const loop = async (every, take) => {
        while (!done) {
          await Promise.race([settled, sleep(every)]);
          if (done) break;
          await take('pending');
        }
      };
      try {
        await Promise.all([loop(sampleMs, takeLeaf), loop(gpuMs, takeGpu)]);
      } catch (error) {
        await settled;
        throw error;
      }
      const reply = await pending;
      // A reply may carry the exact [sent, settled) interval the requester recorded at the call itself (the browser's
      // own tool call), which is narrower and more exact than the interval this loop saw around an awaited UI action.
      if (Number.isFinite(reply?.window?.sent) && Number.isFinite(reply?.window?.settled) && reply.window.settled >= reply.window.sent) {
        window.sent = reply.window.sent;
        window.settled = reply.window.settled;
      }
      return reply;
    };
    const until = now() + sustainedMs;
    for (;;) {
      load.requests += 1;
      const reply = await oneRequest(load.requests === 1);
      relabel();
      load.completionTokens += Number.isFinite(Number(reply?.completionTokens)) ? Number(reply.completionTokens) : 0;
      if (kept === null) kept = reply;
      else if (typeof reply?.text !== 'string' || !reply.text.trim()) load.invalidResponses += 1;
      const counts = inFlightCounts(cgroup, gpu);
      if (counts.cgroup >= minInFlight.cgroup && counts.gpu >= minInFlight.gpu) { load.stoppedBy = 'minimums-met'; break; }
      if (now() >= until) { load.stoppedBy = 'time-bound'; break; }
      if (load.requests >= maxRequests) { load.stoppedBy = 'request-bound'; break; }
    }
    await takeLeaf('after-response');
    await takeGpu('after-response');
  } catch (error) {
    failure = error;
  }
  relabel();
  return { cgroup, gpu, windows, load, kept, failure, windowMs: now() - startedAt };
}

// ---------------------------------------------------------------------------
// The analysis of the deployed Ploinky clone (liveLlmCommands.mjs): classifyObservation and analyzeInference.

// The delayed-read vector: reads that take 40 ms against requests of 8 ms are never in flight.
const PARITY_VECTORS = Object.freeze([
  { sample: { startedAt: 100, endedAt: 140 }, windows: [{ sent: 100, settled: 108 }], expected: 'late' },
  { sample: { startedAt: 102, endedAt: 105 }, windows: [{ sent: 100, settled: 108 }], expected: 'in-flight' },
  { sample: { startedAt: 100, endedAt: 140 }, windows: [{ sent: 100, settled: 108 }, { sent: 110, settled: 150 }], expected: 'late' },
  { sample: { startedAt: 200, endedAt: 210 }, windows: [{ sent: 100, settled: 108 }], expected: 'between-requests' },
]);

export async function loadDeployedAnalysis({ ploinkyRoot, importModule = (url) => import(url) }) {
  if (!path.isAbsolute(String(ploinkyRoot || ''))) throw new Error('The deployed Ploinky clone path must be absolute.');
  const file = path.join(ploinkyRoot, 'tests', 'hardware-limits', 'liveLlmCommands.mjs');
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`The deployed Ploinky clone has no ${file}; the analysis cannot be loaded.`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The deployed analysis module must be one regular file.');
  const module = await importModule(pathToFileURL(file).href);
  for (const name of ['classifyObservation', 'analyzeInference']) {
    if (typeof module[name] !== 'function') throw new Error(`The deployed analysis module does not export ${name}.`);
  }
  if (JSON.stringify(module.INFERENCE_MIN_IN_FLIGHT) !== JSON.stringify(INFERENCE_MIN_IN_FLIGHT)) {
    throw new Error('The deployed in-flight minimums differ from the executor\'s (3 CPU/RAM samples, 2 GPU samples).');
  }
  for (const vector of PARITY_VECTORS) {
    const observed = module.classifyObservation(vector.sample, vector.windows);
    if (observed !== vector.expected || classifyObservation(vector.sample, vector.windows) !== vector.expected) {
      throw new Error(`The deployed classifyObservation answers "${observed}" for a vector that must be "${vector.expected}".`);
    }
  }
  return Object.freeze({ file, analyzeInference: module.analyzeInference, classifyObservation: module.classifyObservation });
}

// ---------------------------------------------------------------------------
// Evidence output: no cookies, CSRF values, full environments or credentials (spec 1213)

const SECRET_KEY = /cookie|csrf|authorization|passw|secret|api[-_]?key|jwt|bearer|session/i;
const ENVIRONMENT_KEY = /^(?:env|environ|environment|Env)$/;
const SECRET_VALUE = /ploinky_jwt=|x-ploinky-(?:browser-)?csrf-token|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./i;

export function sanitizeEvidence(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted]' : value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitizeEvidence(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) || ENVIRONMENT_KEY.test(key) ? '[redacted]' : sanitizeEvidence(entry, depth + 1)]));
  }
  return value;
}

// Throws when the already-sanitized text still carries a recognisable credential.
export function assertNoCredentials(text, label = 'evidence') {
  if (SECRET_VALUE.test(String(text))) throw new Error(`The ${label} would contain a cookie, CSRF value or token.`);
}

export function createEvidenceWriter({ dir }) {
  if (!path.isAbsolute(String(dir || ''))) throw new Error('The evidence directory must be absolute.');
  return {
    dir,
    write(name, value) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('Invalid evidence file name.');
      const text = `${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`;
      assertNoCredentials(text, `evidence ${name}`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      fs.writeFileSync(target, text, { mode: 0o600 });
      return target;
    },
  };
}

// ---------------------------------------------------------------------------
// Environment prerequisites (fail closed: a missing prerequisite is an error, never a skip)

// Only variables the plan documents (C2 common environment): SMOKE_DEPLOYMENT_MODE, SMOKE_BASE_URL, SMOKE_PLOINKY_BOX_CONTAINER.
export function requireHardwareEnvironment(env = process.env) {
  const problems = [];
  if (String(env.SMOKE_DEPLOYMENT_MODE || '').trim() !== 'box') problems.push('SMOKE_DEPLOYMENT_MODE must be "box"');
  if (!String(env.SMOKE_BASE_URL || '').trim()) problems.push('SMOKE_BASE_URL must name the Router of the E2E deployment');
  if (!BOX_NAME.test(String(env.SMOKE_PLOINKY_BOX_CONTAINER || ''))) problems.push('SMOKE_PLOINKY_BOX_CONTAINER must name the exact Box container');
  if (problems.length) throw new Error(`The hardware-limits executors cannot run: ${problems.join('; ')}.`);
  return { boxName: String(env.SMOKE_PLOINKY_BOX_CONTAINER) };
}

// ---------------------------------------------------------------------------
// The administrator API of /api/marketplace/hardware-limits, over a Playwright APIRequestContext (cookies of the
// signed-in page). The CSRF proof stays inside this object: results never carry it.

export const HARDWARE_ENDPOINT = '/api/marketplace/hardware-limits';

export function parseProof(payload) {
  const control = payload?.adminControl !== undefined;
  const proof = control ? payload.adminControl : payload?.browserMutation;
  const csrfToken = String(proof?.csrfToken || '').trim();
  const origin = String(proof?.origin || '').trim();
  if (payload?.ok !== true || !origin || !csrfToken) throw new Error('The session offers no administrator mutation proof.');
  return { origin, csrfToken, header: control ? 'x-ploinky-csrf-token' : 'x-ploinky-browser-csrf-token' };
}

async function bodyOf(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: String(text).slice(0, 500) }; }
}

export function createHardwareApi({ request, endpoint = HARDWARE_ENDPOINT }) {
  if (!request || typeof request.get !== 'function' || typeof request.post !== 'function') throw new Error('The hardware API needs an API request context.');
  const proof = async () => {
    const response = await request.get('/auth/token', { headers: { accept: 'application/json', connection: 'close' }, maxRetries: 0 });
    if (response.status() !== 200) throw new Error(`The session proof request answered ${response.status()}.`);
    return parseProof(await bodyOf(response));
  };
  return {
    // A GET; `headers` lets a probe add a Bearer header.
    async read({ headers = {} } = {}) {
      const response = await request.get(endpoint, { headers: { accept: 'application/json', connection: 'close', ...headers }, maxRetries: 0 });
      return { status: response.status(), body: await bodyOf(response) };
    },
    async readOk() {
      const result = await this.read();
      if (result.status !== 200 || result.body?.ok !== true) throw new Error(`The hardware snapshot answered ${result.status} (${String(result.body?.error || 'no error code')}).`);
      return result.body;
    },
    // A POST with the real proof. `origin` overrides the Origin header (a wrong-origin probe); `rawBody` sends bytes as they are.
    async post(body, { origin, rawBody, headers = {}, withProof = true } = {}) {
      const session = withProof ? await proof() : null;
      const text = rawBody !== undefined ? rawBody : JSON.stringify(body);
      const response = await request.post(endpoint, {
        data: text,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          connection: 'close',
          ...(session ? { origin: origin ?? session.origin, [session.header]: session.csrfToken } : {}),
          ...headers,
        },
        maxRetries: 0,
      });
      return { status: response.status(), body: await bodyOf(response) };
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot readers (pure)

export function tokenOf(snapshot) {
  const token = snapshot?.token;
  if (!token || typeof token.epoch !== 'string' || !Number.isSafeInteger(token.revision)) throw new Error('The snapshot carries no policy token.');
  return { epoch: token.epoch, revision: token.revision };
}
export const sameToken = (left, right) => Boolean(left && right && left.epoch === right.epoch && left.revision === right.revision);
export const agentByRef = (snapshot, ref) => (snapshot?.agents || []).find((agent) => agent.ref === ref) || null;
export const instanceByKey = (snapshot, key) => {
  for (const agent of snapshot?.agents || []) for (const instance of agent.containers || []) if (instance.key === key) return { agent, instance };
  return null;
};

// The one installed agent whose ref ends in `/name`, with exactly one ready instance: a target an Apply may recreate.
export function findSingleInstanceAgent(snapshot, name) {
  const matches = (snapshot?.agents || []).filter((agent) => agent.ref.endsWith(`/${name}`) && agent.orphaned !== true);
  if (matches.length !== 1) throw new Error(`The E2E graph must have exactly one installed agent named ${name}; found ${matches.length}.`);
  const [agent] = matches;
  if ((agent.containers || []).length !== 1 || agent.containers[0].availability !== 'ready') {
    throw new Error(`${agent.ref} must have exactly one ready instance (it has ${(agent.containers || []).map((instance) => instance.availability).join(',') || 'none'}).`);
  }
  return { agent, instance: agent.containers[0] };
}

export async function waitFor(read, { timeoutMs = 60_000, intervalMs = 1000, label = 'condition', sleep = realSleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (last) return last;
    if (now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
    await sleep(intervalMs);
  }
}
