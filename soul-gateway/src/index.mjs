import { bootstrap } from './bootstrap.mjs';
import { shutdown } from './shutdown.mjs';

async function main() {
    let appCtx, server;

    try {
        ({ appCtx, server } = await bootstrap());
    } catch (err) {
        console.error('FATAL: bootstrap failed', err);
        process.exit(1);
    }

    const { HOST, PORT } = appCtx.config.env;

    server.listen(PORT, HOST, () => {
        appCtx.log.info('listening', { host: HOST, port: PORT });
    });

    // Signal handling
    let shuttingDown = false;

    async function onSignal(signal) {
        if (shuttingDown) {
            appCtx.log.warn('forced exit on second signal');
            process.exit(1);
        }
        shuttingDown = true;
        try {
            await shutdown(appCtx, server, signal);
            process.exit(0);
        } catch (err) {
            appCtx.log.error('shutdown error', { error: err.message });
            process.exit(1);
        }
    }

    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));

    // Uncaught safety net
    process.on('uncaughtException', (err) => {
        console.error('FATAL: uncaughtException', err);
        onSignal('uncaughtException');
    });

    process.on('unhandledRejection', (err) => {
        console.error('FATAL: unhandledRejection', err);
        onSignal('unhandledRejection');
    });
}

main();
