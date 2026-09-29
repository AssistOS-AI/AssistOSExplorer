// Diagnostics have their own protocol event and never enter conversation output.
function safeText(value, limit = 600) {
    return String(value ?? '')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
        .replace(/((?:token|secret|password|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[redacted]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}

export function emitTaskDiagnostic({ level = 'warn', message, taskId, error }, protocol = true) {
    const diagnostic = { __webchatDiagnostic: 1, version: 1, source: 'webchat-tasks', level,
        message: safeText(message), ...(taskId ? { taskId: safeText(taskId, 80) } : {}),
        ...(error ? { code: safeText(error.code || 'task_poll_failed', 80), detail: safeText(error.message || error) } : {}) };
    if (protocol) process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
    else console[level === 'info' ? 'info' : 'warn']('[webchat-tasks]', diagnostic);
}
