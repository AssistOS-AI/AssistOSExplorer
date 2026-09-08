import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSanitizer } from './skillRuntimePolicy.mjs';

// Files carry launch configuration and one-way task receipts, never MCP requests.
export async function createPloinkyTaskContext({ context, env, onTask, onProviderResult }) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'achilles-ploinky-task-'));
    const events = path.join(directory, 'events');
    const sanitize = createSanitizer(context, env);
    const sdkEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
        (key.startsWith('PLOINKY_') && !/MASTER|PRIVATE_SECRET|SUBJECT|PASSWORD/i.test(key))));
    // Preserve only this agent's SDK identity. No user-session or master credentials.
    const value = { version: 1, env: sdkEnv, workingDir: context.workingDir,
        resources: context.resources || [], paths: context.paths || [], origin: context.origin || {},
        userDelegationToken: context.userDelegationToken || '' };
    let timer;
    let pending = Promise.resolve();
    let failure;
    const seen = new Set();
    const drain = async () => {
        for (const name of await fs.readdir(events)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name) || seen.has(name)) continue;
            const file = path.join(events, name);
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid Ploinky task receipt.');
            const event = sanitize(JSON.parse(await fs.readFile(file, 'utf8')));
            seen.add(name);
            if (event.type === 'task-started') await onTask?.(event.task);
            else if (event.type === 'provider-result') await onProviderResult?.(event.result);
        }
    };
    try {
        await fs.mkdir(events, { mode: 0o700 });
        await fs.writeFile(path.join(directory, 'context.json'), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        timer = setInterval(() => { pending = pending.then(drain).catch((error) => { failure ||= error; }); }, 100);
        timer.unref();
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
    let closing;
    return { directory, close() { return closing ||= (async () => {
        clearInterval(timer);
        try { await pending; await drain(); if (failure) throw failure; }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
    })(); } };
}
