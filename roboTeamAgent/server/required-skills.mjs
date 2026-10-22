import fs from 'node:fs/promises';
import path from 'node:path';
import { repositoryClient } from './repository-client.mjs';
import { inspectSkill } from './workspace-skill-source.mjs';
import { inside, skillError } from './skill-files.mjs';
import { discoverTaskSkills } from './skill-descriptor.mjs';

export const HUMAN_REPORT_SKILL = 'human-report';
export const HUMAN_REPORT_IDENTITY = `required/${HUMAN_REPORT_SKILL}`;
const REPOSITORY = 'DocumentationSkills';

export async function requiredDocumentationRepository(service = {}) {
    const client = service.repositoriesClient || await repositoryClient();
    let repositories = await client.listRepositories();
    let repo = repositories.find(entry => entry.name === REPOSITORY);
    if (!repo || repo.origin === 'remote') {
        repositories = await client.prepareRepository({ name: REPOSITORY,
            url: repo?.url || 'https://github.com/AssistOS-AI/DocumentationSkills.git' });
        repo = repositories.find(entry => entry.name === REPOSITORY && entry.origin !== 'remote');
    }
    if (!repo || repo.origin === 'remote') throw skillError('Required DocumentationSkills repository is unavailable');
    return fs.realpath(repo.source);
}

export async function requiredHumanReportSkill(service) {
    const root = await requiredDocumentationRepository(service);
    return inspectRequiredHumanReport(root, directory => service.discover(directory));
}

// Startup uses the declared mount directly, before Router/MCP readiness.
export async function validateMountedRequiredSkills({ repositoryPath = '/Agent/linked/DocumentationSkills' } = {}) {
    try {
        const root = await fs.realpath(repositoryPath);
        return await inspectRequiredHumanReport(root, directory => discoverTaskSkills([directory]));
    } catch (error) {
        throw new Error(`Required DocumentationSkills/human-report dependency is unavailable: ${error.message}`, { cause: error });
    }
}

async function inspectRequiredHumanReport(root, discover) {
    const sourcePath = await fs.realpath(path.join(root, 'skills', HUMAN_REPORT_SKILL));
    if (!inside(root, sourcePath)) throw skillError('Required human-report skill is outside its repository');
    const inspected = await inspectSkill(sourcePath, discover);
    if (inspected.name !== HUMAN_REPORT_SKILL) throw skillError('Required human-report skill has an invalid name');
    return { ...inspected, identity: HUMAN_REPORT_IDENTITY, source: REPOSITORY, sourceId: 'required',
        sourcePath, owner: root, type: 'anthropic', required: true, readOnly: true,
        enabled: true, explicit: true, state: 'selected' };
}
