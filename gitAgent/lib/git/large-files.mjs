import { runGit } from './run-git.mjs';

export const LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;

async function pushSources(repoPath, gitBinary, { remote, branch, setUpstream }) {
    const git = async (...args) => (await runGit(repoPath, [gitBinary, ...args])).stdout.trim();
    const config = async (key) => {
        const { stdout } = await runGit(repoPath, [gitBinary, 'config', '--get-all', key], { okCodes: [0, 1] });
        return stdout.trim();
    };
    let remoteName = remote || await config('remote.pushDefault');
    let upstream = '';
    try { upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); } catch {}
    if (!remoteName) {
        remoteName = upstream.includes('/') ? upstream.split('/')[0] : 'origin';
    }
    const explicitBranch = branch || ((setUpstream || !upstream) ? 'HEAD' : null);
    const { stdout: mirror } = await runGit(repoPath, [gitBinary, 'config', '--bool', '--get', `remote.${remoteName}.mirror`], { okCodes: [0, 1] });
    if (mirror.trim() === 'true') {
        const refs = await git('for-each-ref', '--format=%(objectname)', 'refs');
        return { sources: [...new Set(refs.split('\n').filter(Boolean))], remoteName };
    }
    const refspecs = explicitBranch ? [explicitBranch] : (await config(`remote.${remoteName}.push`)).split('\n').filter(Boolean);
    if (!refspecs.length) {
        // Without an upstream, gitPush explicitly sends the current branch.
        const matching = upstream && await config('push.default') === 'matching';
        refspecs.push(matching ? ':' : 'HEAD');
    }
    const sources = [];
    for (const refspec of refspecs) {
        const source = refspec.replace(/^\+/, '').split(':')[0];
        if (!source && refspec !== ':' && refspec !== '+:') continue; // Deletion.
        if (!source || source.includes('*')) {
            const refs = await git('for-each-ref', '--format=%(objectname)', source || 'refs/heads');
            sources.push(...refs.split('\n').filter(Boolean));
        } else {
            sources.push(await git('rev-parse', '--verify', '--end-of-options', `${source}^{object}`));
        }
    }
    return { sources: [...new Set(sources)], remoteName };
}

export async function inspectLargeFiles(repoPath, gitBinary, options = {}) {
    const operation = options.operation;
    if (!['commit', 'push'].includes(operation)) throw new Error('operation must be commit or push.');
    if (options.approvedLargeFileOids !== undefined && (!Array.isArray(options.approvedLargeFileOids)
        || options.approvedLargeFileOids.some((oid) => typeof oid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))) {
        throw new Error('approvedLargeFileOids must be an array of Git blob IDs from the warning.');
    }
    const objects = new Map();
    if (operation === 'commit') {
        const { stdout } = await runGit(repoPath, [gitBinary, 'diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames']);
        const records = stdout.split('\0');
        for (let index = 0; index < records.length - 1; index += 2) {
            const fields = records[index].split(' ');
            const oid = fields[3];
            // A submodule gitlink refers to another repository's commit, not a blob.
            if (fields[1] !== '160000' && oid && !/^0+$/.test(oid)) objects.set(oid, records[index + 1]);
        }
    } else {
        const { sources, remoteName } = await pushSources(repoPath, gitBinary, options);
        if (sources.length) {
            // Local remote-tracking refs avoid a second network round-trip. Stale refs
            // can over-warn; never suppress unknown objects using unrelated remotes.
            const { stdout } = await runGit(repoPath, [gitBinary, 'rev-list', '--objects', ...sources, '--not', `--remotes=${remoteName}`], { timeoutMs: 60000 });
            let lastOid = null;
            for (const line of stdout.split('\n')) {
                const match = line.match(/^([a-f0-9]{40,64})(?: (.*))?$/);
                if (match) {
                    lastOid = match[1];
                    objects.set(lastOid, match[2] || '');
                } else if (lastOid && line) {
                    objects.set(lastOid, `${objects.get(lastOid)}\n${line}`);
                }
            }
        }
    }
    let files = [];
    if (objects.size) {
        const { stdout } = await runGit(repoPath, [gitBinary, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
            timeoutMs: 60000,
            input: [...objects.keys()].join('\n') + '\n'
        });
        files = stdout.trim().split('\n').flatMap((line) => {
            const [oid, type, size] = line.split(' ');
            const sizeBytes = Number(size);
            if (!['blob', 'tree', 'commit', 'tag'].includes(type) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
                throw new Error(`Could not inspect Git object ${oid}; commit/push stopped.`);
            }
            return type === 'blob' && sizeBytes >= LARGE_FILE_WARNING_BYTES
                ? [{ oid, path: objects.get(oid) || oid, sizeBytes }] : [];
        }).sort((left, right) => right.sizeBytes - left.sizeBytes);
    }
    const approved = new Set(Array.isArray(options.approvedLargeFileOids) ? options.approvedLargeFileOids : []);
    const unapproved = files.filter((file) => !approved.has(file.oid));
    return {
        ok: unapproved.length === 0,
        ...(unapproved.length ? {
            code: 'large_files_warning',
            error: `Files of 50 MiB or more require permission before ${operation}. Ask the user to continue or abort; only after approval retry with approvedLargeFileOids from this warning.`
        } : {}),
        operation,
        thresholdBytes: LARGE_FILE_WARNING_BYTES,
        files: unapproved
    };
}
