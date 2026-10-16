import fs from 'node:fs/promises';
import path from 'node:path';
import { installSoulGatewayPlugin } from './soul-gateway-service.mjs';
import { seedOpenCodePlugin } from './opencode-plugin-seed.mjs';
import { ensureAgentConfig } from './agent-model-config.mjs';
import { CODING_AGENT_NAMES } from './coding-agents.mjs';

// The robot shell offers every coding agent; the robot's selection only
// configures which agents ALA runs.
function shellEnvironment({ binPath, cacheRoot = '/data/tool-cache' } = {}) {
    const directory = binPath || `${cacheRoot}/shell-selections/shell/bin`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    return `# Ploinky loader options do not apply to interactive coding-agent CLIs.
unset NODE_OPTIONS
export CODEX_HOME="$HOME/.codex"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
# Claude Code keeps its login and sessions here; ALA reads the same directory.
export CLAUDE_CONFIG_DIR="$HOME/.claude"
unset CODEX_BIN OPENCODE_BIN PI_BIN CLAUDE_BIN
roboteam_saved_ifs=$IFS
IFS=:
roboteam_clean_path=
for roboteam_path in $PATH; do
    case "$roboteam_path" in
        ${quote(cacheRoot)}/*) ;;
        *) roboteam_clean_path="\${roboteam_clean_path:+$roboteam_clean_path:}$roboteam_path" ;;
    esac
done
IFS=$roboteam_saved_ifs
export PATH=${quote(directory)}:"$roboteam_clean_path"
${CODING_AGENT_NAMES.map(name => `export ${name.toUpperCase()}_BIN=${quote(path.join(directory, name))}`).join('\n')}
unset roboteam_saved_ifs roboteam_clean_path roboteam_path
`;
}
const SOURCE = '\n# RoboTeam shared coding-agent environment\n. "$HOME/.roboteam-env.sh"\n';

export async function prepareRobotShell(home, options) {
    const stat = await fs.lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe robot home');
    for (const directory of ['.codex', '.config/opencode/plugins', '.cache', '.local/share', '.local/state', '.pi/agent', '.claude']) {
        let current = home;
        for (const segment of directory.split('/')) {
            current = path.join(current, segment);
            await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            const entry = await fs.lstat(current);
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe robot configuration directory');
        }
    }
    await installSoulGatewayPlugin(home);
    // Before OpenCode first runs here, so its own dependency installation finds nothing to do.
    if (options?.openCodePlugin) await seedOpenCodePlugin(home, options.openCodePlugin);
    await ensureAgentConfig(home, { codingAgents: options?.codingAgents });
    for (const name of ['.roboteam-env.sh', '.bashrc', '.profile', '.bash_profile']) {
        const handle = await fs.open(path.join(home, name), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) throw new Error('Unsafe robot shell profile');
            const previous = await handle.readFile('utf8');
            if (name === '.roboteam-env.sh') {
                const directorySetup = '\nif [ -n "${ROBOTEAM_WORKING_DIRECTORY:-}" ] && [ "$PWD" = "$HOME" ]; then cd -- "$ROBOTEAM_WORKING_DIRECTORY"; fi\n';
                const environment = (options || !previous) ? shellEnvironment(options) + directorySetup : previous;
                if (previous !== environment) {
                    await handle.truncate(0);
                    await handle.write(environment, 0, 'utf8');
                }
            } else if (!previous.includes('. "$HOME/.roboteam-env.sh"')) {
                const prefix = name === '.bash_profile' && !previous
                    ? 'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi\n' : '';
                await handle.write(prefix + SOURCE, metadata.size, 'utf8');
            }
        } finally { await handle.close(); }
    }
}
