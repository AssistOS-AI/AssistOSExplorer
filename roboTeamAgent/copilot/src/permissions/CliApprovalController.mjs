import { showCommandSelector } from '../ui/CommandSelector.mjs';
import { UIContext } from '../ui/UIContext.mjs';

export class CliApprovalController {
    constructor({ selector = showCommandSelector, output = process.stdout } = {}) {
        this.selector = selector;
        this.output = output;
        this.inputControls = {};
        this.queue = Promise.resolve();
    }

    setInputControls(controls = {}) {
        this.inputControls = controls || {};
    }

    select(event, { signal } = {}) {
        if (signal?.aborted) return Promise.resolve(null);
        let started = false;
        let abort;
        const cancelled = new Promise((resolve) => {
            abort = () => { if (!started) resolve(null); };
            signal?.addEventListener('abort', abort, { once: true });
        });
        const selection = this.queue.then(() => {
            started = true;
            signal?.removeEventListener('abort', abort);
            return this.show(event, signal);
        });
        this.queue = selection.catch(() => {});
        return Promise.race([selection, cancelled]);
    }

    async show(event, signal) {
        if (signal?.aborted) return null;
        const controls = this.inputControls;
        const options = event.options.map((option) => ({
            name: option.label,
            value: option.id,
            description: option.description || '',
        }));
        let abort;
        const cancelled = new Promise((resolve) => {
            abort = () => resolve(null);
            signal?.addEventListener('abort', abort, { once: true });
        });
        try {
            controls.pause?.();
            controls.suspendInput?.();
            if (signal?.aborted) return null;
            const message = [event.title, event.message, event.detail]
                .filter(Boolean).map(String).join('\n');
            this.output.write(`\n${message}\n`);
            const selected = await Promise.race([
                this.selector(options, {
                    prompt: 'Permission> ',
                    initialFilter: '',
                    maxVisible: options.length,
                    theme: UIContext.getTheme(),
                    signal,
                }),
                cancelled,
            ]);
            if (signal?.aborted) return null;
            return options.some((option) => option.value === selected?.value) ? selected.value : null;
        } catch (error) {
            if (!signal?.aborted) this.output.write(`\nApproval selector failed: ${error.message}\n`);
            return null;
        } finally {
            signal?.removeEventListener('abort', abort);
            try {
                controls.restoreInput?.();
            } finally {
                controls.resume?.();
            }
        }
    }
}

export default CliApprovalController;
