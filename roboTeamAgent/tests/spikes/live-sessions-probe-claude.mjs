#!/usr/bin/env node
import fs from 'node:fs/promises';
import net from 'node:net';
import readline from 'node:readline';
import path from 'node:path';

// Deterministic Claude stream-json protocol fixture. No provider calls.
if (process.argv.includes('--version')) { console.log('2.1.0 (P3 diagnostic fixture)'); process.exit(0); }
const args = process.argv.slice(2);
const sessionId = args[args.indexOf('--session-id') + 1];
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
async function connect(socketPath) {
    return new Promise(resolve => {
        const socket = net.connect(socketPath);
        const timer = setTimeout(() => finish('TIMEOUT'), 5000);
        const finish = error => { clearTimeout(timer); socket.destroy(); resolve({ path: socketPath, error }); };
        socket.once('connect', () => finish('CONNECTED'));
        socket.once('error', error => finish(error.code || 'UNKNOWN'));
    });
}
const lines = readline.createInterface({ input: process.stdin });
let executed = false;
for await (const line of lines) {
    const record = JSON.parse(line);
    if (record.type === 'control_request') {
        out({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: {} } });
    } else if (record.type === 'user') {
        if (executed) throw new Error('Only one diagnostic turn is allowed');
        executed = true;
        const plan = JSON.parse(await fs.readFile(path.join(process.cwd(), '.p3-spike-plan.json'), 'utf8'));
        if (plan.kind !== 'actual-bwrap-spawn') throw new Error('Missing actual bwrap capture');
        const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
            const fields = line.split(' ');
            return { id: fields[0], parent: fields[1], device: fields[2], root: fields[3], target: fields[4],
                options: fields[5], type: fields[fields.indexOf('-') + 1] };
        });
        const aliases = [...new Set(plan.sockets.flatMap(entry => entry.aliases))].sort();
        const results = [];
        for (const alias of aliases) results.push(await connect(alias));
        const result = JSON.stringify({ kind: 'sandbox-socket-probe', pid: process.pid, uid: process.getuid(),
            mountNamespace: await fs.readlink('/proc/self/ns/mnt'), cwd: process.cwd(), mounts, results });
        out({ type: 'system', subtype: 'init', session_id: sessionId });
        out({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId });
    }
}
