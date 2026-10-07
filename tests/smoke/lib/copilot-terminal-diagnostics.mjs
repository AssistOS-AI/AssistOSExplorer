import { redactTraceText } from './redacted-trace.mjs';

export const COPILOT_TERMINAL_FAILURE = /\[input error\]|\[error\]|bwrap:|Agent process exited repeatedly|open \/proc\/\d+\/ns|recovery[_ -]required|Marketplace.*recovery|\b421\b|UNKNOWN_HOST|Misdirected Request|tier[_\s-]+exhausted|All models in tier exhausted|provider\s+(?:error|failure)|API\s+(?:error|failure)|startup\s+(?:error|failure)/i;

export function createCopilotDiagnostics({ now = () => new Date().toISOString() } = {}) {
    const evidence = { firstTerminalError: null, submissions: [], replyOutcome: 'not-submitted' };
    return {
        evidence,
        observe(texts) {
            const failure = texts.find(text => COPILOT_TERMINAL_FAILURE.test(text));
            if (failure && !evidence.firstTerminalError) {
                evidence.firstTerminalError = { at: now(), message: redactTraceText(failure).slice(0, 2048) };
            }
            if (failure) {
                evidence.replyOutcome = 'terminal-error';
                throw new Error(`Copilot terminal initialization/completion failed: ${evidence.firstTerminalError.message}`);
            }
        },
        submitted() { evidence.submissions.push({ at: now() }); evidence.replyOutcome = 'waiting'; },
        replied() { evidence.replyOutcome = 'assistant-reply'; },
        timedOut() { evidence.replyOutcome = 'no-reply'; },
    };
}
