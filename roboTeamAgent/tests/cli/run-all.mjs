#!/usr/bin/env node
/**
 * Run all skill-manager tests
 * Usage: node tests/skill-manager/run-all.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find all test files in this directory
const testFiles = readdirSync(__dirname)
    .filter(f => f.endsWith('.test.mjs'))
    .map(f => path.join(__dirname, f));

if (testFiles.length === 0) {
    console.error('No test files found');
    process.exit(1);
}

console.log(`Running ${testFiles.length} test file(s):`);
testFiles.forEach(f => console.log(`  - ${path.basename(f)}`));
console.log('');

const child = spawn('node', ['--test', ...testFiles], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../..'),
});

child.on('close', (code) => {
    process.exit(code);
});
