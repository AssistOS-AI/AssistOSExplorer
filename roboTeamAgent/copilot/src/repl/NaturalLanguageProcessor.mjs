import { createSpinner } from '../ui/spinner.mjs';
import { renderMarkdown } from '../ui/MarkdownRenderer.mjs';

/** Owns terminal input while an ALA turn runs; execution and history stay in the engine. */
export class NaturalLanguageProcessor {
    constructor({ processPrompt, historyManager, isMarkdownEnabled = () => true, interactions }) {
        this.processPrompt = processPrompt;
        this.historyManager = historyManager;
        this.isMarkdownEnabled = isMarkdownEnabled;
        this.interactions = interactions;
    }

    async run(operation) {
        const controller = new AbortController();
        const spinner = createSpinner('Working...');
        const previousRawMode = process.stdin.isRaw;
        const handleKey = (key) => {
            if (['\x1b', '\x03'].includes(key.toString())) controller.abort();
        };
        const suspendInput = () => {
            process.stdin.removeListener('data', handleKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
        };
        const restoreInput = () => {
            if (!process.stdin.isTTY || controller.signal.aborted) return;
            process.stdin.setRawMode(true);
            process.stdin.removeListener('data', handleKey);
            process.stdin.on('data', handleKey);
        };
        const controls = {
            pause: () => spinner.pause(),
            resume: () => spinner.resume(),
            suspendInput,
            restoreInput,
        };
        const onEvent = (event) => {
            if (!['coding-agent-message', 'agentlib-tool', 'diagnostic'].includes(event.type)) return;
            const message = event.message || event.reason;
            if (typeof message !== 'string' || !message.trim()) return;
            spinner.pause();
            console.log(message);
            spinner.resume();
        };
        this.interactions?.setInputControls(controls);
        restoreInput();
        try {
            return await operation({ signal: controller.signal, controls, spinner, onEvent });
        } finally {
            this.interactions?.setInputControls(null);
            suspendInput();
            if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(previousRawMode));
            spinner.stop();
        }
    }

    async process(input) {
        try {
            const result = await this.run(({ signal, onEvent }) => this.processPrompt(input, { signal, onEvent }));
            console.log(this.isMarkdownEnabled() ? renderMarkdown(result) : result);
            await this.historyManager.add(input);
        } catch (error) {
            console.error(error.name === 'AbortError' ? 'Operation cancelled.' : error.message);
        }
    }
}

export default NaturalLanguageProcessor;
