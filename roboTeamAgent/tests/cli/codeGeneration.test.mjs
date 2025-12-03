/**
 * Code Generation Tests
 * Tests generate-code and test-code for all skill types: tskill, iskill, oskill, cskill
 *
 * Action signature convention: action(recursiveSkilledAgent, prompt)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the action functions directly
let generateCodeAction;
let testCodeAction;

// Sample skill definitions for each type
const SKILL_DEFINITIONS = {
    tskill: `# Test Product

## Table Purpose
Stores product information for an e-commerce catalog.

## Fields

### product_id
- Description: Unique identifier for the product
- Type: string
- Required: true
- PrimaryKey: true

#### Field Value Validator
Must match pattern: PROD-#### (e.g., PROD-0001)

### name
- Description: Product name
- Type: string
- Required: true
- Aliases: ["title", "product_name"]

#### Field Value Validator
- Minimum length: 2 characters
- Maximum length: 100 characters

#### Field Value Presenter
Capitalizes first letter of each word.

### price
- Description: Product price in cents
- Type: integer
- Required: true

#### Field Value Validator
Must be a positive integer.

#### Field Value Presenter
Formats as currency (e.g., $12.99)

### status
- Description: Product availability status
- Type: string
- Required: true
- Default: "active"

#### Field Value Enumerator
["active", "inactive", "discontinued"]

## Derived Fields

### is_available
- Type: boolean
- Calculation: status === "active"
`,

    iskill: `# Test Greeter

## Summary
A simple greeting skill that generates personalized greetings.

## Required Arguments
- name: The name of the person to greet
- style: The greeting style (formal, casual, friendly)

## Prompt
You are a friendly greeter. Generate a greeting for the given name in the requested style.
Keep it brief - one sentence only.
`,

    oskill: `# Test Router

## Summary
Routes requests to appropriate sub-skills based on intent.

## Instructions
You are a request router. Analyze the user's request and determine which skill should handle it.

Available operations:
- greet: For greeting requests
- calculate: For math operations
- help: For assistance requests

## Allowed-Skills
- greeter
- calculator
- helper

## Intents
- greet: User wants to be greeted or say hello
- calculate: User wants to perform math
- help: User needs assistance

## Fallback
If intent is unclear, ask for clarification.
`,

    cskill: `# Test Summarizer

## Summary
Summarizes text content using LLM.

## Prompt
You are a text summarizer. Given input text, produce a concise summary that captures the key points.
Keep the summary to 2-3 sentences maximum.

## Arguments
- text: The text content to summarize
- maxLength: Optional maximum length for the summary

## LLM-Mode
fast
`,
};

describe('Code Generation for All Skill Types', () => {
    let tempDir;
    let skillsDir;

    before(async () => {
        // Import action functions
        const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
        generateCodeAction = generateModule.action;

        const testModule = await import('../src/.AchillesSkills/test-code/test-code.mjs');
        testCodeAction = testModule.action;

        // Setup temp directory
        tempDir = path.join(__dirname, 'temp_codegen_' + Date.now());
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir, { recursive: true });

        // Create skill directories and definition files for each type
        for (const [type, content] of Object.entries(SKILL_DEFINITIONS)) {
            const skillName = `Test${type.charAt(0).toUpperCase() + type.slice(1)}Skill`;
            const skillDir = path.join(skillsDir, skillName);
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, `${type}.md`), content);
        }
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('generate-code action', () => {
        it('should return error when skillName not provided', async () => {
            const mockAgent = { startDir: tempDir };
            const result = await generateCodeAction(mockAgent, '');
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('skillName'), 'Should mention skillName');
        });

        it('should return error when skill not found', async () => {
            const mockAgent = { startDir: tempDir, getSkillRecord: () => null };
            const result = await generateCodeAction(mockAgent, 'NonExistentSkill');
            assert.ok(result.includes('Error') || result.includes('not found'), 'Should return error');
        });

        it('should return error when llmAgent not provided', async () => {
            const mockAgent = { startDir: tempDir, getSkillRecord: () => null };
            const result = await generateCodeAction(mockAgent, 'TestTskillSkill');
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('LLM') || result.includes('not found'), 'Should mention LLM or not found');
        });
    });

    describe('tskill code generation', () => {
        it('should generate code for tskill', async () => {
            const skillDir = path.join(skillsDir, 'TestTskillSkill');
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    // Return mock generated code for tskill
                    return `/**
 * TestTskillSkill - Database Table Skill
 */

