import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

export class RobotStore {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.robotsDir = path.join(this.dataDir, 'robots');
    }

    async initialize() {
        await fs.mkdir(this.robotsDir, { recursive: true, mode: 0o700 });
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
        const raw = await fs.readFile(path.join(this.robotPath(robotId), 'metadata.json'), 'utf8');
        const metadata = JSON.parse(raw);
        if (metadata?.schema !== 'roboteam-robot-v1' || metadata.id !== robotId) {
            throw new Error(`robot metadata is invalid for ${robotId}`);
        }
        return metadata;
    }

    async _allRobots() {
        await this.initialize();
        const entries = await fs.readdir(this.robotsDir, { withFileTypes: true });
        const robots = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !ROBOT_ID_PATTERN.test(entry.name)) continue;
            try {
                robots.push(await this._readMetadata(entry.name));
            } catch {
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

    async create({ name, specialization = '' }) {
        const normalizedName = normalizeName(name);
        const normalizedSpecialization = normalizeSpecialization(specialization);
        await this.initialize();
        if ((await this._allRobots()).some((robot) => robot.name === normalizedName)) {
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
        const robot = await this.get(robotId);
        if (!robot) return false;
        await fs.rm(this.robotPath(robotId), { recursive: true, force: true });
        return true;
    }
}

export const robotStoreInternals = { slugify, ROBOT_ID_PATTERN };
