import fs from 'node:fs/promises';
import path from 'node:path';
import { installSoulGatewayPlugin } from './soul-gateway-service.mjs';
import { seedOpenCodePlugin } from './opencode-plugin-seed.mjs';
import { ensureAgentConfig } from './agent-model-config.mjs';
import { CODING_AGENT_NAMES } from './coding-agents.mjs';
import { TOOL_CACHE_DIR } from './constants.mjs';

// The robot shell offers every coding agent; the robot's selection only
// configures which agents ALA runs.
function shellEnvironment({ binPath, cacheRoot = TOOL_CACHE_DIR } = {}) {
    const directory = binPath || `${cacheRoot}/shell-selections/shell/bin`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    return `# Desktop shells use the same home as every other robot execution.
if [ -n "\${ROBOTEAM_SHELL_HOME:-}" ]; then
    roboteam_previous_home=$HOME
    export HOME="$ROBOTEAM_SHELL_HOME"
    if [ "$PWD" = "$roboteam_previous_home" ] || [ "$PWD" = /config ]; then cd -- "$HOME"; fi
    unset roboteam_previous_home
fi
# Image login profiles may derive these from the container's operating-system UID.
export USER="\${HOME##*/}"
export LOGNAME="$USER"
# Ploinky loader options do not apply to interactive coding-agent CLIs.
unset NODE_OPTIONS
export CODEX_HOME="$HOME/.codex"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
# Pi and OMP (Oh My Pi, a Pi fork) both take PI_CODING_AGENT_DIR as their state directory, so it is never set:
# Pi then keeps its state in $HOME/.pi/agent and OMP in $HOME/.omp/agent, the directories ALA reads, and neither
# writes its logins or sessions into the other's.
unset PI_CODING_AGENT_DIR
# ALA finds OMP's state through OMP_DIR; OMP itself derives the same directory from HOME.
export OMP_DIR="$HOME/.omp"
# Claude Code keeps its login and sessions here; ALA reads the same directory.
export CLAUDE_CONFIG_DIR="$HOME/.claude"
# Mistral Vibe keeps its configuration, sessions and stored API key here; ALA reads the same directory. The failing
# keyring backend makes its sign-in store the key in $VIBE_HOME/.env, where RoboTeam detects the login (the null
# backend would accept the key and drop it, so every new terminal would ask for a login again).
export VIBE_HOME="$HOME/.vibe"
export PYTHON_KEYRING_BACKEND=keyring.backends.fail.Keyring
# The account's model catalog (models beyond the built-in ones), the same one ALA uses.
export VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG=true
export VIBE_ENABLE_UPDATE_CHECKS=false
# The Antigravity CLI keeps its state in $HOME/.gemini. Over SSH it stores its Google login in
# .gemini/antigravity-cli/antigravity-oauth-token instead of a keyring; this terminal is remote in the same way, and
# that file is the login ALA detects and uses. The tool cache, not agy, updates it.
export SSH_TTY="\${SSH_TTY:-roboteam-agy-file-auth}"
export AGY_CLI_DISABLE_AUTO_UPDATE=1
unset CODEX_BIN OPENCODE_BIN PI_BIN OMP_BIN CLAUDE_BIN VIBE_BIN AGY_BIN
roboteam_saved_ifs=$IFS
IFS=:
roboteam_clean_path=
for roboteam_path in $PATH; do
    case "$roboteam_path" in
        ${quote(cacheRoot)}/*|"$HOME/${UPDATE_BIN}") ;;
        *) roboteam_clean_path="\${roboteam_clean_path:+$roboteam_clean_path:}$roboteam_path" ;;
    esac
done
IFS=$roboteam_saved_ifs
# The update shims come first: an agent's own \`npm install -g\` of itself is answered there (see UPDATE_SHIM).
export PATH="$HOME/${UPDATE_BIN}":${quote(directory)}:"$roboteam_clean_path"
# Pi runs this for \`pi update\`; it reaches the npm shim, which explains how the update happens.
export PI_SELF_UPDATE_COMMAND='npm install -g {installSpec}'
${CODING_AGENT_NAMES.map(name => `export ${name.toUpperCase()}_BIN=${quote(path.join(directory, name))}`).join('\n')}
unset roboteam_saved_ifs roboteam_clean_path roboteam_path
`;
}
const SOURCE = '\n# RoboTeam shared coding-agent environment\n. "$HOME/.roboteam-env.sh"\n';

const UPDATE_DIRECTORY = '.roboteam';
const UPDATE_BIN = `${UPDATE_DIRECTORY}/bin`;
// The coding agents run from RoboWork's shared, read-only tool cache, which RoboWork rechecks whenever a Terminal or
// GUI session opens. An agent that updates itself through npm (Codex's "update now", \`pi update\`, Claude Code's
// auto-updater) cannot write there, so its \`npm install -g\` of itself is answered by telling the person to reopen
// the session; every other npm command runs the real npm, the first one on PATH outside this directory.
const UPDATE_SHIM = `#!/bin/sh
roboteam_agent=
case "\${1:-}" in
    install|i|add)
        roboteam_global=
        for roboteam_argument in "$@"; do
            case "$roboteam_argument" in
                -g|--global|--location=global) roboteam_global=1 ;;
                @openai/codex|@openai/codex@*) roboteam_agent=Codex ;;
                @earendil-works/pi-coding-agent|@earendil-works/pi-coding-agent@*) roboteam_agent=Pi ;;
                @anthropic-ai/claude-code|@anthropic-ai/claude-code@*) roboteam_agent='Claude Code' ;;
            esac
        done
        [ -n "$roboteam_global" ] || roboteam_agent= ;;
esac
if [ -n "$roboteam_agent" ]; then
    printf '%s\\n' "RoboTeam keeps $roboteam_agent up to date in its shared tool cache and checks for a new release whenever a session opens." \\
        "Close this session and open it again from RoboTeam to start the latest release." >&2
    exit 0
fi
roboteam_self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
roboteam_saved_ifs=$IFS
IFS=:
for roboteam_directory in $PATH; do
    [ -n "$roboteam_directory" ] || continue
    [ "$(CDPATH= cd -- "$roboteam_directory" 2>/dev/null && pwd -P)" = "$roboteam_self" ] && continue
    if [ -x "$roboteam_directory/npm" ]; then IFS=$roboteam_saved_ifs; exec "$roboteam_directory/npm" "$@"; fi
done
echo 'npm: command not found' >&2
exit 127
`;

async function privateDirectory(directory) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe robot update directory');
}

async function installUpdateShim(home) {
    await privateDirectory(path.join(home, UPDATE_DIRECTORY));
    await privateDirectory(path.join(home, UPDATE_BIN));
    const handle = await fs.open(path.join(home, UPDATE_BIN, 'npm'), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o700);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Unsafe robot update shim');
        if (await handle.readFile('utf8') !== UPDATE_SHIM) {
            await handle.truncate(0);
            await handle.write(UPDATE_SHIM, 0, 'utf8');
        }
        await handle.chmod(0o700);
    } finally { await handle.close(); }
}

export async function prepareRobotShell(home, options) {
    const stat = await fs.lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe robot home');
    for (const directory of ['.codex', '.config/opencode/plugins', '.cache', '.local/share', '.local/state', '.pi/agent', '.omp', '.claude', '.vibe']) {
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
    await installUpdateShim(home);
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
