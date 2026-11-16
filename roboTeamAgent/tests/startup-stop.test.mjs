import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { spawn } from 'node:child_process';

// Ploinky's targeted restart takes only exit status 0 as the acknowledgement of a drain; an end by signal is refused.
function stopChild(body) {
    const moduleUrl = new URL('../server/startup-stop.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { acknowledgeStopsUntilListening } from ${JSON.stringify(moduleUrl)};
${body}
process.stdout.write('installed\\n');
setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, stdout }));
    });
    // A child that ends before it has installed its handlers fails the test at once instead of leaving it to wait.
    const installed = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('installed\n')) resolve(); });
        exited.then(result => reject(new Error(`the child ended before installing its handlers: ${JSON.stringify(result)}`)), reject);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    return { child, installed, exited: exited.finally(() => clearTimeout(timeout)) };
}

test('a stop that arrives before the service listens is acknowledged with exit status 0', async () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
        const { child, installed, exited } = stopChild('acknowledgeStopsUntilListening();');
        await installed;
        child.kill(signal);
        assert.deepEqual(await exited, { code: 0, signal: null, stdout: 'installed\n' }, signal);
    }
});

test('after the hand-over only the service shutdown answers a stop', async () => {
    const { child, installed, exited } = stopChild(`
const handOver = acknowledgeStopsUntilListening();
handOver(() => { process.stdout.write('shutdown\\n'); setTimeout(() => process.exit(7), 50); });`);
    await installed;
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 7, signal: null, stdout: 'installed\nshutdown\n' });
});

test('the service acknowledges stops from before its first asynchronous step until its shutdown takes over', async () => {
    const main = await fs.readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');
    const install = main.indexOf('const handStopsToShutdown = acknowledgeStopsUntilListening();');
    const handOver = main.indexOf('handStopsToShutdown(shutdown);');
    assert.ok(install >= 0 && handOver > install);
    assert.equal(/\bawait\b/.test(main.slice(0, install).replace(/^import .*$/gm, '')), false, 'nothing is awaited before the handler is installed');
    assert.ok(handOver > main.indexOf('server.listen('));
    // Any other handler would run beside these two and could end the process before the shutdown finished.
    assert.equal(/process\.(on|once|addListener)\(\s*['"]SIG/.test(main), false);
});
