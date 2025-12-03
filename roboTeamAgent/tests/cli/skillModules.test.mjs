import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(__dirname, '..', '.AchillesSkills');

/**
 * Unit tests for the individual skill modules (.mjs files).
 * These test the action functions directly without LLM calls.
 *
 * Action signature convention: action(recursiveSkilledAgent, prompt)
 */

/**
 * Create a mock agent with all required methods for skill modules
 */
function createMockAgent(options = {}) {
    const {
        startDir,
        skillCatalog = new Map(),
        additionalSkillRoots = [],
    } = options;

    const skillsDir = path.join(startDir, '.AchillesSkills');

    return {
        startDir,
        skillCatalog,
        additionalSkillRoots,

        // Getter methods
        getStartDir() {
            return startDir;
        },
        getSkillsDir() {
            return skillsDir;
        },
        getAdditionalSkillRoots() {
            return additionalSkillRoots;
        },

        // Skill lookup methods
        getSkillRecord(name) {
            return skillCatalog.get(name) || null;
        },
        getSkills() {
            return Array.from(skillCatalog.values());
        },
        findSkillFile(skillName) {
            const record = skillCatalog.get(skillName);
            if (record?.filePath) {
                return { filePath: record.filePath, type: record.type, record };
            }
            // Fallback to filesystem
            const skillDir = path.join(skillsDir, skillName);
            const fileTypes = ['cskill.md', 'tskill.md', 'iskill.md', 'oskill.md', 'pskill.md'];
            for (const filename of fileTypes) {
                const filePath = path.join(skillDir, filename);
                if (fs.existsSync(filePath)) {
                    return { filePath, type: filename.replace('.md', ''), record: null };
                }
            }
            return null;
        },
        getUserSkills() {
            const builtInRoot = additionalSkillRoots[0];
            if (!builtInRoot) return Array.from(skillCatalog.values());
            return Array.from(skillCatalog.values()).filter(
                s => !s.skillDir?.startsWith(builtInRoot)
            );
        },
        isBuiltInSkill(skillRecord) {
            const builtInRoot = additionalSkillRoots[0];
            if (!builtInRoot) return false;
            return skillRecord?.skillDir?.startsWith(builtInRoot) ?? false;
        },
    };
}

describe('list-skills module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/list-skills/list-skills.mjs');
        action = module.action;

        // Create temp directory with skills
        tempDir = path.join(__dirname, 'temp_list_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        // Create a test skill
        const testSkillDir = path.join(tempSkillsDir, 'TestSkill');
        fs.mkdirSync(testSkillDir);
        fs.writeFileSync(
            path.join(testSkillDir, 'cskill.md'),
            '# Test Skill\n\n## Summary\nA test skill.'
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should list skills from skilledAgent catalog', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['test-skill', { name: 'test-skill', type: 'code', shortName: 'TestSkill', descriptor: { summary: 'Test' }, skillDir: '/test' }],
            ]),
        });

        const result = await action(mockAgent, '');
        assert.ok(result.includes('test-skill') || result.includes('TestSkill'), 'Should include skill name');
    });

    it('should return message when no skills', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map(),
        });

        const result = await action(mockAgent, '');
        assert.ok(result.includes('No skills'), 'Should indicate no skills');
    });
});

describe('read-skill module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/read-skill/read-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_read_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        const testSkillDir = path.join(tempSkillsDir, 'ReadTestSkill');
        fs.mkdirSync(testSkillDir);
        fs.writeFileSync(
            path.join(testSkillDir, 'cskill.md'),
            '# Read Test Skill\n\n## Summary\nA skill to read.'
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate error');
    });

    it('should read skill file content', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['ReadTestSkill', {
                    name: 'ReadTestSkill',
                    skillDir: path.join(tempSkillsDir, 'ReadTestSkill'),
                    filePath: path.join(tempSkillsDir, 'ReadTestSkill', 'cskill.md'),
                    type: 'cskill',
                }],
            ]),
        });

        const result = await action(mockAgent, 'ReadTestSkill');
        assert.ok(result.includes('Read Test Skill'), 'Should include skill content');
    });

    it('should return error for non-existent skill', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map(),
        });

        const result = await action(mockAgent, 'NonExistent');
        assert.ok(result.includes('not found') || result.includes('Error'), 'Should indicate not found');
    });
});

