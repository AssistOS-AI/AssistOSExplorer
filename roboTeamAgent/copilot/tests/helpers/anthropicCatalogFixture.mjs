import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAnthropicSkillCatalog } from '../../src/lib/anthropicSkillCatalog.mjs';
import { discoverTaskSkills } from '../../../server/skill-descriptor.mjs';

export function writeSkill(root, directory, name, description = `Use ${name} for a focused task.`) {
    const skillDir = path.join(root, directory);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nTask instructions.\n`);
    return skillDir;
}

export async function createCatalogFixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-anthropic-catalog-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workingDir = path.join(directory, 'workspace');
    const builtIns = path.join(directory, 'builtins');
    fs.mkdirSync(workingDir);
    fs.mkdirSync(builtIns);
    const createCatalog = (roots) => createAnthropicSkillCatalog({ workingDir, roots, discoverTaskSkills });
    return { directory, workingDir, builtIns, createCatalog };
}
