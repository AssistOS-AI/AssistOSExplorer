import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceManifest } from './qaCopyManifest.mjs';

const fixed = {
    PromotionScoutV2: ['AssistOS-AI/PromotionScoutV2', '.qa-promotionscout-source'],
    ScriptaHubAgent: ['Axiologic/ScriptaHubAgent', '.qa-scriptahub-source'],
    AchillesIDE: ['AssistOS-AI/AssistOSExplorer'],
    ploinky: ['AssistOS-AI/ploinky'],
    bizanso: ['Axiologic/bizanso', '.qa-bizanso-source'],
    simpleCSVMailSend: ['Axiologic/simpleCSVMailSend', '.qa-csvmail-source'],
};
const copies = {
    bizanso: ['.qa-bizanso-source', null],
    simpleCSVMailSend: ['.qa-csvmail-source', 'csvMailAgent'],
};
const oid = value => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

// Do not inherit Git config, URL rewrites, credential helpers, or Git directory variables.
function run(command, args, { input, binary = false } = {}) {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    const result = spawnSync(command, args, { env, input, maxBuffer: 256 * 1024 * 1024, timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error('Trusted source operation failed');
    return binary ? result.stdout : result.stdout.toString('utf8').trim();
}
const git = (...args) => run('git', args);
function validateBranch(branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Invalid branch');
    git('check-ref-format', `refs/heads/${branch}`);
    return branch;
}
function githubOrigin(origin) {
    if (typeof origin !== 'string') throw new Error('Invalid origin');
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
    if (!match || [match[1], match[2]].some(part => part === '.' || part === '..')) throw new Error('Invalid origin');
    return `${match[1]}/${match[2]}`;
}
function history(repo, ref) {
    if (git('-C', repo, 'rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Incomplete history');
    const lines = git('-C', repo, 'rev-list', ref).split('\n');
    if (!lines.length || lines.some(id => !oid(id))) throw new Error('Invalid history');
    return new Set(lines);
}
function checkoutIdentity(repo) {
    const branch = validateBranch(git('-C', repo, 'symbolic-ref', '--short', 'HEAD'));
    const head = git('-C', repo, 'rev-parse', '--verify', 'HEAD^{commit}');
    if (!oid(head)) throw new Error('Invalid checkout');
    return { branch, head };
}
export function createPublication({ runnerWorkspace, scratch, resetExplorer = false }) {
    return async repo => {
        const name = githubOrigin(repo.origin);
        const key = repo.name.startsWith('.ploinky/repos/') ? repo.name.slice('.ploinky/repos/'.length) : repo.name;
        const expected = Object.hasOwn(fixed, key) ? fixed[key] : undefined;
        if (expected && name.toLowerCase() !== expected[0].toLowerCase()) throw new Error('Unexpected origin');
        if (expected?.[1]) {
            const checkout = path.join(runnerWorkspace, expected[1]);
            const { branch, head } = checkoutIdentity(checkout);
            if (repo.branch !== branch || (repo.deploymentBranch && repo.deploymentBranch !== branch)) throw new Error('Unexpected branch');
            return { branch, commits: history(checkout, head) };
        }
        const url = `https://github.com/${expected?.[0] || name}.git`;
        let branch = repo.deploymentBranch || repo.branch;
        if (key === 'AchillesIDE' && resetExplorer) branch = 'main';
        if (key === 'ploinky') {
            const result = git('ls-remote', '--symref', url, 'HEAD');
            const match = /^ref: refs\/heads\/([^\n\t]+)\tHEAD$/m.exec(result);
            if (!match) throw new Error('Missing default branch');
            branch = match[1];
        }
        branch = validateBranch(branch);
        const dir = fs.mkdtempSync(path.join(scratch, 'qa-publication-'));
        try {
            git('init', '--bare', dir);
            git('-C', dir, '-c', 'protocol.version=2', 'fetch', '--no-tags', '--filter=blob:none', url,
                `+refs/heads/${branch}:refs/heads/publication`);
            return { branch, commits: history(dir, 'refs/heads/publication') };
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
}
function selected(scope) {
    if (scope === 'full') return Object.keys(copies);
    if (scope === 'bizanso') return ['bizanso'];
    if (scope === 'csvmail') return ['simpleCSVMailSend'];
    if (scope === 'scriptahub') return [];
    throw new Error('Invalid scope');
}
function manifests({ scope, runnerWorkspace, scratch, previousCommits }) {
    const result = {};
    for (const name of selected(scope)) {
        if (previousCommits && !previousCommits[name]) continue;
        const [source, subtree] = copies[name];
        const repo = path.join(runnerWorkspace, source);
        const head = git('-C', repo, 'rev-parse', '--verify', 'HEAD^{commit}');
        if (!oid(head)) throw new Error('Invalid checkout');
        let commit = head;
        if (previousCommits) {
            commit = previousCommits[name];
            if (!/^[0-9a-f]{40}$/.test(commit) || !history(repo, head).has(commit)) throw new Error('Invalid previous commit');
        }
        const archive = run('git', ['-C', repo, 'archive', '--format=tar', commit, ...(subtree ? [subtree] : [])], { binary: true });
        const dir = fs.mkdtempSync(path.join(scratch, 'qa-copy-'));
        try {
            run('tar', ['-xf', '-', '-C', dir], { input: archive });
            result[name] = sourceManifest(subtree ? path.join(dir, subtree) : dir);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    return result;
}
export function incomingCopies(options) { return manifests(options); }
// The caller must obtain these full commit IDs from a trusted deployment record.
export function previousCopies(options) {
    if (!options.previousCommits || typeof options.previousCommits !== 'object' || Array.isArray(options.previousCommits)) throw new Error('Invalid previous commits');
    return manifests(options);
}