describe('write-skill module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/write-skill/write-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_write_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should create new skill file', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const input = JSON.stringify({
            skillName: 'NewWriteSkill',
            fileName: 'cskill.md',
            content: '# New Write Skill\n\n## Summary\nWritten skill.',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('Written') || result.includes('Created'), 'Should indicate success');

        const filePath = path.join(tempSkillsDir, 'NewWriteSkill', 'cskill.md');
        assert.ok(fs.existsSync(filePath), 'File should exist');
    });

    it('should return error for invalid JSON', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, 'not json');
        assert.ok(result.includes('Error') || result.includes('Invalid'), 'Should indicate error');
    });

    it('should return error when required fields missing', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const input = JSON.stringify({ skillName: 'Test' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate missing fields');
    });
});

describe('delete-skill module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/delete-skill/delete-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_delete_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        // Create skill to delete
        const deleteSkillDir = path.join(tempSkillsDir, 'SkillToDelete');
        fs.mkdirSync(deleteSkillDir);
        fs.writeFileSync(path.join(deleteSkillDir, 'cskill.md'), '# To Delete');
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate error');
    });

    it('should delete existing skill', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const skillDir = path.join(tempSkillsDir, 'SkillToDelete');
        assert.ok(fs.existsSync(skillDir), 'Skill should exist before delete');

        const result = await action(mockAgent, 'SkillToDelete');
        assert.ok(result.includes('Deleted') || result.includes('deleted'), 'Should indicate deleted');
        assert.ok(!fs.existsSync(skillDir), 'Skill should not exist after delete');
    });

    it('should return error for non-existent skill', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, 'NonExistentSkill');
        assert.ok(result.includes('not found') || result.includes('Error'), 'Should indicate not found');
    });
});

describe('validate-skill module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/validate-skill/validate-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_validate_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        // Create valid skill
        const validSkillDir = path.join(tempSkillsDir, 'ValidSkill');
        fs.mkdirSync(validSkillDir);
        fs.writeFileSync(
            path.join(validSkillDir, 'cskill.md'),
            '# Valid Skill\n\n## Summary\nA valid code skill.\n\n## Prompt\nDo something.'
        );

        // Create invalid skill
        const invalidSkillDir = path.join(tempSkillsDir, 'InvalidSkill');
        fs.mkdirSync(invalidSkillDir);
        fs.writeFileSync(
            path.join(invalidSkillDir, 'cskill.md'),
            'Not a valid skill format'
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate error');
    });

    it('should validate valid skill', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['ValidSkill', {
                    name: 'ValidSkill',
                    skillDir: path.join(tempSkillsDir, 'ValidSkill'),
                    filePath: path.join(tempSkillsDir, 'ValidSkill', 'cskill.md'),
                    type: 'cskill',
                }],
            ]),
        });

        const result = await action(mockAgent, 'ValidSkill');
        assert.ok(result.includes('Validation') || result.includes('Valid'), 'Should show validation result');
    });
});

describe('get-template module', () => {
    let action;

    before(async () => {
        const module = await import('../src/.AchillesSkills/get-template/get-template.mjs');
        action = module.action;
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillType not provided', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required') || result.includes('Available'), 'Should indicate error or list types');
    });

    it('should return template for tskill', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, 'tskill');
        assert.ok(result.includes('# ') || result.includes('Template'), 'Should include template');
    });

    it('should return template for cskill', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, 'cskill');
        assert.ok(result.includes('# ') || result.includes('Template'), 'Should include template');
    });

    it('should return template for oskill', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, 'oskill');
        assert.ok(result.includes('# ') || result.includes('Template'), 'Should include template');
    });

    it('should return error for unknown type', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, 'unknowntype');
        assert.ok(result.includes('Error') || result.includes('Unknown') || result.includes('Available'), 'Should indicate unknown type');
    });
});

