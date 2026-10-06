import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^\s*```[\s\S]*?\n/, '')
    .replace(/\n```[\s\S]*$/m, '')
    .trim();
}

async function runGitMergeFile(oursPath, basePath, theirsPath) {
  return new Promise((resolve) => {
    execFile('git', ['merge-file', '-p', oursPath, basePath, theirsPath], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function hasConflictMarkers(text) {
  return text.includes('<<<<<<<') || text.includes('>>>>>>>') || text.includes('=======');
}

async function tryDeterministicMerge({ base = '', ours = '', theirs = '' } = {}) {
  if (!ours && !theirs) return null;
  let tempDir = '';
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-merge-'));
    const basePath = path.join(tempDir, 'base');
    const oursPath = path.join(tempDir, 'ours');
    const theirsPath = path.join(tempDir, 'theirs');
    await fs.writeFile(basePath, base ?? '', 'utf8');
    await fs.writeFile(oursPath, ours ?? '', 'utf8');
    await fs.writeFile(theirsPath, theirs ?? '', 'utf8');
    const { stdout } = await runGitMergeFile(oursPath, basePath, theirsPath);
    if (!stdout || hasConflictMarkers(stdout)) {
      return null;
    }
    return stdout;
  } catch {
    return null;
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function getDefaultAgent() {
  const { getDefaultLLMAgent, registerDefaultLLMAgent } = await import('achillesAgentLib/LLMAgents');
  return (typeof getDefaultLLMAgent === 'function' && getDefaultLLMAgent())
    || (typeof registerDefaultLLMAgent === 'function' && registerDefaultLLMAgent());
}

function buildPrompt({ base = '', ours = '', theirs = '', source = '' } = {}) {
  const header = [
    'You are resolving a git merge conflict for a single file.',
    'Return ONLY the fully resolved file content.',
    'Do NOT include conflict markers, markdown, or explanations.',
    'Strategy: prefer OURS (local). If changes are non-overlapping, include both. If overlapping, keep OURS and drop THEIRS.',
    source ? `Conflict source: ${source}` : '',
    '',
    '[BASE]',
    base || '',
    '[/BASE]',
    '',
    '[OURS]',
    ours || '',
    '[/OURS]',
    '',
    '[THEIRS]',
    theirs || '',
    '[/THEIRS]'
  ].filter(Boolean).join('\n');
  return header;
}

export default async function resolveConflict(input, context = {}) {
  let payload = input;
  if (typeof payload === 'string') {
    const parsed = safeParseJson(payload.trim());
    if (parsed) payload = parsed;
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid input. Expected { base, ours, theirs, source? }.');
  }
  const base = String(payload.base ?? '');
  const ours = String(payload.ours ?? '');
  const theirs = String(payload.theirs ?? '');
  const source = String(payload.source ?? '');

  if (!ours && !theirs) {
    throw new Error('Missing ours/theirs content.');
  }

  const deterministic = await tryDeterministicMerge({ base, ours, theirs });
  if (typeof deterministic === 'string' && deterministic.trim()) {
    return deterministic;
  }

  const agent = await getDefaultAgent();
  if (!agent) {
    throw new Error('No default LLM agent available.');
  }

  const prompt = buildPrompt({ base, ours, theirs, source });
  const raw = await agent.executePrompt(prompt, { model: 'fast', responseShape: 'text' });
  const resolved = stripFences(raw);
  if (!resolved) {
    throw new Error('AI returned an empty resolution.');
  }
  return resolved;
}