export function validator_product_id(value) {
    if (!value) return 'Product ID is required';
    if (!/^PROD-\\d{4}$/.test(value)) return 'Must match pattern PROD-####';
    return null;
}

export function validator_name(value) {
    if (!value) return 'Name is required';
    if (value.length < 2) return 'Minimum length is 2';
    if (value.length > 100) return 'Maximum length is 100';
    return null;
}

export function validator_price(value) {
    if (typeof value !== 'number' || value <= 0) return 'Must be a positive integer';
    return null;
}

export function enumerator_status() {
    return ['active', 'inactive', 'discontinued'];
}

export function presenter_name(value) {
    if (!value) return '';
    return value.replace(/\\b\\w/g, c => c.toUpperCase());
}

export function presenter_price(value) {
    return '$' + (value / 100).toFixed(2);
}

export function selectRecords(records, filters) {
    return records.filter(r => {
        for (const [key, val] of Object.entries(filters)) {
            if (r[key] !== val) return false;
        }
        return true;
    });
}

export function prepareRecord(record) {
    return { ...record };
}

export function validateRecord(record) {
    const errors = [];
    const idErr = validator_product_id(record.product_id);
    if (idErr) errors.push({ field: 'product_id', error: idErr });
    const nameErr = validator_name(record.name);
    if (nameErr) errors.push({ field: 'name', error: nameErr });
    const priceErr = validator_price(record.price);
    if (priceErr) errors.push({ field: 'price', error: priceErr });
    return { valid: errors.length === 0, errors };
}

export default {
    validator_product_id,
    validator_name,
    validator_price,
    enumerator_status,
    presenter_name,
    presenter_price,
    selectRecords,
    prepareRecord,
    validateRecord,
};`;
                },
            };

            const mockAgent = {
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                getSkillRecord: () => ({
                    skillDir,
                    filePath: path.join(skillDir, 'tskill.md'),
                }),
            };

            const result = await generateCodeAction(mockAgent, 'TestTskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('tskill.generated.mjs'), 'Should use tskill.generated.mjs filename');

            // Verify file was created
            const generatedPath = path.join(skillsDir, 'TestTskillSkill', 'tskill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('iskill code generation', () => {
        it('should generate code for iskill', async () => {
            const skillDir = path.join(skillsDir, 'TestIskillSkill');
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    return `/**
 * TestIskillSkill - Interactive Skill
 */

export const specs = {
    name: 'TestIskillSkill',
    description: 'A simple greeting skill that generates personalized greetings.',
    arguments: {
        name: {
            description: 'The name of the person to greet',
            type: 'string',
            required: true,
        },
        style: {
            description: 'The greeting style (formal, casual, friendly)',
            type: 'string',
            required: true,
        },
    },
};

