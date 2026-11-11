import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// These run inside the confined home helper with exactly one robot home. No token reaches them or the home:
// git gets it on demand from the credential helper, which asks RoboWork over the robot's socket.
export const GIT_CONFIG_DIRECTORY = '.config/roboteam/git';
export const GIT_INCLUDE_PATH = '~/.config/roboteam/git/config';
const HELPER_SOURCE = new URL('./git-credential-helper.mjs', import.meta.url);

// Git configuration values are written quoted. A control character could start a new line or section, so it is refused.
export function gitConfigValue(value) {
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid git configuration value');
    return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function gitConfigText({ name = '', email = '' } = {}) {
    const user = [name && `    name = ${gitConfigValue(name)}`, email && `    email = ${gitConfigValue(email)}`].filter(Boolean);
    return [...(user.length ? ['[user]', ...user] : []),
        '[credential "https://github.com"]',
        '    helper =',
        '    helper = "!node \\"$HOME/.config/roboteam/git/credential-helper.mjs\\""',
        '    useHttpPath = false', ''].join('\n');
}

// Only a regular file with one link may be replaced, so a robot-planted link cannot redirect the write.
async function writeHomeFile(file, content, mode = 0o600) {
    const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('Unsafe git configuration file');
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : mode });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

async function ensureDirectories(home) {
    let current = home;
    for (const segment of GIT_CONFIG_DIRECTORY.split('/')) {
        current = path.join(current, segment);
        await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        if (!(await fs.lstat(current)).isDirectory()) throw new Error('Unsafe git configuration directory');
    }
    return current;
}

const INCLUDE_LINE = /^\s*path\s*=\s*"?~\/\.config\/roboteam\/git\/config"?\s*$/mu;

// Appends one include block when none is present and keeps every other byte of the user's file.
export function withInclude(existing = '') {
    if (INCLUDE_LINE.test(existing)) return existing;
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    return `${existing}${separator}[include]\n    path = ${GIT_INCLUDE_PATH}\n`;
}

export async function setGitHomeConfig(home, { name = '', email = '' } = {}) {
    const text = gitConfigText({ name, email });
    const directory = await ensureDirectories(home);
    await writeHomeFile(path.join(directory, 'credential-helper.mjs'), await fs.readFile(HELPER_SOURCE));
    await writeHomeFile(path.join(directory, 'config'), text);
    const gitconfig = path.join(home, '.gitconfig');
    const existing = await fs.readFile(gitconfig, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    const updated = withInclude(existing);
    if (updated !== existing) await writeHomeFile(gitconfig, updated, 0o644);
    return { ok: true };
}

// A dangling include is harmless to git, so ~/.gitconfig is left as the user has it.
export async function deleteGitHomeConfig(home) {
    const directory = path.join(home, GIT_CONFIG_DIRECTORY);
    const entry = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!entry) return { ok: true };
    if (!entry.isDirectory()) throw new Error('Unsafe git configuration directory');
    for (const name of ['config', 'credential-helper.mjs']) await fs.rm(path.join(directory, name), { force: true });
    return { ok: true };
}
