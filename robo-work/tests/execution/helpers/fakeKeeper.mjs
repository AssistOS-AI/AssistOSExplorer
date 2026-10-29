import net from 'node:net';
import { once } from 'node:events';

// A deterministic fake keeper behind the supervisor's keeper interface (supervisorEndpointServer.mjs). It starts no
// process. For each admitted start it connects the workload's side of every requested stream to the endpoint's
// path, as the real keeper does before the final exec, and then lets a script write and end them.

async function connectUnix(socketPath) {
    const socket = net.connect(socketPath);
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
}

export const DEFAULT_SCRIPTS = Object.freeze({
    run: ({ sockets, exit }) => { sockets.stdout.write('out\n'); sockets.stderr.write('err\n'); exit(0); },
    fail: ({ exit }) => exit(3),
    echo: ({ sockets, exit }) => {
        sockets.stdin.on('data', (chunk) => sockets.stdout.write(chunk));
        sockets.stdin.on('end', () => exit(0));
    },
    hold: () => {}
});

export function createFakeKeeper({ script, inventory = [{ name: 'codex' }, { name: 'claude' }], tempdir = '/tmp/ala-execution-1' } = {}) {
    let exitHandler = () => {};
    const live = new Map();
    const log = { starts: [], stops: [], inventory: 0 };
    const allSockets = [];
    const choose = (request) => script || DEFAULT_SCRIPTS[request.args[0]] || DEFAULT_SCRIPTS.run;
    return {
        log,
        live,
        closeAll() { for (const socket of allSockets) socket.destroy(); },
        setExitHandler(handler) { exitHandler = handler; },
        async inventory() { log.inventory += 1; return inventory; },
        async tempdir() { return tempdir; },
        async start({ process, request, streams }) {
            log.starts.push({ process, request });
            const sockets = {};
            for (const [name, socketPath] of Object.entries(streams)) { sockets[name] = await connectUnix(socketPath); allSockets.push(sockets[name]); }
            const exit = (code = 0, signal = null) => {
                if (!live.has(process)) return;
                live.delete(process);
                for (const name of ['stdout', 'stderr']) sockets[name]?.end();
                setImmediate(() => exitHandler(process, code, signal));
            };
            live.set(process, { exit, sockets });
            await choose(request)({ request, process, sockets, exit });
            // The workload's writes and half-closes have reached the kernel before the start is reported.
            await Promise.all(Object.values(sockets).filter((socket) => socket.writableEnded && !socket.writableFinished)
                .map((socket) => once(socket, 'finish')));
        },
        async stop({ process, graceMs }) {
            log.stops.push({ process, graceMs });
            live.get(process)?.exit(null, graceMs === 0 ? 'SIGKILL' : 'SIGTERM');
        }
    };
}
