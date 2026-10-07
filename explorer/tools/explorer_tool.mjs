#!/usr/bin/env node
import { createExplorerToolRuntime } from '../utils/server/tool-runtime.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EMPTY_TEXT_SENTINEL = '__ASSISTOS_EXPLORER_EMPTY_TEXT__';

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function normalizeEnvelope(payload, toolEnv) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const args = input.input && typeof input.input === 'object'
    ? input.input
    : input.arguments && typeof input.arguments === 'object'
      ? input.arguments
      : {};
  return {
    toolName: String(input.tool || toolEnv.TOOL_NAME || '').trim(),
    args,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
}

async function writeToolResult(result, stdout) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  let output;
  if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
    output = blocks[0].text.length ? blocks[0].text : EMPTY_TEXT_SENTINEL;
  } else {
    output = JSON.stringify(result ?? {});
  }
  let onError;
  try {
    await new Promise((resolve, reject) => {
      onError = reject;
      stdout.once('error', onError);
      stdout.write(output, (error) => error ? reject(error) : resolve());
    });
  } finally {
    stdout.removeListener('error', onError);
  }
}

export async function handleExplorerToolCall({
  envelope,
  toolEnv = {},
  stdout = process.stdout,
  createRuntime = createExplorerToolRuntime
}) {
  const { toolName, args, metadata } = normalizeEnvelope(envelope, toolEnv);
  if (!toolName) {
    throw new Error('Explorer tool name is missing.');
  }
  const runtime = await createRuntime({ env: { ...process.env, ...toolEnv } });
  try {
    const result = await runtime.callTool(toolName, args, metadata);
    await writeToolResult(result, stdout);
  } finally {
    await runtime.dispose();
  }
}

async function main() {
  const raw = await readStdin();
  await handleExplorerToolCall({ envelope: safeParseJson(raw), toolEnv: process.env });
}

function isDirectExecution() {
  try {
    return Boolean(process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