describe('update-section module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/update-section/update-section.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_update_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        const updateSkillDir = path.join(tempSkillsDir, 'UpdateSkill');
        fs.mkdirSync(updateSkillDir);
        fs.writeFileSync(
            path.join(updateSkillDir, 'cskill.md'),
            '# Update Skill\n\n## Summary\nOriginal summary.\n\n## Prompt\nDo something.'
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error for invalid JSON', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, 'not json');
        assert.ok(result.includes('Error') || result.includes('Invalid'), 'Should indicate error');
    });

    it('should update section content', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['UpdateSkill', {
                    name: 'UpdateSkill',
                    skillDir: path.join(tempSkillsDir, 'UpdateSkill'),
                    filePath: path.join(tempSkillsDir, 'UpdateSkill', 'cskill.md'),
                    type: 'cskill',
                }],
            ]),
        });

        const input = JSON.stringify({
            skillName: 'UpdateSkill',
            section: 'Summary',
            content: 'Updated summary content.',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('Updated') || result.includes('updated'), 'Should indicate updated');

        const content = fs.readFileSync(path.join(tempSkillsDir, 'UpdateSkill', 'cskill.md'), 'utf8');
        assert.ok(content.includes('Updated summary content'), 'File should contain updated content');
    });
});

describe('preview-changes module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/preview-changes/preview-changes.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_preview_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        const previewSkillDir = path.join(tempSkillsDir, 'PreviewSkill');
        fs.mkdirSync(previewSkillDir);
        fs.writeFileSync(
            path.join(previewSkillDir, 'cskill.md'),
            '# Preview Skill\n\n## Summary\nOriginal content.'
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error for invalid JSON', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, 'not json');
        assert.ok(result.includes('Error') || result.includes('Invalid'), 'Should indicate error');
    });

    it('should show diff for existing file', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const input = JSON.stringify({
            skillName: 'PreviewSkill',
            fileName: 'cskill.md',
            newContent: '# Preview Skill\n\n## Summary\nNew content.',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('DIFF') || result.includes('-') || result.includes('+'), 'Should show diff');
    });

    it('should show new file content for non-existent file', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const input = JSON.stringify({
            skillName: 'PreviewSkill',
            fileName: 'newfile.md',
            newContent: '# New File Content',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('NEW FILE') || result.includes('New File Content'), 'Should show new file');
    });
});

describe('test-code module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/test-code/test-code.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_testcode_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        // Create skill with generated code
        const codeSkillDir = path.join(tempSkillsDir, 'TestCodeSkill');
        fs.mkdirSync(codeSkillDir);
        fs.writeFileSync(
            path.join(codeSkillDir, 'tskill.generated.mjs'),
            `export function testFunc(input) { return 'Hello ' + input; }
export default { testFunc };`
        );
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = createMockAgent({ startDir: tempDir });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate error');
    });

    it('should load and test generated module', async () => {
        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['TestCodeSkill', {
                    name: 'TestCodeSkill',
                    skillDir: path.join(tempSkillsDir, 'TestCodeSkill'),
                    filePath: path.join(tempSkillsDir, 'TestCodeSkill', 'tskill.md'),
                    type: 'tskill',
                }],
            ]),
        });

        const result = await action(mockAgent, 'TestCodeSkill');
        assert.ok(result.includes('Module loaded') || result.includes('Exports') || result.includes('testFunc'), 'Should show module info');
    });

    it('should return error when no generated code exists', async () => {
        // Create skill without generated code
        const noCodeDir = path.join(tempSkillsDir, 'NoCodeSkill');
        fs.mkdirSync(noCodeDir);
        fs.writeFileSync(path.join(noCodeDir, 'cskill.md'), '# No Code');

        const mockAgent = createMockAgent({
            startDir: tempDir,
            skillCatalog: new Map([
                ['NoCodeSkill', {
                    name: 'NoCodeSkill',
                    skillDir: noCodeDir,
                    filePath: path.join(noCodeDir, 'cskill.md'),
                    type: 'cskill',
                }],
            ]),
        });

        const result = await action(mockAgent, 'NoCodeSkill');
        assert.ok(result.includes('No generated code') || result.includes('Error'), 'Should indicate no generated code');
    });
});

describe('skill-refiner module', () => {
    let action;

    before(async () => {
        const module = await import('../src/.AchillesSkills/skill-refiner/skill-refiner.mjs');
        action = module.action;
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function', 'Should export action function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') || result.includes('required'), 'Should indicate error');
    });

    it('should return error when llmAgent not provided', async () => {
        const mockAgent = createMockAgent({ startDir: '/tmp' });
        const result = await action(mockAgent, 'someSkill');
        assert.ok(result.includes('Error') || result.includes('LLM'), 'Should indicate LLM required');
    });
});
