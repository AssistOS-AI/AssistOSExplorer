import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { getStore } from './lib/store.mjs';
import { ensureSeedData } from './lib/bootstrap.mjs';
import { syncAdministratorPasswordState } from './lib/auth/adminPassword.mjs';
import { startService } from './service/index.mjs';
import { getOidcProvider } from './lib/oidc/provider.mjs';

function parsePort(value, name) {
    if (!/^[1-9][0-9]{0,4}$/.test(String(value)) || Number(value) > 65535) {
        throw new Error(`${name} must be a valid TCP port.`);
    }
    return Number(value);
}

const servicePort = parsePort(process.env.USERPERSISTO_SERVICE_PORT || '7000', 'USERPERSISTO_SERVICE_PORT');
const mcpPort = parsePort(process.env.PORT || '7001', 'PORT');
if (servicePort === mcpPort) throw new Error('UserPersisto HTTP and MCP ports must differ.');

let store;
let service;
let agentServer;
let agentServerExit;
let stopping = false;
let shutdownPromise;
let exitCode = 0;

function shutdown(code = 0) {
    if (code !== 0) exitCode = 1;
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
        // A failed drain must never acknowledge a clean single-writer restart.
        const deadline = setTimeout(() => {
            console.error('[userPersisto] runtime shutdown timed out.');
            process.exit(1);
        }, 30_000);
        try {
            await startup.catch(() => {});
            if (agentServer) {
                const killTimer = setTimeout(() => {
                    exitCode = 1;
                    agentServer.kill('SIGKILL');
                }, 22_000);
                try {
                    // Keep the store service available while AgentServer drains
                    // its verified tool subprocesses and their internal calls.
                    agentServer.kill('SIGTERM');
                    const result = await agentServerExit;
                    if (result.code !== 0 || result.signal) exitCode = 1;
                } finally {
                    clearTimeout(killTimer);
                }
            }
            if (service?.listening) {
                const closed = new Promise((resolve, reject) => {
                    service.close(error => error ? reject(error) : resolve());
                });
                service.closeIdleConnections?.();
                await closed;
            }
            if (store) await store.shutDown();
        } catch {
            exitCode = 1;
            console.error('[userPersisto] runtime shutdown failed.');
        } finally {
            clearTimeout(deadline);
            process.exit(exitCode);
        }
    })();
    return shutdownPromise;
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { void shutdown(); });
}

const startup = (async () => {
    store = await getStore();
    await ensureSeedData();
    // A replaced or removed administrator password revokes stale proofs and the
    // designated administrator's sessions at startup, before any sign-in.
    await syncAdministratorPasswordState();
    await getOidcProvider();
    if (stopping) return;
    service = startService(servicePort);
    if (!service.listening) await once(service, 'listening');
    if (stopping) return;
    service.on('error', () => { void shutdown(1); });

    // The generic runtime owns MCP, invocation verification, and tool dispatch.
    // It can advertise readiness only after durable HTTP service initialization.
    agentServer = spawn(process.execPath, [
        join(process.env.PLOINKY_AGENT_LIB_DIR || '/Agent', 'server', 'AgentServer.mjs'),
    ], {
        env: { ...process.env, PORT: String(mcpPort) },
        stdio: 'inherit',
    });
    agentServerExit = new Promise(resolve => {
        agentServer.once('error', () => resolve({ code: 1, signal: null }));
        agentServer.once('exit', (code, signal) => resolve({ code, signal }));
    });
    void agentServerExit.then(() => {
        if (!stopping) {
            console.error('[userPersisto] MCP runtime exited unexpectedly.');
            void shutdown(1);
        }
    });
})();

void startup.catch(() => {
    console.error('[userPersisto] runtime startup failed.');
    void shutdown(1);
});
