import readline from 'node:readline';
import { Writable } from 'node:stream';
import { showCommandSelector } from './CommandSelector.mjs';
import { UIContext } from './UIContext.mjs';

/** Terminal surface shared by REPL and one-shot task model/login commands. */
export function createTerminalTaskInteractions({ getControls = () => null } = {}) {
    async function select(request, { signal } = {}) {
        if (!process.stdin.isTTY) throw new Error('Interactive selection requires a terminal.');
        const controls = getControls();
        controls?.pause();
        controls?.suspendInput();
        try {
            console.log([request.title, request.message, request.detail].filter(Boolean).join('\n'));
            const selected = await showCommandSelector(request.options.map((option) => ({
                name: option.label || option.value, value: option.value, description: option.description || '',
            })), { prompt: '> ', signal, theme: UIContext.getTheme() });
            if (!selected) throw new Error('interaction_cancelled');
            return selected.value;
        } finally {
            controls?.restoreInput();
            controls?.resume();
        }
    }

    async function input(request, { signal } = {}) {
        if (!process.stdin.isTTY) throw new Error('Interactive input requires a terminal.');
        const controls = getControls();
        controls?.pause();
        controls?.suspendInput();
        try {
            console.log([request.title, request.message].filter(Boolean).join('\n'));
            if (signal?.aborted) throw new Error('interaction_cancelled');
            return await new Promise((resolve, reject) => {
                const output = request.type === 'secret'
                    ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
                const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
                let settled = false;
                const finish = (error, answer) => {
                    if (settled) return;
                    settled = true;
                    signal?.removeEventListener('abort', abort);
                    rl.close();
                    if (error) reject(error); else resolve(answer);
                };
                const abort = () => finish(new Error('interaction_cancelled'));
                signal?.addEventListener('abort', abort, { once: true });
                rl.on('SIGINT', abort);
                rl.on('close', () => { if (!settled) abort(); });
                rl.question('> ', (answer) => finish(null, answer));
            });
        } finally {
            controls?.restoreInput();
            controls?.resume();
        }
    }

    return { select, input };
}
