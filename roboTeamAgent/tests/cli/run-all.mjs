#!/usr/bin/env node
/**
 * Run all achilles-cli tests
 * Usage: node tests/run-all.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function collectFiles(dir, predicate) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            files.push(...collectFiles(fullPath, predicate));
        } else if (predicate(fullPath)) {
            files.push(fullPath);
        }
    }
    return files;
}

function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            stdio: 'inherit',
            cwd: repoRoot,
            ...options,
        });

        child.on('close', resolve);
    });
}

const nodeTestFiles = [
    ...collectFiles(__dirname, file => file.endsWith('.test.mjs')),
    ...collectFiles(path.join(repoRoot, 'achilles-cli/tests'), file => file.endsWith('.test.mjs')),
].sort();

const skillTestFiles = collectFiles(__dirname, file => file.endsWith('.tests.mjs')).sort();

if (nodeTestFiles.length === 0 && skillTestFiles.length === 0) {
    console.error('No test files found');
    process.exit(1);
}

if (nodeTestFiles.length > 0) {
    console.log(`Running ${nodeTestFiles.length} node:test file(s):`);
    nodeTestFiles.forEach(f => console.log(`  - ${path.relative(repoRoot, f)}`));
    console.log('');

    const code = await run('node', ['--test', ...nodeTestFiles]);
    if (code !== 0) {
        process.exit(code);
    }
}

if (skillTestFiles.length > 0) {
    console.log(`\nRunning ${skillTestFiles.length} skill test file(s):`);
    skillTestFiles.forEach(f => console.log(`  - ${path.relative(repoRoot, f)}`));
    console.log('');

    for (const testFile of skillTestFiles) {
        const testUrl = pathToFileURL(testFile).href;
        const wrapper = `
            const mod = await import(${JSON.stringify(testUrl)});
            const runTests = mod.default || mod.runTests;
            if (typeof runTests !== 'function') {
                throw new Error('Skill test file must export default or runTests');
            }
            const result = await runTests();
            process.exitCode = result?.failed > 0 ? 1 : 0;
        `;

        const code = await run('node', ['--input-type=module', '-e', wrapper]);
        if (code !== 0) {
            process.exit(code);
        }
    }
}
