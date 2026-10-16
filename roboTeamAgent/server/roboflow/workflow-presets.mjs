import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_ID_PATTERN } from './constants.mjs';
import { normalizeWorkflow } from './graph.mjs';
import { canonicalSkill } from './skill-matching.mjs';

// Built-in workflow types ship as JSON files in roboTeamAgent/default-flows/; the file name
// is the workflow id. They are read-only: operators view them and copy them with Save as.
// A skill selection "<Repository>/<skill>" names a skill of an installed repository and is
// resolved to that repository's folder when the preset loads, so a preset that needs a
// repository appears only once the repository is available. "kind": "default" marks the
// generic workflow whose execution mode is chosen at launch.
export const PRESETS_DIR = fileURLToPath(new URL('../../default-flows/', import.meta.url));

const repositoryOf = id => typeof id === 'string' && !id.includes(':') && /^[A-Za-z0-9][\w.-]*\/[^/]/.test(id) ? id.split('/')[0] : null;

export function readPresets(directory = PRESETS_DIR) {
    return fsSync.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
        const id = path.basename(name, '.json');
        if (!WORKFLOW_ID_PATTERN.test(id)) throw new Error(`Built-in workflow file ${name} is not named by a valid workflow id`);
        const data = JSON.parse(fsSync.readFileSync(path.join(directory, name), 'utf8'));
        const repositories = [...new Set((data.tasks || []).flatMap(task => (task.skillsets || []).map(repositoryOf).filter(Boolean)))];
        return { id, name: data.name || id, data, repositories };
    });
}

// roots maps each repository the preset names to its installed folder.
export function presetGraph(preset, roots = {}) {
    const tasks = (preset.data.tasks || []).map(task => !Array.isArray(task.skillsets) ? task : { ...task, skillsets: task.skillsets.map(id => {
        const repository = repositoryOf(id);
        if (!repository) return id;
        if (!roots[repository]) throw new Error(`repository ${repository} is not available`);
        return canonicalSkill(roots[repository], id.slice(repository.length + 1));
    }) });
    return normalizeWorkflow({ ...preset.data, tasks }, { id: preset.id, builtin: preset.data.kind === 'default' });
}
