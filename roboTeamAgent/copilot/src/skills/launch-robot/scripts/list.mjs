import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createRoboTeamClient } from './roboTeamClient.mjs';

function clean(value, fallback = '—') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
}

export async function action(invocation = {}) {
    try {
        const client = await createRoboTeamClient(invocation);
        const result = await client.call('robot_list', {});
        const robots = Array.isArray(result.robots) ? result.robots : [];
        if (robots.length === 0) return 'No RoboTeam robots are available in this workspace.';
        return robots.map((robot) => {
            const mode = clean(robot.run?.mode, 'stopped');
            const state = clean(robot.run?.state, 'stopped');
            const catalog = (robot.skillsets || []).map((set) => {
                const skills = (set.skills || []).map((skill) => `    - ${clean(skill.id, `${set.name}/${skill.name}`)}: ${clean(skill.description)}`);
                return [`  Skillset ${clean(set.name)}: ${clean(set.description)}`, ...skills].join('\n');
            });
            return [`- ${clean(robot.name, 'Unnamed robot')} — ${clean(robot.description || robot.specialization)} — ${mode}/${state}`, ...catalog].join('\n');
        }).join('\n');
    } catch (error) {
        return `Could not list RoboTeam robots: ${error?.message || 'request failed'}`;
    }
}

export default action;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {


    let invocation;
    try {
        const { values } = parseArgs({
            options: { input: { type: 'string' } },
            strict: true,
            allowPositionals: false,
        });
        if (values.input === undefined) throw new Error('Usage: node scripts/list.mjs --input <string>');
        const { createSkillInvocation } = await import('./ploinkyInvocation.mjs');
        invocation = await createSkillInvocation({ skillName: 'launch-robot', input: values.input });
        const result = await action(invocation);
        console.log(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (error) {
        console.error(error?.code === 'ERR_MODULE_NOT_FOUND'
            ? 'The skill runtime is unavailable; execute this script inside a bridge-enabled ALA turn.'
            : error?.message || 'Skill execution failed.');
        process.exitCode = 1;
    } finally {
        if (invocation) await invocation.close();
    }
}
