#!/usr/bin/env node

import { buildAchillesSkillCatalog } from './list-slash-commands.mjs';

async function readInput() {
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    if (!raw.trim()) {
        return {};
    }
    const payload = JSON.parse(raw);
    return payload?.input || payload?.arguments || payload?.params?.arguments || {};
}

const input = await readInput();
process.stdout.write(`${JSON.stringify(await buildAchillesSkillCatalog(input.dir))}\n`);
