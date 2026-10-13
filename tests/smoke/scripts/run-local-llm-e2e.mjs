#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const canonicalRunner = fileURLToPath(new URL('../../../../ploinky/tests/hardware-limits/verify.mjs', import.meta.url));
const blocks = Object.freeze({
    apple: 'mac-model-venus',
    'apple-cpu': 'mac-model-cpu',
    nvidia: 'apparatus-model-nvidia',
    cpu: 'apparatus-model-cpu',
});

export const localLlmHelp = `Optional local-llm E2E dispatcher
Usage: npm run test:local-llm -- --profile apple|apple-cpu|nvidia|cpu --action prepare|provision|live|cleanup --run ABS_PATH [options]

prepare requires --config ABS_PATH --pins ABS_PATH and maps to prepare-live.
provision, live and cleanup require --authorization ABS_PATH for that exact action.
--run names the canonical run manifest file, not a directory.

apple  -> mac-model-venus / LIVE-L6, selected existing rootless libkrun machine
apple-cpu -> mac-model-cpu / LIVE-L7, same selected machine without GPU exposure
nvidia -> apparatus-model-nvidia / LIVE-L4, native Linux CUDA without MPS
cpu    -> apparatus-model-cpu / LIVE-L5, native Linux without GPU exposure

The fixed sibling ploinky/tests/hardware-limits/verify.mjs owns execution,
authorization, provenance, evidence and cleanup. No approval is created here.
Use separate fresh NVIDIA and CPU runs. --help reads no files and runs no commands.
`;

function parseOptions(argv) {
    const options = {};
    const allowed = new Set(['profile', 'action', 'run', 'config', 'pins', 'authorization']);
    for (let index = 0; index < argv.length; index += 2) {
        const token = argv[index];
        const key = token?.startsWith('--') ? token.slice(2) : '';
        const value = argv[index + 1];
        if (!allowed.has(key)) throw new Error('Unknown local-llm option. Use --help.');
        if (Object.hasOwn(options, key)) throw new Error(`Duplicate --${key}.`);
        if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
        options[key] = value;
    }
    if (!Object.hasOwn(blocks, options.profile || '')) throw new Error('--profile must be apple, apple-cpu, nvidia or cpu.');
    if (!['prepare', 'provision', 'live', 'cleanup'].includes(options.action)) throw new Error('--action must be prepare, provision, live or cleanup.');
    const paths = options.action === 'prepare' ? ['run', 'config', 'pins'] : ['run', 'authorization'];
    for (const key of paths) {
        if (!options[key] || !path.isAbsolute(options[key])) throw new Error(`--${key} must be an absolute path.`);
    }
    for (const key of ['config', 'pins', 'authorization']) {
        if (Object.hasOwn(options, key) && !paths.includes(key)) throw new Error(`--${key} is not supported for ${options.action}.`);
    }
    return options;
}

function readJson(filePath) {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Run manifest must be a regular file of at most 8 MiB.');
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function validateBinding(options, load) {
    const run = load(options.run);
    if (run?.block !== blocks[options.profile] || run?.target?.execution?.model?.profile !== options.profile) {
        throw new Error('Run manifest profile/block binding does not match --profile.');
    }
}

export function dispatchLocalLlm(argv, { spawn = spawnSync, readJson: load = readJson } = {}) {
    if (argv.length === 1 && argv[0] === '--help') return 0;
    const options = parseOptions(argv);
    const prepare = options.action === 'prepare';
    if (!prepare) validateBinding(options, load);
    const args = [canonicalRunner, prepare ? 'prepare-live' : options.action];
    if (prepare) args.push('--block', blocks[options.profile]);
    args.push('--run', options.run);
    if (prepare) args.push('--config', options.config, '--pins', options.pins);
    else args.push('--authorization', options.authorization);
    const result = spawn(process.execPath, args, { shell: false, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Canonical local-llm runner interrupted by ${result.signal}.`);
    if (!Number.isInteger(result.status) || result.status < 0) throw new Error('Canonical local-llm runner returned no exit status.');
    if (prepare && result.status === 0) validateBinding(options, load);
    return result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const argv = process.argv.slice(2);
        process.exitCode = dispatchLocalLlm(argv);
        if (argv.length === 1 && argv[0] === '--help') process.stdout.write(localLlmHelp);
    } catch {
        console.error('[local-llm] Dispatch refused or canonical runner interrupted. Check arguments, run binding and canonical evidence; use --help.');
        process.exitCode = 2;
    }
}
