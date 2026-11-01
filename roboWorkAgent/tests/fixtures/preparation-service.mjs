import fs from 'node:fs/promises';
import path from 'node:path';
import { RobotPaths } from '../../server/robot-paths.mjs';
import { RunManager } from '../../server/run-manager.mjs';
import { createTerminalProfiles, ensureTerminalStub } from '../../server/terminal-profiles.mjs';
import { createRoboWorkServer } from '../../server/http-server.mjs';

const paths = new RobotPaths({ dataDir: path.join(process.env.FIXTURE_ROOT, 'data'), workspaceRoot: path.join(process.env.FIXTURE_ROOT, 'workspace') });
const cwd = path.join(paths.workspaceRoot, 'project');
for (const directory of [cwd, path.join(paths.workspaceRoot, '.data'), paths.home('robot-a'), paths.soul('robot-a')]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(paths.robot('robot-a'), 'label'), '{}');
await ensureTerminalStub(paths, 'robot-a');
const robots = { require: async id => ({ id, name: 'Robot A', codingAgents: ['opencode'] }) };
const toolCache = { root: path.join(paths.dataDir, 'tool-cache'), prepareShellTools: async () => ({ binPath: '/fixture/bin' }), prepareCodingAgents: async () => ({}) };
const runtimeBundle = {
    prepare: async () => { throw new Error('Fixture static preparation failed'); },
    prepareAla: async () => { throw new Error('Fixture ALA preparation failed'); },
};
const environment = { list: async () => [{ ref: 'repo/agent', key: 'environment', name: 'Environment', available: true }], require: async ref => ({ ref }) };
const terminal = createTerminalProfiles({ paths, robots, toolCache, runtimeBundle, environment, homeOperation: async () => {} });
const runs = new RunManager({ paths, robots, toolCache, runtimeBundle, environment, alaEntry: '/fixture/ala',
    buildLaunch: async () => ({ command: process.execPath, args: ['-e', "process.stdin.on('data',b=>process.stdout.write(b));"],
        options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} } }),
});
await runs.initialize();
await runs.start({ runId: 'active-run', robotId: 'robot-a', cwd, ala: { sessionId: 'active-session' }, folders: [], channels: [], ignore: [], tag: {} });
const server = createRoboWorkServer({ robots, runs, environment, terminal, internalToken: 'fixture-token' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.send({ port: server.address().port, pid: runs.get('active-run').child.pid, cwd });
process.on('SIGTERM', () => { void (async () => {
    await runs.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); process.exit(0);
})(); });
