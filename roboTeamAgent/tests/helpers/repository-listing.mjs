import { readRepositorySkillCatalog } from '../../../../ploinky/cli/utils/skillRepositorySource.js';

// What Ploinky's list-repos returns for a local checkout: skills/*/SKILL.md by folder name and the root skillsets.md.
export function listedRepository(name, source, { kind = 'skills', origin = 'workspace', url } = {}) {
    return { name, source, origin, kind, ...readRepositorySkillCatalog(source), ...(url ? { url } : {}) };
}
