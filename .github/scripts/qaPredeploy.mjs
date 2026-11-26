import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessSources, formatSummary } from './qaSourceReport.mjs';
import { validateManifest, diffManifests } from './qaCopyManifest.mjs';
import { createPublication, incomingCopies, previousCopies } from './qaPublication.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const scopes = { full: ['bizanso', 'simpleCSVMailSend'], bizanso: ['bizanso'], scriptahub: [] };
const copyScope = name => name === 'bizanso' ? 'bizanso' : 'csvmail';
const quote = word => "'" + word.replaceAll("'", "'\\''") + "'";
const failure = (name, reason) => ({ name, reason, files: [], commits: [] });

function hostRequest(action, scope, input) {
    // This executable is runner-only. Pin the identity independently of the
    // workflow environment and use the host key verified by its earlier step.
    const program = fs.readFileSync(path.join(scripts, 'qaPreflightHost.sh'), 'utf8');
    const command = "exec flock -n -E 75 --close /home/admin/.qa-deployment-operation.lock bash -c "
        + [program, 'qa-source-check', action, scope].map(quote).join(' ');
    const ssh = spawnSync('ssh', ['-i', path.join(os.homedir(), '.ssh/deploy_key'),
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'UserKnownHostsFile=' + path.join(os.homedir(), '.ssh/explorer_qa_known_hosts'),
        'admin@45.136.70.141', command], { input, maxBuffer: 128 * 1024 * 1024, timeout: 300_000 });
    if (ssh.error || ssh.status !== 0) {
        if (ssh.status === 75) throw new Error('Another QA operation holds the deployment lock.');
        if (ssh.stderr?.includes('reader image is unavailable')) throw new Error('The QA source reader image is unavailable.');
        throw new Error('Could not inspect the QA sources or maintain the installed-source receipt.');
    }
    return ssh.stdout;
}

function readerBundle() {
    const pkg = spawnSync('tar', ['-C', scripts, '-cf', '-', 'qaSourceInventory.mjs', 'qaCopyManifest.mjs']);
    if (pkg.error || pkg.status !== 0) throw new Error('Could not package the QA source reader.');
    return pkg.stdout;
}

export function inspectRemote(scope, request = hostRequest) {
    const response = JSON.parse(request('inspect', scope, readerBundle()));
    if (!response.inventory || !Array.isArray(response.inventory.errors) || !response.receipts
        || Array.isArray(response.receipts) || typeof response.receipts !== 'object') throw new Error('Invalid QA reader response.');
    const receipts = Object.create(null);
    for (const [name, encoded] of Object.entries(response.receipts)) {
        if (encoded === null) continue;
        try {
            const record = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
            if (record.version !== 1 || record.name !== name || !record.pending && !record.installed) throw new Error();
            receipts[name] = {};
            for (const key of ['installed', 'pending']) {
                if (record[key] !== undefined) receipts[name][key] = validateManifest(record[key]);
            }
        } catch {
            response.inventory.errors.push({ name, reason: 'Installed-source receipt is unreadable or invalid.' });
        }
    }
    return { inventory: response.inventory, receipts };
}

