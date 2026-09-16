import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { smokeConfig } from './config.mjs';
import {
  collectLiveBoxEvidence,
  parseLocalScreenBaseUrl,
  selectLocalScreenContainer,
} from './live-box.mjs';
import { readExpectedRouterBindAddress } from './router-bind-address.mjs';

export const BOX_DPU_DATA_ROOT = '/workspace/.data/dpu-data';
const BOX_WORKSPACE_ROOT = '/workspace';
const MAX_BUFFER = 64 * 1024 * 1024;
const READ_FILE_SCRIPT = [
  "const fs = require('node:fs');",
  'process.stdout.write(fs.readFileSync(process.argv[1]));',
].join('');
const WRITE_FILE_SCRIPT = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[1], fs.readFileSync(0));',
].join('');

function isBoxDeployment() {
  return String(process.env.SMOKE_DEPLOYMENT_MODE || '').trim() === 'box';
}

export function resolveDpuBoxEndpoint({
  deploymentMode = String(process.env.SMOKE_DEPLOYMENT_MODE || '').trim(),
  boxBaseURL = process.env.SMOKE_BOX_BASE_URL,
} = {}) {
  if (deploymentMode !== 'box') {
    throw new Error('DPU Box evidence is available only with SMOKE_DEPLOYMENT_MODE=box.');
  }
  const value = String(boxBaseURL || '').trim();
  if (!value) {
    throw new Error('SMOKE_DEPLOYMENT_MODE=box requires an explicit loopback SMOKE_BOX_BASE_URL.');
  }
  try {
    return parseLocalScreenBaseUrl(value);
  } catch (error) {
    throw new Error(
      'SMOKE_BOX_BASE_URL must be an exact credential-free http://127.0.0.1:<port> URL.',
      { cause: error },
    );
  }
}

function safeRelativePath(segments) {
  const parts = segments
    .flatMap((segment) => String(segment || '').split(/[\\/]+/))
    .filter(Boolean);
  if (parts.includes('..')) {
    throw new Error(`DPU evidence path contains a parent traversal segment: ${JSON.stringify(parts)}.`);
  }
  const raw = parts.join('/');
  const normalized = path.posix.normalize(`/${raw}`).replace(/^\/+/, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new Error(`DPU evidence path escapes its root: ${JSON.stringify(raw)}.`);
  }
  return normalized === '.' ? '' : normalized;
}

function localPath(...segments) {
  const relative = safeRelativePath(segments);
  const root = path.resolve(smokeConfig.dpuDataRoot);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`DPU evidence path escapes ${root}.`);
  }
  return target;
}

function boxPath(root, ...segments) {
  const relative = safeRelativePath(segments);
  return relative ? path.posix.join(root, relative) : root;
}

function runPodman(args, {
  input,
  encoding = null,
  allowStatus = [],
} = {}) {
  const result = spawnSync('podman', args, {
    encoding,
    input,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr || '');
    throw new Error(
      `podman ${args.slice(0, 3).join(' ')} failed with exit ${result.status ?? 'unknown'}: ${stderr.trim()}`,
    );
  }
  return result;
}

let selectedOuterContainer = '';

function inspectExplicitOuterContainer(expectedName) {
  const inspection = runPodman([
    'container',
    'inspect',
    expectedName,
  ], { encoding: 'utf8' });
  let records;
  try {
    records = JSON.parse(inspection.stdout);
  } catch (error) {
    throw new Error(`Explicit Box outer container inspection returned invalid JSON: ${error.message}`);
  }
  const local = resolveDpuBoxEndpoint();
  const selected = selectLocalScreenContainer(records, local.port, {
    expectedRouterBindAddress: readExpectedRouterBindAddress(),
  });
  const actualName = String(selected.Name || '').replace(/^\//, '');
  if (actualName !== expectedName) {
    throw new Error(`Explicit Box outer container resolved to ${actualName || '<unknown>'}, expected ${expectedName}.`);
  }
  return actualName;
}

function outerContainerName() {
  if (!selectedOuterContainer) {
    const explicitName = String(process.env.SMOKE_PLOINKY_BOX_CONTAINER || '').trim();
    const local = resolveDpuBoxEndpoint();
    selectedOuterContainer = explicitName
      ? inspectExplicitOuterContainer(explicitName)
      : collectLiveBoxEvidence({ baseURL: local.baseURL }).box.containerName;
  }
  return selectedOuterContainer;
}

function boxExists(target) {
  const result = runPodman([
    'exec',
    outerContainerName(),
    'test',
    '-e',
    target,
  ], { allowStatus: [1] });
  return result.status === 0;
}

function boxRead(target) {
  return runPodman([
    'exec',
    outerContainerName(),
    'node',
    '-e',
    READ_FILE_SCRIPT,
    target,
  ]).stdout;
}

function boxWrite(target, contents) {
  runPodman([
    'exec',
    '-i',
    outerContainerName(),
    'node',
    '-e',
    WRITE_FILE_SCRIPT,
    target,
  ], { input: contents });
}

export const dpuData = Object.freeze({
  exists(...segments) {
    if (isBoxDeployment()) return boxExists(boxPath(BOX_DPU_DATA_ROOT, ...segments));
    return fs.existsSync(localPath(...segments));
  },

  readBuffer(...segments) {
    if (isBoxDeployment()) return boxRead(boxPath(BOX_DPU_DATA_ROOT, ...segments));
    return fs.readFileSync(localPath(...segments));
  },

  readText(...segments) {
    return this.readBuffer(...segments).toString('utf8');
  },

  readJson(...segments) {
    return JSON.parse(this.readText(...segments));
  },

  writeJson(segments, value) {
    const pathSegments = Array.isArray(segments) ? segments : [segments];
    const contents = Buffer.from(JSON.stringify(value, null, 2));
    if (isBoxDeployment()) {
      boxWrite(boxPath(BOX_DPU_DATA_ROOT, ...pathSegments), contents);
      return;
    }
    fs.writeFileSync(localPath(...pathSegments), contents);
  },

  workspaceFileExists(documentPath) {
    const relative = safeRelativePath([documentPath]);
    if (isBoxDeployment()) return boxExists(boxPath(BOX_WORKSPACE_ROOT, relative));
    if (!smokeConfig.workspaceRoot) return false;
    const root = path.resolve(smokeConfig.workspaceRoot);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Workspace evidence path escapes ${root}.`);
    }
    return fs.existsSync(target);
  },

  describe(...segments) {
    if (isBoxDeployment()) {
      return `${outerContainerName()}:${boxPath(BOX_DPU_DATA_ROOT, ...segments)}`;
    }
    return localPath(...segments);
  },
});