export async function action(args, context) {
    const { llmAgent } = context;
    const { name, style } = args;

    if (!name) return 'Error: name is required';
    if (!style) return 'Error: style is required';

    const prompt = \`Generate a \${style} greeting for \${name}. Keep it to one sentence.\`;

    if (llmAgent) {
        return await llmAgent.executePrompt(prompt, { mode: 'fast' });
    }

    return \`Hello, \${name}!\`;
}

export default { specs, action };`;
                },
            };

            const mockAgent = {
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                getSkillRecord: () => ({
                    skillDir,
                    filePath: path.join(skillDir, 'iskill.md'),
                }),
            };

            const result = await generateCodeAction(mockAgent, 'TestIskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestIskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestIskillSkill', 'TestIskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('oskill code generation', () => {
        it('should generate code for oskill', async () => {
            const skillDir = path.join(skillsDir, 'TestOskillSkill');
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    return `/**
 * TestOskillSkill - Orchestrator Skill
 */

export const specs = {
    name: 'TestOskillSkill',
    description: 'Routes requests to appropriate sub-skills based on intent.',
    type: 'orchestrator',
    allowedSkills: ['greeter', 'calculator', 'helper'],
    intents: {
        greet: 'User wants to be greeted or say hello',
        calculate: 'User wants to perform math',
        help: 'User needs assistance',
    },
};

export async function action(input, context) {
    const { llmAgent, skilledAgent } = context;

    if (!llmAgent) {
        return 'Error: LLM agent required for routing';
    }

    const routingPrompt = \`Analyze the user request and determine intent.
User request: \${input}
Return JSON: {"intent": "greet|calculate|help", "skill": "greeter|calculator|helper", "input": "..."}\`;

    try {
        const routing = await llmAgent.executePrompt(routingPrompt, {
            responseShape: 'json',
            mode: 'fast',
        });

        if (routing.skill && specs.allowedSkills.includes(routing.skill)) {
            if (skilledAgent) {
                return await skilledAgent.executeSkill({
                    skillName: routing.skill,
                    input: routing.input,
                    context,
                });
            }
            return \`Would route to: \${routing.skill}\`;
        }

        return 'Could not determine appropriate action';
    } catch (error) {
        return \`Routing error: \${error.message}\`;
    }
}

export default { specs, action };`;
                },
            };

            const mockAgent = {
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                getSkillRecord: () => ({
                    skillDir,
                    filePath: path.join(skillDir, 'oskill.md'),
                }),
            };

            const result = await generateCodeAction(mockAgent, 'TestOskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestOskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestOskillSkill', 'TestOskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('cskill code generation', () => {
        it('should generate code for cskill', async () => {
            const skillDir = path.join(skillsDir, 'TestCskillSkill');
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    return `/**
 * TestCskillSkill - Code Skill
 */

export const specs = {
    name: 'TestCskillSkill',
    description: 'Summarizes text content using LLM.',
    type: 'code',
    llmMode: 'fast',
    arguments: {
        text: {
            description: 'The text content to summarize',
            type: 'string',
            required: true,
        },
        maxLength: {
            description: 'Optional maximum length for the summary',
            type: 'number',
            required: false,
        },
    },
};

export async function action(input, context) {
    const { llmAgent } = context;

    if (!llmAgent) {
        throw new Error('LLM agent required for code skill execution');
    }

    const text = typeof input === 'string' ? input : input?.text;
    if (!text) {
        return 'Error: text is required';
    }

    const systemPrompt = \`You are a text summarizer. Given input text, produce a concise summary that captures the key points.
Keep the summary to 2-3 sentences maximum.\`;

    const fullPrompt = \`\${systemPrompt}

Text to summarize: \${text}\`;

    const result = await llmAgent.executePrompt(fullPrompt, {
        mode: specs.llmMode,
    });

    return result;
}

export default { specs, action };`;
                },
            };

            const mockAgent = {
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                getSkillRecord: () => ({
                    skillDir,
                    filePath: path.join(skillDir, 'cskill.md'),
                }),
            };

            const result = await generateCodeAction(mockAgent, 'TestCskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestCskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestCskillSkill', 'TestCskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });
});

describe('Code Testing for All Skill Types', () => {
    let tempDir;
    let skillsDir;
    let testCodeAction;

    before(async () => {
        const testModule = await import('../src/.AchillesSkills/test-code/test-code.mjs');
        testCodeAction = testModule.action;

        // Setup temp directory with pre-generated code
        tempDir = path.join(__dirname, 'temp_codetest_' + Date.now());
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('test-code action', () => {
        it('should return error when skillName not provided', async () => {
            const mockAgent = { startDir: tempDir };
            const result = await testCodeAction(mockAgent, '');
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('skillName'), 'Should mention skillName');
        });

        it('should return error when skill directory not found', async () => {
            const mockAgent = { startDir: tempDir, getSkillRecord: () => null };
            const result = await testCodeAction(mockAgent, 'NonExistentSkill');
            assert.ok(result.includes('Error') || result.includes('not found'), 'Should return error');
        });

        it('should return error when no generated code exists', async () => {
            // Create skill dir without generated code
            const emptySkillDir = path.join(skillsDir, 'EmptySkill');
            fs.mkdirSync(emptySkillDir);
            fs.writeFileSync(path.join(emptySkillDir, 'cskill.md'), '# Empty\n## Summary\nTest');

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir: emptySkillDir }),
            };
            const result = await testCodeAction(mockAgent, 'EmptySkill');
            assert.ok(result.includes('Error') || result.includes('No generated code'), 'Should return error');
        });
    });

    describe('tskill code testing', () => {
        it('should load and test tskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'TskillTest');
            fs.mkdirSync(skillDir);

            // Create a valid generated module
            fs.writeFileSync(
                path.join(skillDir, 'tskill.generated.mjs'),
                `export function validator_name(value) {
    if (!value) return 'Name is required';
    return null;
}

export function presenter_name(value) {
    return value ? value.toUpperCase() : '';
}

export function validateRecord(record) {
    const errors = [];
    const nameErr = validator_name(record.name);
    if (nameErr) errors.push({ field: 'name', error: nameErr });
    return { valid: errors.length === 0, errors };
}

export default { validator_name, presenter_name, validateRecord };`
            );

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir }),
            };
            const result = await testCodeAction(mockAgent, 'TskillTest');

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('validator_name'), 'Should list validator function');
            assert.ok(result.includes('presenter_name'), 'Should list presenter function');
            assert.ok(result.includes('validateRecord'), 'Should list validateRecord function');
        });

        it('should execute tskill functions with test input', async () => {
            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir: path.join(skillsDir, 'TskillTest') }),
            };
            const result = await testCodeAction(mockAgent, JSON.stringify({ skillName: 'TskillTest', testInput: { name: 'test' } }));

            assert.ok(result.includes('Module loaded'), 'Should load module');
        });
    });

    describe('iskill code testing', () => {
        it('should load and test iskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'IskillTest');
            fs.mkdirSync(skillDir);

            fs.writeFileSync(
                path.join(skillDir, 'IskillTest.generated.mjs'),
                `export const specs = {
    name: 'IskillTest',
    description: 'Test interactive skill',
    arguments: {
        name: { description: 'Name to greet', type: 'string', required: true },
    },
};

export async function action(args, context) {
    const { name } = args;
    return \`Hello, \${name || 'World'}!\`;
}

export default { specs, action };`
            );

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir }),
            };
            const result = await testCodeAction(mockAgent, 'IskillTest');

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('specs'), 'Should list specs export');
            assert.ok(result.includes('action'), 'Should list action function');
        });
    });

    describe('oskill code testing', () => {
        it('should load and test oskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'OskillTest');
            fs.mkdirSync(skillDir);

            fs.writeFileSync(
                path.join(skillDir, 'OskillTest.generated.mjs'),
                `export const specs = {
    name: 'OskillTest',
    description: 'Test orchestrator skill',
    type: 'orchestrator',
    allowedSkills: ['skill1', 'skill2'],
    intents: {
        action1: 'First action',
        action2: 'Second action',
    },
};

export async function action(input, context) {
    return \`Would route: \${input}\`;
}

export default { specs, action };`
            );

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir }),
            };
            const result = await testCodeAction(mockAgent, 'OskillTest');

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('specs'), 'Should list specs export');
            assert.ok(result.includes('action'), 'Should list action function');
        });
    });

    describe('cskill code testing', () => {
        it('should load and test cskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'CskillTest');
            fs.mkdirSync(skillDir);

            fs.writeFileSync(
                path.join(skillDir, 'CskillTest.generated.mjs'),
                `export const specs = {
    name: 'CskillTest',
    description: 'Test code skill',
    type: 'code',
    llmMode: 'fast',
    arguments: {
        input: { description: 'Input text', type: 'string', required: true },
    },
};

export async function action(input, context) {
    return \`Processed: \${input}\`;
}

export default { specs, action };`
            );

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir }),
            };
            const result = await testCodeAction(mockAgent, 'CskillTest');

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('specs'), 'Should list specs export');
            assert.ok(result.includes('action'), 'Should list action function');
        });
    });

    describe('error handling', () => {
        it('should handle syntax errors in generated code gracefully', async () => {
            const skillDir = path.join(skillsDir, 'SyntaxErrorSkill');
            fs.mkdirSync(skillDir);

            fs.writeFileSync(
                path.join(skillDir, 'SyntaxErrorSkill.generated.mjs'),
                `export const specs = {
    name: 'BrokenSkill'
    // Missing comma - syntax error
    description: 'This will fail'
};`
            );

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => ({ skillDir }),
            };
            const result = await testCodeAction(mockAgent, 'SyntaxErrorSkill');

            assert.ok(result.includes('Failed to load') || result.includes('Error'), 'Should indicate load failure');
        });
    });
});

