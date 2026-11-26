import { diffManifests, validateManifest } from './qaCopyManifest.mjs';

const copyNames = new Set(['bizanso', 'simpleCSVMailSend']);
const inventoryReasons = new Set([
    'Ambiguous or missing checkout origin', 'Unsafe source path', 'Unsupported repository configuration', 'Unsupported index flags',
    'Installed-source receipt is unreadable or invalid.', 'Cannot verify the selected published archive or its previous deployed commit.',
    'Cannot inspect checkout', 'Unsupported filename or metadata encoding', 'Credentials in origin',
    'Unsafe source directory', 'Unsupported checkout layout', 'Unknown origin', 'Origin does not match registration',
    'Detached HEAD', 'Checkout is on a different deployment branch', 'Unsupported submodule', 'Invalid status',
    'Invalid rename status', 'History exceeds inventory limit', 'Invalid commit', 'Cannot inspect source copy',
    'Cannot inspect repository registrations', 'Cannot enumerate workspace sources', 'Cannot enumerate managed sources',
    'Ambiguous registration', 'Cannot inspect workspace source',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const validFiles = value => Array.isArray(value) && value.every(file => keysOnly(file, ['status', 'path'])
    && text(file.status) && text(file.path));
const validCommits = value => Array.isArray(value) && value.every(commit => keysOnly(commit, ['id', 'subject'])
    && typeof commit.id === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit.id)
    && typeof commit.subject === 'string');
const empty = name => ({ name, files: [], commits: [] });

// All failures are deliberately generic: provider exceptions can contain credentials.
export async function assessSources(inventory, options = {}) {
    const blockers = [];
    if (!object(options)) return { blockers: [{ ...empty('inventory'), reason: 'Invalid assessment input' }] };
    const { publication, receipts, incoming } = options;
    if (!keysOnly(inventory, ['repos', 'copies', 'errors']) || !Array.isArray(inventory.repos)
        || !Array.isArray(inventory.copies) || !Array.isArray(inventory.errors)
        || typeof publication !== 'function' || !object(receipts) || !object(incoming)) {
        return { blockers: [{ ...empty('inventory'), reason: 'Invalid assessment input' }] };
    }
    const names = new Set();
    for (const repo of inventory.repos) {
        if (!keysOnly(repo, ['name', 'origin', 'branch', 'deploymentBranch', 'files', 'commits', 'error'])
            || !text(repo.name) || names.has(repo.name) || !text(repo.origin) || !text(repo.branch)
            || !(repo.deploymentBranch === undefined || repo.deploymentBranch === null || text(repo.deploymentBranch))
            || !validFiles(repo.files) || !validCommits(repo.commits)
            || !(repo.error === undefined || text(repo.error))) {
            blockers.push({ ...empty('inventory'), reason: 'Invalid repository inventory' });
            continue;
        }
        names.add(repo.name);
        const blocker = { ...empty(repo.name), files: repo.files.map(file => ({ ...file })) };
        let published;
        try {
            published = await publication(repo);
            if (!keysOnly(published, ['branch', 'commits']) || !text(published.branch)
                || !(published.commits instanceof Set)
                || [...published.commits].some(id => typeof id !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id))
                || (repo.deploymentBranch && published.branch !== repo.deploymentBranch)) throw new Error('Invalid publication');
            blocker.branch = published.branch;
            blocker.commits = repo.commits.filter(commit => !published.commits.has(commit.id)).map(commit => ({ ...commit }));
        } catch {
            blocker.reason = 'Publication reference unavailable or invalid';
        }
        if (repo.error) blocker.reason = inventoryReasons.has(repo.error) ? repo.error : 'Repository inventory unavailable or incomplete';
        if (blocker.files.length || blocker.commits.length || blocker.reason) blockers.push(blocker);
    }
    const copies = new Set();
    for (const copy of inventory.copies) {
        if (!keysOnly(copy, ['name', 'manifest']) || !copyNames.has(copy.name) || copies.has(copy.name)) {
            blockers.push({ ...empty('inventory'), reason: 'Invalid copied-source inventory' });
            continue;
        }
        copies.add(copy.name);
        try {
            const current = copy.manifest === null ? null : validateManifest(copy.manifest);
            const target = validateManifest(incoming[copy.name]);
            const receipt = receipts[copy.name];
            let baseline = target;
            if (receipt !== undefined) {
                if (!keysOnly(receipt, ['installed', 'pending']) || (!('installed' in receipt) && !('pending' in receipt))) throw new Error('Invalid receipt');
                const installed = 'installed' in receipt ? validateManifest(receipt.installed) : null;
                const pending = 'pending' in receipt ? validateManifest(receipt.pending) : null;
                // A pending first installation has no predecessor. It may have
                // stopped before placing any files.
                if (current === null && installed === null && pending !== null) continue;
                if (current !== null && pending && diffManifests(pending, current).length === 0) continue;
                baseline = installed ?? pending;
            }
            if (current === null && receipt === undefined) continue;
            const files = diffManifests(baseline, current ?? []);
            if (receipt === undefined && files.length) {
                blockers.push({ ...empty(copy.name), reason: 'Installed baseline unavailable or unverifiable; reconcile against a trusted deployed archive before retrying' });
                continue;
            }
            if (files.length || current === null) blockers.push({ ...empty(copy.name), files, reason: 'Copied source differs from trusted baseline' });
        } catch {
            blockers.push({ ...empty(copy.name), reason: 'Copied-source evidence unavailable or invalid' });
        }
    }
    for (const name of new Set([...Object.keys(receipts), ...Object.keys(incoming)])) {
        if (!copyNames.has(name) || !copies.has(name)) blockers.push({ ...empty('inventory'), reason: 'Unexpected copied-source evidence' });
    }
    for (const error of inventory.errors) {
        if (!keysOnly(error, ['name', 'reason']) || !text(error.name) || !text(error.reason)) {
            blockers.push({ ...empty('inventory'), reason: 'Invalid inventory error' });
        } else {
            blockers.push({ ...empty(error.name), reason: inventoryReasons.has(error.reason) ? error.reason : 'Source inventory unavailable or incomplete' });
        }
    }
    return { blockers };
}

