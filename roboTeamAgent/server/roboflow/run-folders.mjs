import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class RunFolders {
    constructor({ folders, resolveCwd, now = Date.now }) {
        Object.assign(this, { folders, resolveCwd, now });
    }
    isLegacyDefault(folder, root) {
        return Boolean(folder) && path.resolve(folder) === path.join(root, 'cron-jobs-results');
    }
    async base(folder) {
        const root = await this.folders.root();
        if (!folder || path.resolve(folder) === path.join(root, 'workflow-runs') || this.isLegacyDefault(folder, root)) return this.folders.defaultFolder();
        return this.resolveCwd(folder);
    }
    async create(folder, cron = false) {
        const base = await this.base(folder);
        const timestamp = new Date(this.now()).toISOString().replace('T', '_').replace(/[:.]/g, '-');
        const name = `${cron ? 'cron' : 'run'}-${timestamp}`;
        for (let attempt = 0; attempt < 10; attempt++) {
            const destination = path.join(base, attempt ? `${name}-${crypto.randomBytes(4).toString('hex')}` : name);
            try {
                await fs.mkdir(destination, { mode: 0o700 });
            } catch (error) {
                if (error.code === 'EEXIST') continue;
                throw error;
            }
            return destination;
        }
        throw new Error('Could not allocate a unique workflow run folder');
    }
    async discard(folder) {
        // Only a newly allocated, empty directory may be removed after a rejected launch.
        await fs.rmdir(folder).catch(error => {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) console.error('[roboflow] Empty run folder cleanup failed:', error.message);
        });
    }
}
