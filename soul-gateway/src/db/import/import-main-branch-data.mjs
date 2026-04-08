import pg from 'pg';
import { importMainBranchData } from './main-branch-importer.mjs';
import {
    resolveSourceEncryptionKey,
    resolveTargetApiKeyPepper,
    resolveTargetEncryptionKey,
} from './main-branch-crypto.mjs';

const { Pool } = pg;

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
    await main();
}

export async function main() {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    const dryRun = args.has('--dry-run');
    const strict = args.has('--strict');
    const includeAuditLogs = args.has('--include-call-logs');
    const callLogBatchSize = readIntArg(argv, '--call-log-batch-size=', 500);
    const sessionTimeoutMinutes = readIntArg(
        argv,
        '--session-timeout-minutes=',
        parseInt(
            process.env.TARGET_SESSION_TIMEOUT_MINUTES ||
                process.env.SESSION_TIMEOUT_MINUTES ||
                '30',
            10
        )
    );

    const sourceUrl = process.env.SOURCE_DATABASE_URL;
    const targetUrl =
        process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;

    if (!sourceUrl) {
        throw new Error('SOURCE_DATABASE_URL is required');
    }
    if (!targetUrl) {
        throw new Error('TARGET_DATABASE_URL or DATABASE_URL is required');
    }

    const sourcePool = new Pool({
        connectionString: sourceUrl,
        application_name: 'soul-gateway-main-import-source',
    });
    const targetPool = new Pool({
        connectionString: targetUrl,
        application_name: 'soul-gateway-main-import-target',
    });

    try {
        const report = await importMainBranchData({
            sourcePool,
            targetPool,
            sourceEncryptionKey: resolveSourceEncryptionKey(process.env),
            targetEncryptionKey: resolveTargetEncryptionKey(process.env),
            targetApiKeyPepper: resolveTargetApiKeyPepper(process.env),
            dryRun,
            strict,
            includeAuditLogs,
            callLogBatchSize,
            sessionTimeoutMinutes,
        });

        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        await Promise.allSettled([sourcePool.end(), targetPool.end()]);
    }
}

function readIntArg(argv, prefix, fallback) {
    const raw = argv.find((arg) => arg.startsWith(prefix));
    if (!raw) return fallback;
    const parsed = parseInt(raw.slice(prefix.length), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