// Encode markup, workflow-command delimiters and controls while keeping ordinary
// text readable even when the summary is viewed as raw output.
function safe(value) {
    return Array.from(String(value), char => /[\\`*_{}\[\]()#+.\-!|>~<&:]/.test(char)
        || char.codePointAt(0) < 32 || char.codePointAt(0) === 127 ? `&#${char.codePointAt(0)};` : char).join('');
}

export function formatSummary(result) {
    if (!object(result) || !Array.isArray(result.blockers)) throw new Error('Invalid assessment result');
    const lines = ['## Unpublished source preflight'];
    if (!result.blockers.length) lines.push('', 'No unpublished source changes found.');
    for (const blocker of result.blockers) {
        if (!object(blocker) || !text(blocker.name) || !validFiles(blocker.files) || !validCommits(blocker.commits)
            || !(blocker.reason === undefined || text(blocker.reason)) || !(blocker.branch === undefined || text(blocker.branch))) {
            throw new Error('Invalid assessment result');
        }
        lines.push('', `### ${safe(blocker.name)}`);
        if (blocker.reason) lines.push(`Reason: ${safe(blocker.reason)}`);
        if (blocker.branch) lines.push(`Publication branch: ${safe(blocker.branch)}`);
        for (const file of blocker.files) lines.push(`File: ${safe(file.status)} ${safe(file.path)}`);
        for (const commit of blocker.commits) lines.push(`Commit: ${safe(commit.id)} ${safe(commit.subject)}`);
    }
    return `${lines.join('\n')}\n`;
}
