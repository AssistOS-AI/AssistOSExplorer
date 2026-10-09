const structure = graph => JSON.stringify({ tasks: graph.tasks, edges: graph.edges, entryTaskId: graph.entryTaskId, layout: graph.layout });

// Own only the description baseline and async revision lifecycle. The editor
// owns the draft and persistence; late results never overwrite newer edits.
export function createDescriptionRevision({ getGraph, generate, apply, onState = () => {} }) {
    let baseline = '', epoch = 0, pending = null, controller = null;
    function invalidate() {
        const previous = pending;
        epoch++;
        controller?.abort();
        controller = null;
        pending = null;
        return previous;
    }
    function reset(description) { invalidate(); baseline = description.trim(); onState('idle'); }
    function edited() { invalidate(); onState(getGraph().description.trim() === baseline ? 'idle' : 'edited'); }
    function check() {
        if (pending) return pending;
        const snapshot = structuredClone(getGraph());
        const description = snapshot.description.trim();
        if (description === baseline) return Promise.resolve(true);
        if (!description) {
            onState('failed', 'Enter a description or restore the previous text before saving.');
            return Promise.resolve(false);
        }
        const request = ++epoch;
        controller = new AbortController();
        const signal = controller.signal;
        onState('checking');
        pending = (async () => {
            try {
                const result = await generate(snapshot, baseline, description, { signal });
                if (request !== epoch) return false;
                if (getGraph().description.trim() !== description || structure(getGraph()) !== structure(snapshot)) {
                    onState('failed', 'The draft changed during review. Check the description again before saving.');
                    return false;
                }
                if (typeof result.regenerate !== 'boolean' || (result.regenerate && !result.graph?.tasks?.length)) throw new Error('Invalid description review result.');
                if (result.regenerate) apply(result.graph);
                baseline = description;
                onState(result.regenerate ? 'regenerated' : 'unchanged', result.reason);
                return true;
            } catch (error) {
                if (request === epoch) onState('failed', `Description review failed: ${error.message}`);
                return false;
            } finally {
                if (request === epoch) { pending = null; controller = null; }
            }
        })();
        return pending;
    }
    return { reset, edited, check, dispose: invalidate };
}
