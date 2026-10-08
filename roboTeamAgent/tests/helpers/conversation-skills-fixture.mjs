import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RobotSkillsets } from '../../server/robot-skillsets.mjs';
import { registerProject } from '../../server/project-storage.mjs';

// A fixture for the conversation skill tests that runs on any platform. The real
// RobotStore reads /proc to identify processes, so these tests use an in-memory
// robot registry with the same surface (get, list, withRobot, robotPath, dataDir)
// and the real RobotSkillsets, policies and live catalog on a temporary workspace.

export const DEFAULT_ROBOT_ID = 'default-aaaaaa';
export const OTHER_ROBOT_ID = 'other-bbbbbb';
export const SKILLSET = 'probe';
export const SKILL_IDENTITY = 'probe/probe-skill';
export const SECOND_IDENTITY = 'probe/second-skill';

export function authHeader(userId = 'user', roles = ['user']) {
    return JSON.stringify({ user: { id: userId, username: userId, roles } });
}

export function createStubRobotStore({ dataDir, robots }) {
    let chain = Promise.resolve();
    return {
        dataDir,
        robotPath: (id) => path.join(dataDir, 'robots', id),
        get: async (id) => structuredClone(robots.get(id) || null),
        list: async () => [...robots.values()].map((robot) => structuredClone(robot)),
        withRobot(id, operation) {
            const run = chain.then(async () => {
                const robot = structuredClone(robots.get(id) || null);
                if (!robot) throw new Error('robot not found');
                return operation(robot, async (updated) => { robots.set(id, structuredClone(updated)); });
            });
            chain = run.catch(() => {});
            return run;
        },
    };
}

async function writeSkill(directory, name, description) {
    await fs.mkdir(path.join(directory, name), { recursive: true });
    await fs.writeFile(path.join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.\n`);
}

export async function createConversationSkillsFixture({ descriptions = {} } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-skills-')));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const documentation = path.join(workspaceRoot, 'DocumentationSkills');
    await writeSkill(path.join(documentation, 'skills'), 'human-report', 'Final report.');
    const repository = path.join(project, 'skills-repo');
    await writeSkill(repository, 'probe-skill', descriptions['probe-skill'] || 'Probe skill.');
    await writeSkill(repository, 'second-skill', descriptions['second-skill'] || 'Second skill.');
    const createdAt = new Date().toISOString();
    const robots = new Map(Object.entries({ [DEFAULT_ROBOT_ID]: 'default', [OTHER_ROBOT_ID]: 'other' })
        .map(([id, name]) => [id, { id, name, skillsets: [], codingAgents: ['codex'], createdAt, updatedAt: createdAt }]));
    const robotStore = createStubRobotStore({ dataDir, robots });
    const skillsets = new RobotSkillsets({ robotStore, workspaceRoot, alaCommand: '/nonexistent/ala.mjs',
        repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: documentation, origin: 'workspace' }] } });
    await skillsets.add(DEFAULT_ROBOT_ID, { name: SKILLSET, source: repository });
    registerProject({ dataDir, workspaceRoot }, project);
    const sessionsDirectory = path.join(project, '.roboteam', 'sessions');
    await fs.mkdir(sessionsDirectory, { recursive: true });

    // Writes a hand-made saved conversation. `engine: null` omits the robot binding.
    async function addSession({ sessionId = crypto.randomUUID(), robotId = DEFAULT_ROBOT_ID, extra = {}, engine } = {}) {
        const now = new Date().toISOString();
        const record = { version: 2, sessionId, createdAt: now, updatedAt: now, turns: [], cwd: project,
            ...(engine === null ? {} : { engine: { type: 'ala', version: 1, sessionId, home: path.join(dataDir, 'robots', robotId, 'home'),
                cwd: project, backend: 'codex', robotId, ...engine } }), ...extra };
        await fs.mkdir(path.join(sessionsDirectory, sessionId), { recursive: true });
        const file = path.join(sessionsDirectory, sessionId, 'config.json');
        await fs.writeFile(file, JSON.stringify(record));
        return { sessionId, file };
    }

    const policiesDirectory = (robotId) => path.join(robotStore.robotPath(robotId), 'runtime', 'skill-policies');
    const policyFile = (robotId, policyId) => path.join(policiesDirectory(robotId), `${policyId}.json`);
    async function policyFiles(robotId) {
        try { return (await fs.readdir(policiesDirectory(robotId))).sort(); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
    const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

    return {
        root, workspaceRoot, project, dataDir, repository, robotStore, skillsets, robots,
        addSession, policiesDirectory, policyFile, policyFiles, digest,
        async close() {
            if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
            else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}
