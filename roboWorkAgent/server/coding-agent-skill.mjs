import fs from 'node:fs/promises';
import path from 'node:path';
import { CODING_AGENT_NAMES, codingAgentSkillDirectory } from './coding-agents.mjs';
import { fail } from './robot-paths.mjs';

export const SKILL_NAME = /^[a-z][a-z0-9-]{0,39}$/u;
export const SKILL_CONTENT_LIMIT = 64 * 1024;

// A caller may ship one authored skill into a robot home, so an agent whose CLI
// reads skills from its own state directory starts already knowing its role. The
// file is replaced atomically and nothing else in the home is touched. An agent
// without that convention reports `installed: false` and the caller briefs it
// with a prompt instead.
export async function installCodingAgentSkill(home, input) {
    const { codingAgent, name, text } = input || {};
    if (!CODING_AGENT_NAMES.includes(codingAgent)) throw fail('INVALID_INPUT', 'Unknown coding agent');
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw fail('INVALID_INPUT', 'Invalid skill name');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > SKILL_CONTENT_LIMIT) {
        throw fail('INVALID_INPUT', 'Invalid skill text');
    }
    const relative = codingAgentSkillDirectory(codingAgent);
    if (!relative) return { installed: false };
    const directory = path.join(home, ...relative.split('/'), name);
    await fs.mkdir(directory, { recursive: true, mode: 0o755 });
    const file = path.join(directory, 'SKILL.md');
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, text, { mode: 0o644 });
    await fs.rename(temporary, file);
    return { installed: (await fs.readFile(file, 'utf8')) === text };
}
