import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TIMEOUT_MS = 2_147_483_647;

function positiveTimeout(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
        throw new Error(`${label} must be a finite positive timer interval.`);
    }
    return value;
}

export function onlyOfficeGateTimeouts({
    uiTimeoutMs = 120_000,
    restartTimeoutMs = 300_000,
    finalizationTimeoutMs = 120_000,
} = {}) {
    positiveTimeout(uiTimeoutMs, 'OnlyOffice UI timeout');
    positiveTimeout(restartTimeoutMs, 'OnlyOffice restart timeout');
    positiveTimeout(finalizationTimeoutMs, 'OnlyOffice finalization timeout');
    // Both replacements are mandatory: save/drain/reopen, then the final drain
    // before deleting the callback target. Deletion, trace and browser checks
    // also need time after the second command has completed or failed.
    const testTimeoutMs = positiveTimeout(
        uiTimeoutMs + (2 * restartTimeoutMs) + finalizationTimeoutMs,
        'OnlyOffice total test timeout',
    );
    return Object.freeze({ uiTimeoutMs, restartTimeoutMs, finalizationTimeoutMs, testTimeoutMs });
}

export async function restartOnlyOffice({
    executable,
    workspaceRoot,
    timeoutMs,
    env = process.env,
}, { execute = execFileAsync, now = () => performance.now() } = {}) {
    if (!workspaceRoot) {
        throw new Error('SMOKE_WORKSPACE_ROOT is required for the targeted OnlyOffice restart.');
    }
    positiveTimeout(timeoutMs, 'OnlyOffice restart timeout');
    const startedAt = now();
    const { stdout, stderr } = await execute(executable, ['restart', 'onlyOffice'], {
        cwd: workspaceRoot,
        env: { ...env, PLOINKY_CWD: workspaceRoot },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
    });
    return {
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        status: 'completed',
        code: 0,
        elapsedMs: Math.round(now() - startedAt),
        timeoutMs,
    };
}
