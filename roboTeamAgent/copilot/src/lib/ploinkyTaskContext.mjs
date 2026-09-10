import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSanitizer } from './skillRuntimePolicy.mjs';
import { createTaskEventSocket } from './taskEventSocket.mjs';
import { preparePloinkyRuntimeFiles } from './ploinkyRuntimeFiles.mjs';

export async function createPloinkyTaskContext({ context, env, onTask, agentRoot }) {
    // Keep the Unix socket address below Linux's 108-byte limit, independent of robot home paths.
    const directory = await fs.realpath(await fs.mkdtemp('/tmp/ploinky-runtime-'));
    await fs.chmod(directory, 0o700);
    const sanitize = createSanitizer(context, env);
    const token = randomBytes(32).toString('hex');
    let channel;
    try {
        const filtered = Object.fromEntries(Object.entries(env).filter(([key]) =>
            key.startsWith('PLOINKY_') && !/MASTER|PRIVATE_SECRET|SUBJECT|PASSWORD/i.test(key)));
        const sdkEnv = await preparePloinkyRuntimeFiles(directory, filtered, agentRoot);
        const value = { version: 2, env: sdkEnv, workingDir: context.workingDir,
            resources: context.resources || [], paths: context.paths || [], origin: context.origin || {},
            userDelegationToken: context.userDelegationToken || '', eventToken: token };
        await fs.writeFile(path.join(directory, 'context.json'), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        channel = await createTaskEventSocket({ socketPath: path.join(directory, 'tasks.sock'), token,
            onTask: task => onTask?.(sanitize(task)) });
    } catch (error) {
        await channel?.close();
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
    }
    let closing;
    return { directory, close() { return closing ||= (async () => {
        try { await channel.close(); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
    })(); } };
}
