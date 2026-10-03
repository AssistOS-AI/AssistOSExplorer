import { randomUUID } from 'node:crypto';
import { createLiveSkillsFixture, liveSkillSources, liveSkillsHash, liveSkillsPrompt } from './copilot-live-skills.mjs';

// Synthetic browser/reader evidence follows current public contracts. Real files and ALA-produced
// transcript checks live in the runtime suite; none of these helpers invokes a native backend.
export function currentLiveSkillsCase({ disabled = false, root = '/srv/fresh workspace' } = {}) {
    const fixture = createLiveSkillsFixture(root);
    Object.assign(fixture, { robotId: 'owned-live-robot', robotName: `copilot-live-${fixture.runId}`,
        repositoryName: `copilot-live-source-${fixture.runId}`, repositoryRoot: `${root}/copilot-live-source-${fixture.runId}` });
    const phase = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
    const robotRoot = `/data/robots/${fixture.robotId}`;
    const selected = disabled ? [fixture.control] : [fixture.control, fixture.probe];
    const entries = selected.map(skill => ({ identity: `${fixture.repositoryName}/${skill.name}`, name: skill.name,
        source: fixture.repositoryName, sourcePath: `${fixture.repositoryRoot}/skills/${skill.name}`,
        fingerprint: liveSkillsHash(liveSkillSources(fixture, skill, root)) }));
    const links = selected.map(skill => ({ repoName: fixture.repositoryName, sourcePath: `skills/${skill.name}`,
        destination: `${fixture.workspace}/.agents/skills/${skill.name}`, linkTarget: `${fixture.repositoryRoot}/skills/${skill.name}` }));
    const revision = liveSkillsHash(links);
    const policy = { mode: 'live', excludedSkills: disabled ? [`${fixture.repositoryName}/${fixture.probe.name}`] : [] };
    const inventory = { robot: fixture.robotName, scope: 'conversation', sessionId, policy, policyVersion: 3,
        cwd: fixture.workspace, lastRevision: revision, activeRevision: null };
    const prompt = liveSkillsPrompt({ phase, selected });
    const final = selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker]).join('\n');
    const now = new Date().toISOString();
    const native = { id: sessionId, home: `${robotRoot}/home`, workspace: fixture.workspace,
        agent: 'codex', continuation: { threadId: randomUUID() }, turns: [{ turnId, user: prompt, final,
            status: 'completed', startedAt: now, endedAt: now }] };
    const snapshot = { robotRoot, workspaceRoot: root,
        robot: { id: fixture.robotId, name: fixture.robotName, repository: { name: fixture.repositoryName,
            source: fixture.repositoryRoot, generation: randomUUID() } }, native, capturedAt: now,
        session: { sessionId, cwd: fixture.workspace, skillPolicyRef: sessionId,
            engine: { type: 'ala', version: 1, backend: 'codex', sessionId, robotId: fixture.robotId, home: native.home, cwd: fixture.workspace },
            messages: [{ role: 'user', id: randomUUID(), text: prompt, turnId },
                { role: 'assistant', id: randomUUID(), text: final, turnId, status: 'completed' }],
            skillExecution: { active: false, live: true, revision, policyVersion: 3, entries, diagnostics: [] } },
        catalog: { revision, links, entries: structuredClone(entries) },
        liveLinks: Object.fromEntries(links.map(link => [link.destination.split('/').at(-1),
            { destination: link.destination, linkTarget: link.linkTarget, resolvedSource: link.linkTarget }])),
        capturedFiles: Object.fromEntries(selected.map(skill => {
            const source = liveSkillSources(fixture, skill, root);
            return [skill.name, { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 }];
        })),
        receipts: Object.fromEntries(selected.map(skill => [`${phase}-${skill.name}.json`, {
            version: 2, runId: fixture.runId, phase, skill: skill.name, marker: skill.helperMarker,
            invokedPath: `${fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs`,
            resolvedSource: `${fixture.repositoryRoot}/skills/${skill.name}/receipt.mjs`, cwd: fixture.workspace,
            helperSha256: liveSkillSources(fixture, skill, root).helperSha256, createdAt: now, pid: 12,
        }])) };
    return { workspaceRoot: root, fixture, phase, selected, available: selected, absent: disabled ? [fixture.probe] : [], sessionId, snapshot, inventory,
        baselineIds: [], priorTurnIds: [], expectedPolicy: { policyVersion: 3, policySha256: liveSkillsHash(policy) },
        startedAt: Date.now() - 1000, finishedAt: Date.now() + 1000 };
}
