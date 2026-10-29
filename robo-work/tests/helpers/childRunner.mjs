// Parent-side helper that races SYNTHETIC child processes against one temporary store.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stateChild.mjs');

function start(spec) {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(spec)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    const waiters = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
        lines.push(line);
        while (waiters.length > 0 && lines.length > 0) waiters.shift()(lines.shift());
    });
    const nextLine = () => new Promise((resolve) => {
        if (lines.length > 0) resolve(lines.shift());
        else waiters.push(resolve);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    return { child, nextLine, exited, stderr: () => stderr };
}

// Starts every child, waits until all are open, releases them together, collects results.
export async function raceChildren(specs) {
    const children = specs.map(start);
    for (const entry of children) {
        const first = await Promise.race([entry.nextLine(), entry.exited.then(() => 'exited')]);
        if (first !== 'ready') throw new Error(`child did not become ready: ${entry.stderr().slice(0, 300)}`);
    }
    for (const entry of children) entry.child.stdin.write('go\n');
    const results = [];
    for (const entry of children) {
        const exit = await entry.exited;
        const rest = [];
        const line = await Promise.race([entry.nextLine(), Promise.resolve(null)]);
        if (line) rest.push(line);
        results.push({ ...exit, output: rest.length > 0 ? JSON.parse(rest[0]) : null });
    }
    return results;
}

export async function runChild(spec) {
    return (await raceChildren([spec]))[0];
}
