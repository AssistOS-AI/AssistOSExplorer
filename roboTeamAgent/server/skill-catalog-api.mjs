import fs from 'node:fs/promises';
import path from 'node:path';
import { skillError } from './skill-files.mjs';

export async function skillCatalogRequest({ skillsets, robot, input = {}, mutate = false }) {
    let session, policyId, policy, result;
    if (input.sessionId) {
        if (!/^[a-f0-9-]{36}$/.test(input.sessionId)) throw skillError('invalid conversation id');
        const file = path.join(skillsets.robotStore.robotPath(robot.id), 'copilot', 'sessions', `${input.sessionId}.json`);
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { session = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        if (session.sessionId !== input.sessionId) throw skillError('invalid conversation record');
        policyId = session.skillPolicyRef || session.sessionId;
        policy = await skillsets.policies.read(robot.id, policyId) || await skillsets.policies.make(robot, {}, session.skillSelection || session.legacySkillSelection);
    } else ({ policyId, policy } = await skillsets.defaults(robot));
    const cwd = session?.engine?.cwd || session?.cwd || input.dir || policy.scopeRoot;
    if (mutate) {
        if (!Number.isSafeInteger(input.policyVersion)) throw skillError('policyVersion is required');
        if (policy.policyVersion !== input.policyVersion) throw Object.assign(skillError('skill policy changed; reload before updating'), { statusCode: 409 });
        await skillsets.policies.ensure(robot, policyId, { legacy: session?.skillSelection || session?.legacySkillSelection });
        result = await skillsets.setEnabled(robot, policyId, input.policyVersion, input.identity, input.enabled, cwd);
        policy = result.policy;
    }
    result ||= policy.mode === 'pinned' ? await skillsets.pinnedInventory(robot, policy)
        : await skillsets.inventory(robot, { policyId, policy, cwd });
    return { ...result, policy: { version: policy.version, mode: policy.mode, selectors: policy.selectors,
        excludedSkills: policy.excludedSkills, excludedSources: policy.excludedSources, excludedNames: policy.excludedNames },
        scope: session ? 'conversation' : 'defaults', robot: robot.name, sessionId: session?.sessionId || null,
        activeRevision: session?.skillExecution?.active && await skillsets.live.active(robot.id, policyId, session.skillExecution.catalogId) ? { revision: session.skillExecution.revision,
            policyVersion: session.skillExecution.policyVersion } : null,
        lastRevision: session?.skillExecution?.revision || null, cwd, scopeRoot: policy.scopeRoot };
}
