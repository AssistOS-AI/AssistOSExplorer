const HIDDEN_REPOSITORY_IDENTITIES = new Set([
    'basic',
    'cloud',
    'container-image-builds',
    'copilot-agents',
    'demo',
    'extra',
    'security',
    'vibe',
    'achillescopilotbasicskills',
    'documentationskills',
    'ploinkyskills',
]);

const SKILL_TYPES = new Set([
    'skill', 'skills', 'skill.md', 'cskill', 'dcgskill', 'mskill', 'oskill', 'tskill',
]);

function normalizedType(value) {
    return String(value || '').trim().toLowerCase();
}

function isSkillEntry(entry) {
    return [entry?.kind, entry?.type].some(value => SKILL_TYPES.has(normalizedType(value)));
}

// Match catalog names and Git source basenames, including SSH URLs and .git suffixes.
export function marketplaceRepositoryIdentity(value) {
    const source = String(value || '').trim();
    let path;
    try {
        path = new URL(source.replace(/^git\+/, '')).pathname;
    } catch {
        path = source.split(/[?#]/, 1)[0];
    }
    let basename = path.replace(/\/+$/, '').split(/[/:]/).at(-1);
    try {
        basename = decodeURIComponent(basename);
    } catch {
        // A malformed escape remains a literal repository name.
    }
    return basename.replace(/\.git$/i, '').toLowerCase();
}

export function marketplaceAgentRepositoryName(agent) {
    return String(agent?.repo || agent?.repoName || '').trim()
        || String(agent?.ref || '').trim().split('/').slice(0, -1).join('/');
}

function agentRef(agent) {
    const repository = marketplaceRepositoryIdentity(marketplaceAgentRepositoryName(agent));
    const name = String(agent?.name || agent?.agentName || String(agent?.ref || '').split('/').at(-1)).trim();
    return `${repository}/${name}`;
}

/** Project the router catalog for Marketplace only; retain the source and agent lifecycle objects. */
export function getVisibleMarketplaceCatalog(marketplace) {
    const repositories = Array.isArray(marketplace?.repositories) ? marketplace.repositories : [];
    const agents = Array.isArray(marketplace?.agents) ? marketplace.agents : [];
    const hiddenIdentities = new Set(HIDDEN_REPOSITORY_IDENTITIES);
    const identitiesByRepository = new Map(repositories.map(repo => [repo, [
        marketplaceRepositoryIdentity(repo?.name),
        marketplaceRepositoryIdentity(repo?.url),
    ].filter(Boolean)]));
    const hiddenRepositories = new Set(repositories.filter(repo => (
        isSkillEntry(repo) || [repo?.kind, repo?.type].some(value => normalizedType(value) === 'mixed')
    )));

    // Propagate a source's policy to every local alias, independent of catalog ordering.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [repo, identities] of identitiesByRepository) {
            if (!hiddenRepositories.has(repo) && !identities.some(value => hiddenIdentities.has(value))) continue;
            hiddenRepositories.add(repo);
            for (const identity of identities) {
                if (hiddenIdentities.has(identity)) continue;
                hiddenIdentities.add(identity);
                changed = true;
            }
        }
    }

    const visibleAgents = agents.filter(agent => {
        const refRepository = marketplaceAgentRepositoryName({ref: agent?.ref});
        return !isSkillEntry(agent) && ![
            marketplaceAgentRepositoryName(agent), refRepository,
        ].some(value => hiddenIdentities.has(marketplaceRepositoryIdentity(value)));
    });
    const visibleRefs = new Set(visibleAgents.map(agentRef));
    const enabledAgents = Array.isArray(marketplace?.enabledAgents)
        ? marketplace.enabledAgents.filter(agent => visibleRefs.has(agentRef(agent)))
        : visibleAgents.filter(agent => agent.active === true);
    const enabledCounts = new Map();
    for (const agent of enabledAgents) {
        const identity = marketplaceRepositoryIdentity(marketplaceAgentRepositoryName(agent));
        enabledCounts.set(identity, (enabledCounts.get(identity) || 0) + 1);
    }

    return {
        repositories: repositories.filter(repo => !hiddenRepositories.has(repo)).map(repo => ({
            ...repo,
            activeAgentsCount: enabledCounts.get(marketplaceRepositoryIdentity(repo.name)) || 0,
        })),
        agents: visibleAgents,
    };
}
