import path from 'node:path';

// Only runtime inputs needed by ALA and the selected native executables cross the boundary.
export function nativeEnvironment(env = {}, home) {
    const result = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'CODEX_BIN', 'OPENCODE_BIN', 'PI_BIN', 'CLAUDE_BIN', 'ALA_BWRAP', 'ALA_EVENT_STREAM']) {
        if (typeof env[key] === 'string') result[key] = env[key];
    }
    return { ...result, HOME: home, USER: path.basename(home), LOGNAME: path.basename(home),
        ALA_SANDBOX_HOME: home, CODEX_HOME: path.join(home, '.codex'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
        PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
}
