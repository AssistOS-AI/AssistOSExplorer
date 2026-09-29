import fs from 'node:fs/promises';
import path from 'node:path';
import { repositoryClient } from './repository-client.mjs';
import { inspectSkill } from './workspace-skill-source.mjs';
import { inside, skillError } from './skill-files.mjs';

export const IMPACT_SKILL = 'summarize-agent-impact';
export const IMPACT_IDENTITY = `required/${IMPACT_SKILL}`;
const REPOSITORY = 'DocumentationSkills';

export async function requiredImpactSkill(service) {
    const client = service.repositoriesClient || await repositoryClient();
    let repositories = await client.listRepositories();
    let repo = repositories.find(entry => entry.name === REPOSITORY);
    if (!repo || repo.origin === 'remote') {
        repositories = await client.prepareRepository({ name: REPOSITORY,
            url: repo?.url || 'https://github.com/AssistOS-AI/DocumentationSkills.git' });
        repo = repositories.find(entry => entry.name === REPOSITORY && entry.origin !== 'remote');
    }
    if (!repo || repo.origin === 'remote') throw skillError('Required DocumentationSkills repository is unavailable');
    const root = await fs.realpath(repo.source);
    const sourcePath = await fs.realpath(path.join(root, 'skills', IMPACT_SKILL));
    if (!inside(root, sourcePath)) throw skillError('Required impact skill is outside its repository');
    const inspected = await inspectSkill(sourcePath, directory => service.discover(directory));
    if (inspected.name !== IMPACT_SKILL) throw skillError('Required impact skill has an invalid name');
    return { ...inspected, identity: IMPACT_IDENTITY, source: REPOSITORY, sourceId: 'required',
        sourcePath, owner: root, type: 'anthropic', required: true, readOnly: true,
        enabled: true, explicit: true, state: 'selected' };
}
