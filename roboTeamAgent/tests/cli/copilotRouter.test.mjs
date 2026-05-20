import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routerSkillPath = path.join(
    __dirname,
    '../achilles-cli/src/skills/copilot-router/oskill.md'
);

describe('copilot-router oskill contract', () => {
    it('is a loop-session router with provider launchers but no @ dispatch', () => {
        const source = fs.readFileSync(routerSkillPath, 'utf8');
        assert.match(source, /## Session Type\s*\nloop/);
        assert.match(source, /launch-open-interpreter/);
        assert.match(source, /launch-web-search/);
        assert.match(source, /@open-interpreter list primes/);
        assert.match(source, /ordinary chat text/);
        assert.match(source, /false-positive/i);
    });

    it('keeps web search unavailable until a launcher declares a cacheable provider', () => {
        const source = fs.readFileSync(routerSkillPath, 'utf8');
        assert.match(source, /Do not invent web search availability/);
        assert.match(source, /launch-web-search/);
    });
});
