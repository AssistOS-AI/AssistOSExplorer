#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceManifest } from './qaCopyManifest.mjs';

const LIMIT = 16 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat' };

function run(directory, args, allowed = [0]) {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.untrackedCache=false', '-c', 'core.excludesFile=/dev/null', '-c', 'safe.directory=*', '-C', directory, ...args],
    { env, encoding: 'buffer', maxBuffer: LIMIT, timeout: 30000 });
    if (result.error || !allowed.includes(result.status)) throw new Error('Cannot inspect checkout');
    return result.stdout;
}

function text(buffer) {
    const value = buffer.toString('utf8');
    if (!Buffer.from(value).equals(buffer)) throw new Error('Unsupported filename or metadata encoding');
    return value;
}
function line(directory, args) { return text(run(directory, args)).trim(); }
function identity(value) {
    const raw = value.trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'ssh://git@$1/');
    try {
        const url = new URL(raw);
        if (url.password || url.search || url.hash || (url.username && url.username !== 'git')) throw new Error('Credentials in origin');
        const name = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
        return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.hostname.toLowerCase() === 'github.com' ? name.toLowerCase() : name}`;
    } catch (error) {
        if (error.message === 'Credentials in origin') throw error;
        return raw.replace(/\/+$/, '').replace(/\.git$/, '');
    }
}
function exists(value) { try { fs.lstatSync(value); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; } }
function noLinks(value) {
    const absolute = path.resolve(value);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (!exists(current)) break;
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe source path');
    }
}
function directory(value) {
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe source directory');
}
function entries(value) {
    if (!exists(value)) return [];
    directory(value);
    const names = fs.readdirSync(value);
    if (names.length > 10000) throw new Error('Too many sources');
    return names.sort();
}
function readConfig(file) {
    noLinks(file);
    if (!fs.lstatSync(file).isFile()) throw new Error('Unsupported repository configuration');
    const config = run('/', ['config', '--file', file, '--no-includes', '--list', '-z']);
    return text(config).split('\0').filter(Boolean).map(entry => {
        const separator = entry.indexOf('\n');
        // Git normalizes section and variable names, but subsection names are case-sensitive.
        return [entry.slice(0, separator < 0 ? undefined : separator), separator < 0 ? '' : entry.slice(separator + 1)];
    });
}
function checkoutConfig(root) {
    noLinks(root);
    directory(root);
    const dot = path.join(root, '.git');
    directory(dot);
    if (['objects/info/alternates', 'commondir', 'shallow', 'info/grafts', 'info/sparse-checkout', 'refs/replace'].some(item => exists(path.join(dot, item)))) throw new Error('Unsupported checkout layout');
    const config = readConfig(path.join(dot, 'config'));
    for (const [key] of config) {
        if (!/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|eol|symlinks)|remote\.[^.]+\.(url|fetch|pushurl|push)|branch\.[^.]+\.(remote|merge|rebase)|user\.(name|email)|init\.defaultbranch|extensions\.worktreeconfig)$/.test(key)) throw new Error('Unsupported repository configuration');
    }
    const extensions = config.filter(([key]) => key === 'extensions.worktreeconfig');
    const worktree = path.join(dot, 'config.worktree');
    if (extensions.length || exists(worktree)) {
        if (extensions.length !== 1 || extensions[0][1] !== 'true' || !exists(worktree)) throw new Error('Unsupported repository configuration');
        const entries = readConfig(worktree);
        if (entries.length !== 1 || entries[0][0] !== 'core.excludesfile' || entries[0][1] !== path.join(dot, 'ploinky-skill-exports.exclude')) throw new Error('Unsupported repository configuration');
    }
    return config;
}
function checkoutOrigin(config) {
    const values = config.filter(([key]) => key === 'remote.origin.url').map(([, value]) => value);
    if (values.length !== 1 || !values[0] || /[\n\r]/.test(values[0])) throw new Error('Ambiguous or missing checkout origin');
    return values[0];
}
function inspectRepo(name, root, configured) {
    const config = checkoutConfig(root);
    if (line(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) throw new Error('Unsupported checkout layout');
    const flags = text(run(root, ['ls-files', '-v', '-z']));
    if (flags.split('\0').some(entry => entry && !entry.startsWith('H '))) throw new Error('Unsupported index flags');
    const origin = checkoutOrigin(config);
    if (!origin || /[\r\n]/.test(origin)) throw new Error('Unknown origin');
    identity(origin);
    if (configured?.url && identity(configured.url) !== identity(origin)) throw new Error('Origin does not match registration');
    const branch = line(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) throw new Error('Detached HEAD');
    const deploymentBranch = configured?.branch && configured.branch !== 'default' ? configured.branch : branch;
    const index = text(run(root, ['ls-files', '--stage', '-z']));
    if (index.split('\0').some(entry => entry.startsWith('160000 '))) throw new Error('Unsupported submodule');
    const status = text(run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).split('\0');
    const files = [];
    for (let i = 0; i < status.length && status[i]; i++) {
        const item = status[i];
        if (item.length < 4 || item[2] !== ' ') throw new Error('Invalid status');
        files.push({ status: item.slice(0, 2), path: item.slice(3) });
        if (/[RC]/.test(item.slice(0, 2))) {
            if (!status[++i]) throw new Error('Invalid rename status');
            files.push({ status: 'D', path: status[i] });
        }
    }
    const history = text(run(root, ['log', '--no-show-signature', '--format=%H%x00%s', '-z', '--max-count=10001', 'HEAD'])).split('\0');
    if (history.at(-1) === '') history.pop();
    if (history.length % 2 || history.length > 20000) throw new Error('History exceeds inventory limit');
    const commits = [];
    for (let i = 0; i < history.length; i += 2) {
        if (!/^[0-9a-f]{40,64}$/.test(history[i])) throw new Error('Invalid commit');
        commits.push({ id: history[i], subject: history[i + 1] });
    }
    return { name, origin, branch, ...(deploymentBranch !== branch ? { deploymentBranch } : {}), files, commits };
}

const catalogs = {
    AchillesCopilotBasicSkills: '.ploinky/repos/AchillesCopilotBasicSkills',
    DocumentationSkills: 'DocumentationSkills',
    PloinkySkills: '.ploinky/repos/PloinkySkills',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

// Only a complete, byte-canonical defaults ledger can establish ownership.
function projection(root, catalogRoots) {
    const ledgerPath = path.join(root, '.agents/.ploinky-skill-exports.json');
    noLinks(ledgerPath);
    if (!fs.lstatSync(ledgerPath).isFile()) throw new Error('Invalid ledger');
    const fd = fs.openSync(ledgerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid ledger');
        bytes = Buffer.alloc(stat.size + 1);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (length !== stat.size) throw new Error('Invalid ledger');
        bytes = bytes.subarray(0, length);
    } finally { fs.closeSync(fd); }
    const ledger = JSON.parse(text(bytes));
    if (!bytes.equals(Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`)) ||
        !keys(ledger, ['version', 'entries', 'consumers', ...(Object.hasOwn(ledger, 'compatLinks') ? ['compatLinks'] : [])]) ||
        ledger.version !== 1 || !object(ledger.entries) || !object(ledger.consumers) ||
        !Object.keys(ledger.entries).length || Object.keys(ledger.entries).length > 10000 || !Object.keys(ledger.consumers).length) throw new Error('Invalid ledger');
    for (const [owner, consumer] of Object.entries(ledger.consumers)) {
        const name = owner.slice('defaults:'.length);
        if (owner !== `defaults:${name}` || !Object.hasOwn(catalogRoots, name) || !keys(consumer, ['selection', 'source']) || consumer.selection !== 'all' || consumer.source !== name) throw new Error('Invalid consumer');
    }
    const owned = new Set(['.agents/.ploinky-skill-exports.json']);
    for (const [name, entry] of Object.entries(ledger.entries)) {
        if (!NAME.test(name) || !keys(entry, ['owner', 'digest', 'kind', 'source']) || entry.kind !== 'symlink' ||
            !/^[0-9a-f]{64}$/.test(entry.digest) || !keys(entry.source, ['name'])) throw new Error('Invalid entry');
        const catalog = entry.source.name;
        if (typeof catalog !== 'string' || !Object.hasOwn(catalogRoots, catalog) || entry.owner !== `defaults:${catalog}` || !Object.hasOwn(ledger.consumers, entry.owner)) throw new Error('Invalid owner');
        const target = path.join(catalogRoots[catalog], 'skills', name);
        const sourceFile = path.join(target, 'SKILL.md');
        noLinks(sourceFile);
        if (!fs.lstatSync(sourceFile).isFile()) throw new Error('Invalid skill');
        const tree = text(run(catalogRoots[catalog], ['ls-tree', 'HEAD', '--', `skills/${name}/SKILL.md`]));
        if (!/^(100644|100755) blob [0-9a-f]{40,64}\t/.test(tree) || tree.trimEnd().split('\t')[1] !== `skills/${name}/SKILL.md`) throw new Error('Untracked skill');
        const link = path.join(root, '.agents/skills', name);
        noLinks(path.dirname(link));
        const info = fs.lstatSync(link);
        const relative = path.relative(path.dirname(link), target);
        if (!info.isSymbolicLink() || fs.readlinkSync(link) !== relative) throw new Error('Invalid link');
        const digest = crypto.createHash('sha256').update(JSON.stringify(['', 'symlink', info.mode & 0o777])).update(JSON.stringify(relative)).digest('hex');
        if (digest !== entry.digest) throw new Error('Invalid digest');
        owned.add(`.agents/skills/${name}`);
    }
    if (Object.hasOwn(ledger, 'compatLinks')) {
        if (!object(ledger.compatLinks)) throw new Error('Invalid compatibility links');
        const allowed = { '.claude': '.agents', '.claude/skills': '../.agents/skills' };
        for (const [link, record] of Object.entries(ledger.compatLinks)) {
            if (!Object.hasOwn(allowed, link) || !keys(record, ['target']) || record.target !== allowed[link]) throw new Error('Invalid compatibility link');
            const filename = path.join(root, link);
            noLinks(path.dirname(filename));
            if (!fs.lstatSync(filename).isSymbolicLink() || fs.readlinkSync(filename) !== record.target) throw new Error('Invalid compatibility link');
            owned.add(link);
        }
    }
    return owned;
}