describe('Code Generation Integration', () => {
    let tempDir;
    let skillsDir;
    let generateCodeAction;
    let testCodeAction;

    before(async () => {
        const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
        generateCodeAction = generateModule.action;

        const testModule = await import('../src/.AchillesSkills/test-code/test-code.mjs');
        testCodeAction = testModule.action;

        tempDir = path.join(__dirname, 'temp_integration_codegen_' + Date.now());
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should generate and test code in sequence for tskill', async () => {
        // Create skill definition
        const skillDir = path.join(skillsDir, 'IntegrationTskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'tskill.md'),
            SKILL_DEFINITIONS.tskill
        );

        // Mock LLM that generates valid code
        const mockLlmAgent = {
            executePrompt: async () => {
                return `export function validator_product_id(value) {
    return value ? null : 'Required';
}
export function validateRecord(record) {
    return { valid: true, errors: [] };
}
export default { validator_product_id, validateRecord };`;
            },
        };

        const mockAgent = {
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'tskill.md'),
            }),
        };

        // Generate
        const genResult = await generateCodeAction(mockAgent, 'IntegrationTskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        // Test
        const testResult = await testCodeAction(mockAgent, 'IntegrationTskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
        assert.ok(testResult.includes('validator_product_id'), 'Should have validator');
    });

    it('should generate and test code in sequence for iskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationIskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'iskill.md'),
            SKILL_DEFINITIONS.iskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationIskill',
    description: 'Test',
    arguments: { name: { type: 'string', required: true } },
};
export async function action(args) {
    return 'Hello ' + (args.name || 'World');
}
export default { specs, action };`;
            },
        };

        const mockAgent = {
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'iskill.md'),
            }),
        };

        const genResult = await generateCodeAction(mockAgent, 'IntegrationIskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationIskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
        assert.ok(testResult.includes('specs'), 'Should have specs');
        assert.ok(testResult.includes('action'), 'Should have action');
    });

    it('should generate and test code in sequence for oskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationOskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'oskill.md'),
            SKILL_DEFINITIONS.oskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationOskill',
    type: 'orchestrator',
    allowedSkills: ['greeter'],
    intents: { greet: 'Greet user' },
};
export async function action(input) {
    return 'Routed: ' + input;
}
export default { specs, action };`;
            },
        };

        const mockAgent = {
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'oskill.md'),
            }),
        };

        const genResult = await generateCodeAction(mockAgent, 'IntegrationOskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationOskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
    });

    it('should generate and test code in sequence for cskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationCskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'cskill.md'),
            SKILL_DEFINITIONS.cskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationCskill',
    type: 'code',
    llmMode: 'fast',
    arguments: { text: { type: 'string', required: true } },
};
export async function action(input) {
    return 'Summarized: ' + input;
}
export default { specs, action };`;
            },
        };

        const mockAgent = {
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        const genResult = await generateCodeAction(mockAgent, 'IntegrationCskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationCskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
    });
});
