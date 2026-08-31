import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const FIRST_PROFILE_UID = 22000;
const LAST_PROFILE_UID = 41999;

function normalizeOwnerUserId(value) {
    const owner = String(value || '').trim();
    if (!owner || owner.length > 256 || /[\0\r\n]/.test(owner)) {
        throw new Error('authenticated user identity is required');
    }
    return owner;
}

function normalizeName(value) {
    const name = String(value || '').trim();
    if (!name) throw new Error('profile name is required');
    if (name.length > 80) throw new Error('profile name must be at most 80 characters');
    return name;
}

function normalizeSpecialization(value) {
    const specialization = String(value || '').trim();
    if (specialization.length > 500) {
        throw new Error('specialization must be at most 500 characters');
    }
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

async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProfileStore {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || '/data');
        this.profilesDir = path.join(this.dataDir, 'profiles');
        this.applyOwnership = options.applyOwnership ?? (typeof process.getuid === 'function' && process.getuid() === 0);
    }

    async initialize() {
        await fs.mkdir(this.profilesDir, { recursive: true, mode: 0o711 });
        await fs.chmod(this.profilesDir, 0o711);
    }

    profilePath(profileId) {
        if (!PROFILE_ID_PATTERN.test(String(profileId || ''))) {
            throw new Error('invalid profile id');
        }
        const resolved = path.resolve(this.profilesDir, profileId);
        if (path.dirname(resolved) !== this.profilesDir) {
            throw new Error('invalid profile path');
        }
        return resolved;
    }

    async _withCreateLock(operation) {
        const lockPath = path.join(this.dataDir, '.profile-create.lock');
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                await fs.mkdir(lockPath, { mode: 0o700 });
                try {
                    return await operation();
                } finally {
                    await fs.rmdir(lockPath).catch(() => {});
                }
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                await delay(20);
            }
        }
        throw new Error('profile store is busy');
    }

    async _readMetadata(profileId) {
        const metadataPath = path.join(this.profilePath(profileId), 'metadata.json');
        const raw = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(raw);
        if (metadata?.schema !== 'roboteam-profile-v1' || metadata.id !== profileId) {
            throw new Error(`profile metadata is invalid for ${profileId}`);
        }
        return metadata;
    }

    async _allProfiles() {
        await this.initialize();
        const entries = await fs.readdir(this.profilesDir, { withFileTypes: true });
        const profiles = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !PROFILE_ID_PATTERN.test(entry.name)) continue;
            try {
                profiles.push(await this._readMetadata(entry.name));
            } catch {
                // A corrupt profile is excluded rather than exposed as another user's data.
            }
        }
        return profiles.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }

    async list(ownerUserId) {
        const owner = normalizeOwnerUserId(ownerUserId);
        return (await this._allProfiles()).filter((profile) => profile.ownerUserId === owner);
    }

    async getOwned(profileId, ownerUserId) {
        const owner = normalizeOwnerUserId(ownerUserId);
        let profile;
        try {
            profile = await this._readMetadata(profileId);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        return profile.ownerUserId === owner ? profile : null;
    }

    async create({ ownerUserId, name, specialization = '' }) {
        const owner = normalizeOwnerUserId(ownerUserId);
        const normalizedName = normalizeName(name);
        const normalizedSpecialization = normalizeSpecialization(specialization);
        return this._withCreateLock(async () => {
            const existing = await this._allProfiles();
            const usedUids = new Set(existing.map((profile) => Number(profile.uid)));
            let uid = FIRST_PROFILE_UID;
            while (uid <= LAST_PROFILE_UID && usedUids.has(uid)) uid += 1;
            if (uid > LAST_PROFILE_UID) throw new Error('profile uid capacity exhausted');

            let profileId;
            let profileRoot;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                profileId = `${slugify(normalizedName)}-${crypto.randomBytes(3).toString('hex')}`;
                profileRoot = this.profilePath(profileId);
                try {
                    await fs.mkdir(profileRoot, { mode: 0o700 });
                    break;
                } catch (error) {
                    if (error?.code !== 'EEXIST') throw error;
                    profileRoot = null;
                }
            }
            if (!profileRoot) throw new Error('could not allocate profile id');

            const directories = ['home', 'workspace', 'browser', 'downloads', 'logs', 'runtime'];
            for (const directory of directories) {
                await fs.mkdir(path.join(profileRoot, directory), { mode: 0o700 });
            }

            const now = new Date().toISOString();
            const metadata = {
                schema: 'roboteam-profile-v1',
                id: profileId,
                name: normalizedName,
                specialization: normalizedSpecialization,
                ownerUserId: owner,
                uid,
                systemUser: `rt${uid}`,
                createdAt: now,
                updatedAt: now,
            };
            const tempPath = path.join(profileRoot, `.metadata-${process.pid}-${crypto.randomUUID()}.tmp`);
            const metadataPath = path.join(profileRoot, 'metadata.json');
            await fs.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
            await fs.rename(tempPath, metadataPath);

            if (this.applyOwnership) {
                await fs.chown(profileRoot, uid, uid);
                for (const directory of directories) {
                    await fs.chown(path.join(profileRoot, directory), uid, uid);
                }
                await fs.chown(metadataPath, uid, uid);
            }
            return metadata;
        });
    }
}

export const profileStoreInternals = {
    normalizeOwnerUserId,
    slugify,
    PROFILE_ID_PATTERN,
};
