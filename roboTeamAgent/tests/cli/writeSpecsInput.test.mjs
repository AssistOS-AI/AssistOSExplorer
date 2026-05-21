import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('write-specs positional input', () => {
    let action;
    let tempDir;
    let skillDir;

    beforeEach(async () => {
        const module = await import('../achilles-cli/src/skills/write-specs/src/index.mjs');
        action = module.action;
        tempDir = path.join(__dirname, `temp_write_specs_${Date.now()}_${Math.random().toString(16).slice(2)}`);
        skillDir = path.join(tempDir, 'skills', 'demo-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Demo\n\n## Description\nDemo\n\n## Input Format\nNone');
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('writes specs from a trailing multiline block', async () => {
        const agent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
                type: 'cskill',
            }),
        };

        const result = await action({
            mainAgent: agent,
            promptText: 'demo-skill index.mjs.md --begin-content--\nReturn hello.\n--end-content--',
        });

        assert.match(result, /Created|Updated/);
        assert.equal(fs.readFileSync(path.join(skillDir, 'specs', 'index.mjs.md'), 'utf8'), 'Return hello.');
    });

    it('rejects JSON input', async () => {
        const result = await action({
            mainAgent: { startDir: tempDir },
            promptText: '{"skillName":"demo-skill","content":"Return hello."}',
        });

        assert.match(result, /JSON input is no longer supported/);
    });
});
