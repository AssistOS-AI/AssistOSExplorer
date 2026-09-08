export const hiddenRepositoryNames = [
    'basic', 'cloud', 'container-image-builds', 'copilot-agents', 'demo', 'extra', 'security', 'vibe',
    'AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills',
];

export function marketplaceCatalog() {
    const repositories = hiddenRepositoryNames.flatMap((name, index) => [
        {name, kind: index < 8 ? 'agents' : 'skills', installed: true},
        {
            name: `alias-${index}`,
            url: index % 2 ? `git@github.com:PloinkyRepos/${name.toUpperCase()}.git`
                : `https://github.com/AssistOS-AI/${name}.git/?branch=main`,
            kind: 'unknown',
            installed: true,
        },
    ]);
    repositories.push(
        {name: 'custom-skills', kind: ' SKILLS ', url: 'https://example.test/team/custom-source.git'},
        {name: 'mixed-source', kind: 'mixed'},
        {name: 'typed-source', type: 'skill'},
        {name: 'custom-alias', kind: 'agents', url: 'ssh://git@example.test/team/custom-source.git'},
        {name: 'AchillesIDE', kind: 'agents', installed: true, activeAgentsCount: 99},
        {name: 'AchillesCLI', kind: 'agents', installed: true},
        {name: 'proxies', kind: 'agents', installed: true},
        {name: 'skill-tools', kind: 'agents', installed: false, url: 'https://example.test/skill-tools.git'},
        {name: 'basic-tools', kind: 'agents', installed: true},
        {name: 'resources', kind: 'unknown', installed: true},
    );
    const agents = repositories.map(repo => ({
        repo: repo.name,
        name: 'worker',
        ref: `${repo.name}/worker`,
        about: 'Fixture agent',
        active: true,
        status: 'running',
        running: true,
        enableMode: 'global',
        enableModes: ['isolated', 'global', 'devel'],
    }));
    for (const [index, type] of ['skill', 'skills', 'skill.md', 'cskill', 'dcgskill', 'mskill', 'oskill', 'tskill'].entries()) {
        agents.push({
            repo: 'AchillesIDE', name: `hidden-skill-${index}`, ref: `AchillesIDE/hidden-skill-${index}`,
            [index % 2 ? 'kind' : 'type']: ` ${type.toUpperCase()} `, active: true, status: 'starting',
        });
    }
    agents.push(
        {ref: 'BASIC/orphan', name: 'orphan', active: true, status: 'starting'},
        {repo: 'cloud', name: 'conflicting', ref: 'unlisted/conflicting', active: true},
        {ref: 'AllowedOrphan/worker', name: 'worker', active: false},
        {ref: 'Standalone', name: 'Standalone', active: false},
    );
    return {
        repositories, agents, permissions: {canManage: true},
        enabledAgents: agents.filter(agent => agent.active).map(agent => ({
            repoName: agent.repo || agent.ref.split('/')[0],
            agentName: agent.name, type: 'agent',
        })),
    };
}

export const visibleRepositoryNames = ['AchillesIDE', 'AchillesCLI', 'proxies', 'skill-tools', 'basic-tools', 'resources'];
export const visibleAgentRefs = [
    ...visibleRepositoryNames.map(name => `${name}/worker`), 'AllowedOrphan/worker', 'Standalone',
];