export function inspectSources({ scope, workspace, tooling }) {
    if (!['full', 'bizanso', 'scriptahub', 'csvmail'].includes(scope)) throw new Error('Invalid scope');
    const result = { repos: [], copies: [], errors: [] };
    const roots = new Map();
    const error = (name, reason) => result.errors.push({ name, reason });
    const addCopy = (name, source) => {
        try {
            noLinks(source);
            if (exists(workspace)) directory(workspace);
            if (name === 'simpleCSVMailSend' && exists(path.join(workspace, name))) directory(path.join(workspace, name));
            if (!exists(source)) { result.copies.push({ name, manifest: null }); return; }
            directory(source);
            result.copies.push({ name, manifest: sourceManifest(source) });
        } catch { error(name, 'Cannot inspect source copy'); }
    };
    if (scope === 'full' || scope === 'bizanso') addCopy('bizanso', path.join(workspace, 'bizanso'));
    if (scope === 'full' || scope === 'csvmail') addCopy('simpleCSVMailSend', path.join(workspace, 'simpleCSVMailSend', 'csvMailAgent'));
    const addRepo = (name, source, config) => {
        try {
            const repo = inspectRepo(name, source, config);
            result.repos.push(repo);
            roots.set(repo, source);
            if (repo.deploymentBranch) error(name, 'Checkout is on a different deployment branch');
        }
        catch (failure) { error(name, failure.message); }
    };
    if (scope === 'scriptahub') {
        const source = path.join(workspace, 'ScriptaHubAgent');
        if (exists(source)) addRepo('ScriptaHubAgent', source, { url: 'https://github.com/Axiologic/ScriptaHubAgent.git' });
        return result;
    }
    if (scope !== 'full') return result;
    if (exists(tooling)) addRepo('ploinky', tooling);
    let sources = {};
    try { noLinks(workspace); } catch { error('workspace', 'Unsafe source path'); return result; }
    try {
        const metadata = path.join(workspace, '.ploinky');
        if (exists(metadata)) directory(metadata);
        const sourceFile = path.join(metadata, 'repo_sources.json');
        if (exists(sourceFile)) {
            if (!fs.lstatSync(sourceFile).isFile() || fs.lstatSync(sourceFile).isSymbolicLink()) throw new Error('Unsafe registry');
            const raw = fs.readFileSync(sourceFile, 'utf8');
            if (Buffer.byteLength(raw) > LIMIT) throw new Error('Registry too large');
            sources = JSON.parse(raw);
            if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('Invalid registry');
            for (const [name, value] of Object.entries(sources)) {
                if (!NAME.test(name)) throw new Error('Invalid registered name');
                const normalized = typeof value === 'string' ? { url: value } : value;
                if (!normalized || typeof normalized.url !== 'string' || !normalized.url || (normalized.branch != null && typeof normalized.branch !== 'string')) throw new Error('Invalid registration');
                identity(normalized.url);
                sources[name] = normalized;
            }
        }
    } catch { error('repo_sources.json', 'Cannot inspect repository registrations'); sources = {}; }
    let unregistered = new Set();
    try {
        const registration = path.join(workspace, '.ploinky', 'unregistered_agent_repos.json');
        if (exists(registration)) {
            noLinks(registration);
            const value = JSON.parse(fs.readFileSync(registration, 'utf8'));
            if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !NAME.test(name))) throw new Error('Invalid registration');
            unregistered = new Set(value);
        }
    } catch { error('unregistered_agent_repos.json', 'Cannot inspect repository registrations'); }
    const reserved = new Set(['bizanso', 'simpleCSVMailSend']);
    const candidates = [];
    try {
        for (const name of entries(workspace)) {
            if (name.startsWith('.') || name === 'node_modules' || reserved.has(name)) continue;
            const source = path.join(workspace, name);
            const special = ['AdvancedLanguageAgent', 'DocumentationSkills', 'PromotionScoutV2', 'ScriptaHubAgent'].includes(name);
            let agents = false;
            try {
                const info = fs.lstatSync(source);
                if (info.isSymbolicLink()) {
                    // Discovery accepts links as repository aliases. Their
                    // targets may lie beyond the reader's mounted workspace.
                    const target = path.resolve(workspace, fs.readlinkSync(source));
                    if (target.startsWith(workspace + path.sep)) {
                        noLinks(target);
                        if (fs.lstatSync(target).isFile() && !special && !sources[name]) continue;
                    }
                    error(name, 'Unsafe source path');
                    continue;
                }
                if (info.isDirectory()) agents = entries(source).some(child => exists(path.join(source, child, 'manifest.json')));
            } catch { error(name, 'Cannot inspect workspace source'); continue; }
            if (special || agents || sources[name]) candidates.push({ name, source });
        }
    } catch { error('workspace', 'Cannot enumerate workspace sources'); }
    try {
        const managed = path.join(workspace, '.ploinky', 'repos');
        for (const name of entries(managed)) candidates.push({ name: `.ploinky/repos/${name}`, alias: name, source: path.join(managed, name) });
    } catch { error('.ploinky/repos', 'Cannot enumerate managed sources'); }
    for (const candidate of candidates) {
        let config = sources[candidate.alias || candidate.name];
        const expected = { AdvancedLanguageAgent: 'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git', DocumentationSkills: 'https://github.com/AssistOS-AI/DocumentationSkills.git', PromotionScoutV2: 'https://github.com/AssistOS-AI/PromotionScoutV2.git', ScriptaHubAgent: 'https://github.com/Axiologic/ScriptaHubAgent.git' };
        if (!candidate.alias && expected[candidate.name]) config = { ...config, url: expected[candidate.name] };
        if (!candidate.alias && !Object.hasOwn(expected, candidate.name)) {
            try {
                const origin = checkoutOrigin(checkoutConfig(candidate.source));
                const matches = Object.entries(sources).filter(([, value]) => identity(value.url) === identity(origin));
                if (!matches.some(([name]) => name === candidate.name)) {
                    if (matches.length > 1) throw new Error('Ambiguous registration');
                    if (matches.length === 1) [candidate.name, config] = matches[0];
                }
            } catch (failure) {
                error(candidate.name, failure.message);
                continue;
            }
        }
        const special = ['AdvancedLanguageAgent', 'DocumentationSkills', 'PromotionScoutV2', 'ScriptaHubAgent', 'bizanso', 'simpleCSVMailSend'].includes(candidate.alias || candidate.name);
        if (!special && unregistered.has(candidate.alias || candidate.name)) continue;
        addRepo(candidate.name, candidate.source, config);
    }
    const catalogRoots = Object.create(null);
    for (const [name, relative] of Object.entries(catalogs)) {
        const root = path.join(workspace, relative);
        const found = result.repos.find(repo => roots.get(repo) === root && identity(repo.origin) === identity(`https://github.com/AssistOS-AI/${name}.git`));
        if (found && !result.errors.some(item => item.name === found.name)) catalogRoots[name] = root;
    }
    for (const repo of result.repos) {
        try {
            if (!repo.files.some(file => file.status === '??' && file.path === '.agents/.ploinky-skill-exports.json')) continue;
            const owned = projection(roots.get(repo), catalogRoots);
            repo.files = repo.files.filter(file => file.status !== '??' || !owned.has(file.path));
        } catch { /* An unproven projection remains visible in the inventory. */ }
    }
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 5) throw new Error('Usage: qaSourceInventory.mjs <scope> <workspace> <tooling>');
        process.stdout.write(`${JSON.stringify(inspectSources({ scope: process.argv[2], workspace: process.argv[3], tooling: process.argv[4] }))}\n`);
    } catch (failure) { process.stderr.write(`${failure.message}\n`); process.exitCode = 1; }
}
