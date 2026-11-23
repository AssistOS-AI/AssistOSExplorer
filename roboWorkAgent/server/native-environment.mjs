import path from 'node:path';

// Only runtime inputs needed by ALA and the selected native executables cross the boundary.
export function nativeEnvironment(env = {}, home) {
    const result = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'CODEX_BIN', 'OPENCODE_BIN', 'PI_BIN', 'OMP_BIN', 'CLAUDE_BIN', 'VIBE_BIN', 'ALA_BWRAP', 'ALA_EVENT_STREAM', 'ALA_SESSIONS']) {
        if (typeof env[key] === 'string') result[key] = env[key];
    }
    return { ...result, HOME: home, USER: path.basename(home), LOGNAME: path.basename(home),
        ALA_SANDBOX_HOME: home, CODEX_HOME: path.join(home, '.codex'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
        // No PI_CODING_AGENT_DIR: Pi and OMP both read it, so with it OMP would use Pi's state directory.
        OMP_DIR: path.join(home, '.omp'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        VIBE_HOME: path.join(home, '.vibe') };
}
