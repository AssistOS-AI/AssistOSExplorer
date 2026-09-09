import fs from 'node:fs/promises';
import path from 'node:path';

const ENVIRONMENT = `# Ploinky loader options do not apply to interactive coding-agent CLIs.
unset NODE_OPTIONS
export CODEX_HOME="$HOME/.codex"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
case ":$PATH:" in
    *:/data/tool-cache/shell/bin:*) ;;
    *) export PATH="/data/tool-cache/shell/bin:$PATH" ;;
esac
`;
const SOURCE = '\n# RoboTeam shared coding-agent environment\n. "$HOME/.roboteam-env.sh"\n';

export async function prepareRobotShell(home) {
    const stat = await fs.lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe robot home');
    for (const directory of ['.codex', '.config', '.cache', '.local/share', '.local/state', '.pi/agent']) {
        let current = home;
        for (const segment of directory.split('/')) {
            current = path.join(current, segment);
            await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            const entry = await fs.lstat(current);
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe robot configuration directory');
        }
    }
    for (const name of ['.roboteam-env.sh', '.bashrc', '.profile', '.bash_profile']) {
        const handle = await fs.open(path.join(home, name), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) throw new Error('Unsafe robot shell profile');
            const previous = await handle.readFile('utf8');
            if (name === '.roboteam-env.sh') {
                if (previous !== ENVIRONMENT) {
                    await handle.truncate(0);
                    await handle.write(ENVIRONMENT, 0, 'utf8');
                }
            } else if (!previous.includes('. "$HOME/.roboteam-env.sh"')) {
                const prefix = name === '.bash_profile' && !previous
                    ? 'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi\n' : '';
                await handle.write(prefix + SOURCE, metadata.size, 'utf8');
            }
        } finally { await handle.close(); }
    }
}
