import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROBOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

function normalizeOwnerUserId(value) {
    const owner = String(value || '').trim();
    if (!owner || owner.length > 256 || /[\0\r\n]/.test(owner)) {
        throw new Error('authenticated user identity is required');
    }
    return owner;
}

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
        this.legacyProfilesDir = path.join(this.dataDir, 'profiles');
    }

    async initialize() {
        await fs.mkdir(this.robotsDir, { recursive: true, mode: 0o700 });
        await fs.chmod(this.robotsDir, 0o700);
        await this._migrateLegacyProfiles();
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
    }

    async _migrateLegacyProfiles() {
        let entries;
        try {
            entries = await fs.readdir(this.legacyProfilesDir, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || !ROBOT_ID_PATTERN.test(entry.name)) continue;
            const source = path.join(this.legacyProfilesDir, entry.name);
            const target = this.robotPath(entry.name);
            try {
                await fs.rename(source, target);
            } catch (error) {
                if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') continue;
                throw error;
            }
            const raw = JSON.parse(await fs.readFile(path.join(target, 'metadata.json'), 'utf8'));
            const migrated = {
                schema: 'roboteam-robot-v1',
                id: entry.name,
                name: String(raw.name || 'Robot'),
                specialization: String(raw.specialization || ''),
                ownerUserId: normalizeOwnerUserId(raw.ownerUserId),
                createdAt: String(raw.createdAt || new Date().toISOString()),
                updatedAt: new Date().toISOString(),
            };
            await this._ensureLayout(target);
            await this._writeMetadata(target, migrated);
        }
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

    async list(ownerUserId) {
        const owner = normalizeOwnerUserId(ownerUserId);
        return (await this._allRobots()).filter((robot) => robot.ownerUserId === owner);
    }

    async getOwned(robotId, ownerUserId) {
        const owner = normalizeOwnerUserId(ownerUserId);
        let robot;
        try {
            robot = await this._readMetadata(robotId);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        return robot.ownerUserId === owner ? robot : null;
    }

    async create({ ownerUserId, name, specialization = '' }) {
        const owner = normalizeOwnerUserId(ownerUserId);
        const normalizedName = normalizeName(name);
        const normalizedSpecialization = normalizeSpecialization(specialization);
        await this.initialize();
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
            ownerUserId: owner,
            createdAt: now,
            updatedAt: now,
        };
        await this._writeMetadata(robotRoot, metadata);
        return metadata;
    }
}

export const robotStoreInternals = { normalizeOwnerUserId, slugify, ROBOT_ID_PATTERN };
