#!/usr/bin/env node
// Prints the path of the MCP tool configuration AgentServer should load. Without the worker that is mcp-config.json itself (nothing
// is printed and AgentServer keeps its default lookup). With ROBOTEAM_WORKER_COORDINATOR_BASE set it writes the list without the
// tools a worker deployment does not offer (server/mcp-tool-list.mjs) into a fresh private directory (a predictable path in the
// shared temporary directory could be pre-created or linked by another process) and prints that file's path. Any failure exits
// non-zero, so startAgent.sh (set -eu) does not start without the list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolConfigFor } from '../server/mcp-tool-list.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerMode = String(process.env.ROBOTEAM_WORKER_COORDINATOR_BASE || '').trim() !== '';
if (workerMode) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'mcp-config.json'), 'utf8'));
    // mkdtemp creates the directory exclusively with mode 0700; the file is created exclusively inside it.
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roboteam-mcp-')), 'mcp-config.json');
    fs.writeFileSync(target, `${JSON.stringify(toolConfigFor(config, { workerMode }), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${target}\n`);
}