function writeReport(result, env) {
    const summary = formatSummary(result);
    const report = path.join(env.RUNNER_TEMP, 'qa-unpublished-report.md');
    fs.writeFileSync(report, summary, { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(env.GITHUB_STEP_SUMMARY, Buffer.byteLength(summary) < 1000000 ? summary
            : '## QA source check stopped deployment\n\nThe complete repository and path listing exceeds the summary size limit. Download the **qa-unpublished-report** artifact from this run.\n');
    }
}

function stateFile(env) {
    return path.join(env.RUNNER_TEMP, 'qa-copy-preflight-state.json');
}

export async function check(scope, env, inspect = inspectRemote) {
    const scratch = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'qa-publication-'));
    let result;
    try {
        const { inventory, receipts } = inspect(scope);
        const options = { scope, runnerWorkspace: env.GITHUB_WORKSPACE, scratch };
        const previousCommits = {};
        for (const [name, variable] of [['bizanso', 'EXPLORER_QA_LAST_BIZANSO_COMMIT'], ['simpleCSVMailSend', 'EXPLORER_QA_LAST_CSVMAIL_COMMIT']]) {
            if (scopes[scope].includes(name) && env[variable] && !receipts[name]) previousCommits[name] = env[variable];
        }
        const incoming = {};
        // Collect independent archive failures as well as every other source.
        for (const name of scopes[scope]) {
            try {
                Object.assign(incoming, await incomingCopies({ ...options, scope: copyScope(name) }));
                if (previousCommits[name]) {
                    const previous = await previousCopies({ ...options, previousCommits: { [name]: previousCommits[name] } });
                    receipts[name] = { installed: validateManifest(previous[name]) };
                }
            } catch {
                inventory.errors.push({ name, reason: 'Cannot verify the selected published archive or its previous deployed commit.' });
            }
        }
        const publication = createPublication({ ...options, resetExplorer: env.RESET_EXPLORER_CHECKOUT === 'true' });
        result = await assessSources(inventory, { publication, receipts, incoming });
        if (!result.blockers.length) {
            const installed = {};
            for (const copy of inventory.copies) if (copy.manifest !== null) installed[copy.name] = copy.manifest;
            fs.writeFileSync(stateFile(env), JSON.stringify({ installed, incoming }), { mode: 0o600 });
        }
    } catch (error) {
        const safeReasons = ['Another QA operation holds the deployment lock.', 'The QA source reader image is unavailable.',
            'Could not inspect the QA sources or maintain the installed-source receipt.'];
        result = { blockers: [failure('QA inventory', safeReasons.includes(error.message) ? error.message : 'Cannot verify the deployment source inventory.')] };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    writeReport(result, env);
    return result;
}

export function copyChanged(name, env) {
    const { incoming, installed } = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    const target = validateManifest(incoming[name]);
    return !Object.hasOwn(installed, name) || diffManifests(installed[name], target).length > 0;
}

export function recordCopy(action, name, env, inspect = inspectRemote, request = hostRequest) {
    if (!['prepare', 'installed'].includes(action) || !['bizanso', 'simpleCSVMailSend'].includes(name)) throw new Error('Invalid copy operation.');
    const { incoming, installed } = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    const target = validateManifest(incoming[name]);
    const scope = copyScope(name);
    const snapshot = inspect(scope).inventory;
    const observation = snapshot.copies.filter(copy => copy.name === name);
    if (snapshot.errors.length || observation.length !== 1) throw new Error('Could not verify the copied source.');
    const actual = observation[0].manifest;
    const expected = action === 'prepare' ? (installed[name] ?? null) : target;
    if (expected === null ? actual !== null : actual === null || diffManifests(expected, actual).length) {
        throw new Error(action === 'prepare' ? 'Source files changed after the QA pre-deploy check.' : 'Installed source differs from the verified published archive.');
    }
    // Both receipts describe trusted archive content or an exact, verified
    // prior installation. A killed placement can be reconciled on re-dispatch.
    const receipt = { version: 1, name };
    if (action === 'prepare') {
        if (expected !== null) receipt.installed = expected;
        receipt.pending = target;
    } else receipt.installed = target;
    request('receipt', scope, JSON.stringify(receipt));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [action, arg] = process.argv.slice(2);
    try {
        if (action === 'check' && Object.hasOwn(scopes, arg)) {
            const result = await check(arg, process.env);
            if (result.blockers.length) {
                console.error('QA source check stopped deployment. See the workflow summary.');
                process.exitCode = 1;
            }
        } else if (action === 'changed' && arg === 'bizanso') {
            console.log(copyChanged(arg, process.env) ? 'yes' : 'no');
        } else recordCopy(action, arg, process.env);
    } catch (error) {
        console.error('QA source check failed:', error.message);
        process.exitCode = 1;
    }
}
