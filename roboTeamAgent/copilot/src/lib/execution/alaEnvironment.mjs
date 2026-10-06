import path from 'node:path';

// Native engine environment stays filtered; direct SDK scripts receive an explicit task context.
export function nativeEnvironment(env, home) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (/^(PLOINKY_|SSO_|ACHILLES_MODEL_|ALA_TASK_REPOSITORIES$|ALA_CONFIG_PATH$)|token|secret|password|authorization|cookie|api_?key|credential|private_?key/i.test(key)) continue;
        result[key] = value;
    }
    return { ...result, HOME: home, CODEX_HOME: path.join(home, '.codex'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_CACHE_HOME: path.join(home, '.cache'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
}

