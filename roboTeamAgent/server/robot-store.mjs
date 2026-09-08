import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROBOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

function normalizeName(value) {
    const name = String(value || '').trim();
    if (!name) throw new Error('robot name is required');
    if (name.length > 80) throw new Error('robot name must be at most 80 characters');
    return name;
}

function normalizeSpecialization(value) {
    const specialization = String(value || '').trim();
    if (specialization.length > 500) throw new Error('specialization must be at most 500 characters');
    return specialization;
}

function slugify(value) {
    const slug = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'robot';
}

async function processStart(pid) {
    const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
}

async function readRegistryOwner(file) {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('robot registry lock must be a regular file');
        const owner = JSON.parse(await handle.readFile('utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.start)
            || typeof owner.boot !== 'string' || !owner.boot || typeof owner.token !== 'string' || !owner.token) {
            throw new Error('robot registry lock owner is invalid');
        }
        return { owner, stat };
    } finally {
        await handle.close();
    }
}

async function withRegistryMutation(directory, operation) {
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('robot registry must be a real directory');
    const lock = path.join(directory, '.registry.lock');
    const claim = `${lock}.recovery`;
    const owner = {
        pid: process.pid, start: await processStart(process.pid),
        boot: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
        token: crypto.randomUUID(),
    };
    const candidate = path.join(directory, `.registry-owner-${owner.token}`);
    await fs.writeFile(candidate, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    let acquired = false;
    try {
        const deadline = Date.now() + 5000;
        while (!acquired) {
            try {
                await fs.link(candidate, lock);
                acquired = true;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                let previous;
                try { previous = await readRegistryOwner(lock); }
                catch (readError) {
                    if (readError.code === 'ENOENT') continue;
                    throw new Error('robot registry lock cannot be verified', { cause: readError });
                }
                let dead = previous.owner.boot !== owner.boot;
                if (!dead) {
                    try { dead = await processStart(previous.owner.pid) !== previous.owner.start; }
                    catch (probe) {
                        if (probe.code !== 'ENOENT') throw probe;
                        dead = true;
                    }
                }
                if (dead) {
                    try { await fs.link(lock, claim); }
                    catch (recoveryError) {
                        if (recoveryError.code === 'ENOENT') continue;
                        throw new Error('robot registry lock recovery requires reconciliation', { cause: recoveryError });
                    }
                    try {
                        const current = await readRegistryOwner(lock);
                        const claimed = await readRegistryOwner(claim);
                        if (current.owner.token !== previous.owner.token || current.stat.ino !== claimed.stat.ino
                            || current.stat.dev !== claimed.stat.dev) throw new Error('robot registry lock owner changed');
                        await fs.unlink(lock);
                    } finally {
                        await fs.unlink(claim);
                    }
                } else {
                    if (Date.now() >= deadline) throw new Error('robot registry is busy');
                    await delay(10);
                }
            }
        }
        return await operation();
    } finally {
        try {
            if (acquired) {
                const current = await readRegistryOwner(lock);
                if (current.owner.token !== owner.token) throw new Error('robot registry lock owner changed');
                await fs.unlink(lock);
            }
        } finally {
            await fs.unlink(candidate);
        }
    }
}

export class RobotStore {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.robotsDir = path.join(this.dataDir, 'robots');
    }

    async initialize() {
        await fs.mkdir(this.robotsDir, { recursive: true, mode: 0o700 });
        const entry = await fs.lstat(this.robotsDir);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('robot registry must be a real directory');
        await fs.chmod(this.robotsDir, 0o700);
    }

    robotPath(robotId) {
        if (!ROBOT_ID_PATTERN.test(String(robotId || ''))) throw new Error('invalid robot id');
        const resolved = path.resolve(this.robotsDir, robotId);
        if (path.dirname(resolved) !== this.robotsDir) throw new Error('invalid robot path');
        return resolved;
    }

    async _writeMetadata(robotRoot, metadata) {
        const tempPath = path.join(robotRoot, `.metadata-${process.pid}-${crypto.randomUUID()}.tmp`);
        const metadataPath = path.join(robotRoot, 'metadata.json');
        await fs.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tempPath, metadataPath);
    }

    async _ensureLayout(robotRoot) {
        for (const directory of ['home', 'workspace', 'downloads', 'logs', 'runtime']) {
            const target = path.join(robotRoot, directory);
            await fs.mkdir(target, { recursive: true, mode: 0o700 });
            await fs.chmod(target, 0o700);
        }
        const codexHome = path.join(robotRoot, 'home', '.codex');
        await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
        await fs.chmod(codexHome, 0o700);
    }

    async _readMetadata(robotId) {
        const handle = await fs.open(path.join(this.robotPath(robotId), 'metadata.json'),
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let metadata;
        try {
            if (!(await handle.stat()).isFile()) throw new Error(`robot metadata is not a file for ${robotId}`);
            metadata = JSON.parse(await handle.readFile('utf8'));
        } finally {
            await handle.close();
        }
        if (metadata?.schema !== 'roboteam-robot-v1' || metadata.id !== robotId) {
            throw new Error(`robot metadata is invalid for ${robotId}`);
        }
        return metadata;
    }

    async _allRobots({ strict = false } = {}) {
        await this.initialize();
        const entries = await fs.readdir(this.robotsDir, { withFileTypes: true });
        const robots = [];
        for (const entry of entries) {
            if (strict && entry.isSymbolicLink() && ROBOT_ID_PATTERN.test(entry.name)) {
                throw new Error(`robot registry entry is a symbolic link: ${entry.name}`);
            }
            if (!entry.isDirectory() || !ROBOT_ID_PATTERN.test(entry.name)) continue;
            try {
                const robot = await this._readMetadata(entry.name);
                if (strict && (typeof robot.name !== 'string' || normalizeName(robot.name) !== robot.name)) {
                    throw new Error('robot metadata name is invalid');
                }
                robots.push(robot);
            } catch (error) {
                if (strict) throw new Error(`robot registry metadata is invalid for ${entry.name}`, { cause: error });
                // Corrupt records remain private and are omitted from normal listings.
            }
        }
        return robots.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    }

    async list() {
        return this._allRobots();
    }

    async get(robotId) {
        try {
            return await this._readMetadata(robotId);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
    }

    async getByName(name) {
        const normalizedName = normalizeName(name);
        return (await this._allRobots()).find((robot) => robot.name === normalizedName) || null;
    }

    async ensureDefaultRobot() {
        await this.initialize();
        return withRegistryMutation(this.robotsDir, async () => {
            const matches = (await this._allRobots({ strict: true })).filter((robot) => robot.name === 'default');
            if (matches.length > 1) throw new Error('robot registry contains more than one robot named default');
            return matches[0] || this._create({ name: 'default', specialization: '' });
        });
    }

    async create({ name, specialization = '' }) {
        await this.initialize();
        return withRegistryMutation(this.robotsDir, () => this._create({ name, specialization }));
    }

    async _create({ name, specialization = '' }) {
        const normalizedName = normalizeName(name);
        const normalizedSpecialization = normalizeSpecialization(specialization);
        await this.initialize();
        if ((await this._allRobots({ strict: true })).some((robot) => robot.name === normalizedName)) {
            throw new Error('robot name already exists');
        }
        let robotId;
        let robotRoot;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            robotId = `${slugify(normalizedName)}-${crypto.randomBytes(3).toString('hex')}`;
            robotRoot = this.robotPath(robotId);
            try {
                await fs.mkdir(robotRoot, { mode: 0o700 });
                break;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                robotRoot = null;
            }
        }
        if (!robotRoot) throw new Error('could not allocate robot id');
        await this._ensureLayout(robotRoot);
        const now = new Date().toISOString();
        const metadata = {
            schema: 'roboteam-robot-v1',
            id: robotId,
            name: normalizedName,
            specialization: normalizedSpecialization,
            createdAt: now,
            updatedAt: now,
        };
        await this._writeMetadata(robotRoot, metadata);
        return metadata;
    }

    async delete(robotId) {
        await this.initialize();
        return withRegistryMutation(this.robotsDir, async () => {
            const robot = await this.get(robotId);
            if (!robot) return false;
            const root = this.robotPath(robotId);
            const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
            for (const name of await fs.readdir(root)) {
                if (!/^\.cli-[a-f0-9-]+\.json$/.test(name)) continue;
                const { owner } = await readRegistryOwner(path.join(root, name));
                if (owner.boot !== boot) continue;
                try {
                    if (await processStart(owner.pid) === owner.start) {
                        throw new Error('close the robot chat and stop its CLI tasks before deleting it');
                    }
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
            await fs.rm(this.robotPath(robotId), { recursive: true, force: true });
            return true;
        });
    }

    async acquireCliUsage(robotId) {
        return this.withRobot(robotId, async () => {
            const owner = { pid: process.pid, start: await processStart(process.pid),
                boot: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), token: crypto.randomUUID() };
            const file = path.join(this.robotPath(robotId), `.cli-${owner.token}.json`);
            await fs.writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            return async () => { await fs.unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; }); };
        });
    }

    async withRobot(robotId, operation) {
        await this.initialize();
        return withRegistryMutation(this.robotsDir, async () => {
            const robot = await this.get(robotId);
            if (!robot) throw new Error('robot not found');
            return operation(robot, async (updated) => {
                await this._writeMetadata(this.robotPath(robotId), { ...updated, updatedAt: new Date().toISOString() });
            });
        });
    }
}

export const robotStoreInternals = { slugify, ROBOT_ID_PATTERN };
