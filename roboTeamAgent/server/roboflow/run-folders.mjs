import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// A Cron job's folder below its selected parent: the workflow id and the start of the job id, e.g. daily-report-3f2a9c1b.
// The workflow id is the slug of its name when created and stays the same when the workflow is renamed.
export const jobFolderName = (workflowId, jobId) => `${workflowId}-${String(jobId).replace(/^cron_/, '').slice(0, 8)}`;

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
    // A run started without a folder gets its own timestamped folder under the default parent.
    async create(folder) {
        const base = await this.base(folder);
        const timestamp = new Date(this.now()).toISOString().replace('T', '_').replace(/[:.]/g, '-');
        const name = `run-${timestamp}`;
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
    // Every run of a Cron job works in the same job folder, so a run finds what earlier runs left there, whether they
    // succeeded or failed. Each job has its own folder, and a job never runs twice at once, so runs do not overlap in it.
    // Run logs and results stay apart under .roboteam/roboflow/<run id>/, and run metadata lives in the database.
    async forJob(folder, workflowId, jobId) {
        const destination = path.join(await this.base(folder), jobFolderName(workflowId, jobId));
        await fs.mkdir(destination, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('The Cron job folder is not a plain directory'), { statusCode: 400 });
        return destination;
    }
    async discard(folder) {
        // Only an empty directory may be removed after a rejected launch; a job folder with earlier work stays.
        await fs.rmdir(folder).catch(error => {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) console.error('[roboflow] Empty run folder cleanup failed:', error.message);
        });
    }
}
