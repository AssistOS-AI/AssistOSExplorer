/**
 * Shared Test Helpers
 * Common utilities and fixtures for code generation tests
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Export the tests directory path for use in test files
export const testsDir = path.dirname(__dirname);

/**
 * Create a mock agent with all required methods for skill modules
 */
export function createMockAgent(options = {}) {
    const {
        startDir,
        skillCatalog = new Map(),
        additionalSkillRoots = [],
        llmAgent = null,
    } = options;

    const skillsDir = path.join(startDir, '.AchillesSkills');

    return {
        startDir,
        skillCatalog,
        additionalSkillRoots,
        llmAgent,

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
                    return { filePath, type: filename.replace('.md', ''), record: { skillDir } };
                }
            }
            // Final fallback: just return skillDir if it exists
            if (fs.existsSync(skillDir)) {
                return { filePath: null, type: null, record: { skillDir } };
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

/**
 * Create a temporary directory for tests
 */
export function createTempDir(prefix) {
    const tempDir = path.join(testsDir, `${prefix}_${Date.now()}`);
    const skillsDir = path.join(tempDir, '.AchillesSkills');
    fs.mkdirSync(skillsDir, { recursive: true });
    return { tempDir, skillsDir };
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(tempDir) {
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// Sample skill definitions for each type
export const SKILL_DEFINITIONS = {
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

// Mock generated code responses for each skill type
export const MOCK_GENERATED_CODE = {
    tskill: `/**
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
};`,

    iskill: `/**
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

export default { specs, action };`,

    oskill: `/**
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

export default { specs, action };`,

    cskill: `/**
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

export default { specs, action };`,
};
