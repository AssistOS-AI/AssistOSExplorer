import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, isInternalId } from '../stateProtocol.mjs';

// The worker's own robot storage (decision M-10). Everything a robot owns lives under one private root,
// `<root>/robots/<robotId>/`, inside the worker's persistent store (Ploinky `persistentStorage`, mounted at
// /var/lib/robo-work). RoboTeam's data is never read or bound, and nothing is migrated.
//
//   home/          the robot HOME, bound read-write at /home/robot in every workload (coding-agent credentials live here)
//   config/ala.json  the managed ALA configuration (codingAgent, models, efforts), bound read-only into the orchestration domain
//   sessions/      ALA's private session storage (ALA_SESSIONS), bound read-write into the orchestration domain only
//
// All methods are synchronous because the runtime adapter that uses `verify` runs inside S1 transactions.

const ALA_AGENTS = Object.freeze(['codex', 'opencode', 'pi', 'claude']);
const MODE_DIRECTORY = 0o700;

function isDirectoryNoFollow(target) {
    try {
        const stat = fs.lstatSync(target);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function assertRobotId(robotId) {
    if (!isInternalId(robotId)) throw new TypeError('Invalid robot id');
    return robotId;
}

// The managed ALA configuration of a robot configuration `{backend, settings}`. ALA accepts only codingAgent, models and
// efforts, so anything else in `settings` is not passed on. Output is canonical (stable bytes for the attestation check).
export function managedAlaConfig(configuration) {
    const config = {};
    if (configuration && ALA_AGENTS.includes(configuration.backend)) config.codingAgent = configuration.backend;
    const settings = configuration?.settings ?? {};
    const models = {};
    for (const [name, model] of Object.entries(settings.models ?? {})) {
        if (ALA_AGENTS.includes(name) && typeof model === 'string' && model.trim()) models[name] = model.trim();
    }
    // RoboTeam's one-agent robot sends `settings.model` and `settings.effort` for its `backend`; a plural map wins when both exist.
    if (ALA_AGENTS.includes(configuration?.backend) && models[configuration.backend] === undefined
        && typeof settings.model === 'string' && settings.model.trim()) {
        models[configuration.backend] = settings.model.trim();
    }
    const efforts = {};
    const singleEffort = ALA_AGENTS.includes(configuration?.backend) && typeof settings.effort === 'string' ? { [configuration.backend]: settings.effort } : {};
    for (const [name, effort] of Object.entries({ ...singleEffort, ...(settings.efforts ?? {}) })) {
        if (models[name] && typeof effort === 'string' && /^[A-Za-z0-9_-]+$/u.test(effort)) efforts[name] = effort;
    }
    config.models = models;
    config.efforts = efforts;
    return config;
}

export function createRobotStore({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('The robot store root must be an absolute path');
    const robotsRoot = path.join(root, 'robots');
    const paths = (robotId) => {
        const base = path.join(robotsRoot, assertRobotId(robotId));
        return {
            base, home: path.join(base, 'home'), configDir: path.join(base, 'config'), config: path.join(base, 'config', 'ala.json'),
            sessions: path.join(base, 'sessions')
        };
    };

    function ensureDirectory(target) {
        if (!isDirectoryNoFollow(target)) {
            try { fs.mkdirSync(target, { recursive: true, mode: MODE_DIRECTORY }); } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
            if (!isDirectoryNoFollow(target)) throw new Error('A robot directory is not a plain directory');
        }
    }

    return Object.freeze({
        root, robotsRoot, paths,

        // Creates (idempotently) the HOME, the session directory and the managed configuration of a robot.
        prepare(robotId, configuration) {
            const where = paths(robotId);
            ensureDirectory(robotsRoot);
            for (const directory of [where.base, where.home, where.configDir, where.sessions]) ensureDirectory(directory);
            const bytes = `${canonicalJson(managedAlaConfig(configuration))}\n`;
            const temporary = `${where.config}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, bytes, { mode: 0o600 });
            fs.renameSync(temporary, where.config);
            return where;
        },

        // True when HOME, sessions and the managed configuration exist as plain entries and the configuration matches.
        verify(robotId, configuration) {
            try {
                const where = paths(robotId);
                if (![where.base, where.home, where.configDir, where.sessions].every(isDirectoryNoFollow)) return false;
                const stat = fs.lstatSync(where.config);
                if (!stat.isFile() || stat.isSymbolicLink()) return false;
                return fs.readFileSync(where.config, 'utf8') === `${canonicalJson(managedAlaConfig(configuration))}\n`;
            } catch {
                return false;
            }
        },

        // Removes everything of a robot. The path derives from a validated robot id under the private root only.
        remove(robotId) {
            const where = paths(robotId);
            if (!where.base.startsWith(`${robotsRoot}${path.sep}`)) throw new Error('Refusing to remove outside the robot store');
            // Never follow: a link in place of the robot directory is removed as a link, and rmSync unlinks every link below it
            // (HOME is robot-writable) without entering its target. Nothing outside robots/<id> is touched.
            let stat = null;
            try { stat = fs.lstatSync(where.base); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (stat === null) return;
            if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(where.base);
            else fs.rmSync(where.base, { recursive: true, force: true });
        },

        exists(robotId) {
            return isDirectoryNoFollow(paths(robotId).base);
        }
    });
}
