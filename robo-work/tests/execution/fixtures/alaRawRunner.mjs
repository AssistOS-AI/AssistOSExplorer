// Runs ONE case of ALA's raw-wire conformance suite as the ALA side of a symmetric topology: this process was started
// by the non-Node parent with NODE_CHANNEL_FD=3, so `process` is its provider channel. The suite file is imported from
// the ALA checkout (read-only) and is handed a collecting `test` function, so exactly the named case runs.
//
//   node alaRawRunner.mjs <exact case name>      env: ALA_ROOT
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , caseName] = process.argv;
const result = { name: caseName, found: false, ok: false, error: null };
const out = () => new Promise((resolve) => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));

try {
    const suite = await import(pathToFileURL(path.join(process.env.ALA_ROOT, 'tests/provider-conformance.mjs')).href);
    // A connected socket for the "client message carries a handle" case, made before the case runs.
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted = once(server, 'connection');
    const kept = net.connect(server.address().port, '127.0.0.1');
    kept.on('error', () => {});
    await once(kept, 'connect');
    const [passed] = await accepted;
    server.close();

    const cases = new Map();
    const harness = {
        view: { home: '/home/robot', cwd: '/projects/g', folder: '/projects/g', outside: '/outside' },
        readOnlyFolder: '/projects/ro',
        makeHandle: () => [passed],
        openRaw: async () => ({ channel: process, close: async () => { if (process.connected) process.disconnect(); } })
    };
    suite.defineRawWireConformance({ label: 'robo-work provider endpoint', test: (name, body) => cases.set(name, body), harness });
    const body = cases.get(caseName);
    result.found = body !== undefined;
    if (body) { await body(); result.ok = true; }
} catch (error) {
    result.error = String(error?.message ?? error).slice(0, 500);
}
await out();
process.exit(result.ok ? 0 : 1);
