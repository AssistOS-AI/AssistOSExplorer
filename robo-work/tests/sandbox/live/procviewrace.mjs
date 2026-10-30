// F13 live probe: a multi-threaded process killed with SIGKILL is, for a moment, a leader whose descriptors are unreadable. This
// kills such processes repeatedly while listing /proc with procView, and counts what procView does in that window.
//   node procviewrace.mjs [path-to-procView.mjs]      (default: the procView next to this tree)
// Prints one JSON line: { module, kills, listings, throws: { <code>: n }, opaqueSeen, opaqueStates }. With the old procView `throws`
// is non-zero (proc_unreadable); with the fixed one it is {} and opaqueSeen counts the dying leaders it kept in the list.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2] ?? new URL('../../../server/execution/procView.mjs', import.meta.url).pathname;
const { createProcView } = await import(pathToFileURL(modulePath).href);
const view = createProcView({});
const child = 'const { Worker } = require("worker_threads"); for (let i = 0; i < 12; i += 1) new Worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)", { eval: true }); setTimeout(() => process.stdout.write("up\\n"), 300); setInterval(() => {}, 1e6);';
const result = { module: modulePath, kills: 0, listings: 0, throws: {}, opaqueSeen: 0, opaqueStates: {} };
for (let round = 0; round < 25; round += 1) {
    const c = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => c.stdout.once('data', resolve));
    const pid = c.pid;
    process.kill(pid, 'SIGKILL');
    result.kills += 1;
    const deadline = Date.now() + 100;
    while (Date.now() < deadline) {
        try {
            const listed = view.listProcesses();
            result.listings += 1;
            for (const entry of listed) if (entry.opaque) {
                result.opaqueSeen += 1;
                let state = '?';
                try { state = /State:\s*(\S)/.exec(fs.readFileSync(`/proc/${entry.pid}/status`, 'utf8'))?.[1] ?? '?'; } catch { state = 'gone'; }
                result.opaqueStates[state] = (result.opaqueStates[state] ?? 0) + 1;
            }
        } catch (error) {
            result.throws[error.code ?? error.name] = (result.throws[error.code ?? error.name] ?? 0) + 1;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => { c.once('exit', resolve); setTimeout(resolve, 200); });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
