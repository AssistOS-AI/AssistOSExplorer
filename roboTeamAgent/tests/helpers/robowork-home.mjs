import fs from 'node:fs/promises';
import path from 'node:path';
import { homeOperation } from '../../../roboWorkAgent/server/home-op.mjs';

// RoboWork owns robot homes, outside RoboTeam's data directory. This client performs the same home operations in-process,
// with every home under `root`.
export function homeRoboWork(root) {
    const home = robotId => path.join(root, 'robowork-homes', robotId);
    return {
        home,
        async call(method, input = {}) {
            if (method === 'robot_ensure') {
                await fs.mkdir(home(input.robotId), { recursive: true, mode: 0o700 });
                return homeOperation('ensure', { codingAgents: input.codingAgents }, home(input.robotId));
            }
            if (method === 'robot_config_set') return homeOperation('config_set', input, home(input.robotId));
            return {};
        },
    };
}
