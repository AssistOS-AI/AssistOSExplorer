import { OUTPUT_EVENT_MAX_BYTES } from '../stateObservation.mjs';

// Relays ALA's records into the reference's events without ever blocking the stream (decision M-7).
//
// `push` only queues, so the control-stream reader's promise resolves at once and a slow store cannot pause ALA. A
// background flush writes the queue in batches through `record(events) -> {stored, dropped}`. Bounds, and what happens
// at each (never silently):
//   a record whose JSON exceeds the stored event size  -> a `truncated` event {dropped: 1, reason: 'record_too_large'}
//   more than maxQueued records waiting                -> the new record is dropped and counted into one `truncated`
//                                                         event {dropped: n, reason: 'relay_backlog'} at the gap
//   the store refuses events (per-reference caps)      -> the store reports `dropped`; a final `truncated` event with the
//                                                         total {reason: 'event_limit'} is attempted at close
export function createEventRelay({ record, maxQueued = 2048, maxBatch = 256, flushMs = 100, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const queue = [];
    let queuedRecords = 0;
    let timer = null;
    let flushing = null;
    let closed = false;
    let storeDropped = 0;
    let stored = 0;

    const gapAtTail = () => (queue.length > 0 && queue[queue.length - 1].gap === true ? queue[queue.length - 1] : null);

    function schedule() {
        if (timer !== null || closed) return;
        timer = setTimer(() => { timer = null; flush().catch(() => {}); }, flushMs);
        timer.unref?.();
    }

    function note(event) {
        queue.push(event);
        schedule();
    }

    function flush() {
        if (flushing !== null) return flushing;
        flushing = (async () => {
            while (queue.length > 0) {
                const batch = queue.splice(0, maxBatch);
                queuedRecords -= batch.filter((entry) => entry.gap !== true).length;
                const events = batch.map((entry) => (entry.gap === true ? { type: 'truncated', data: { dropped: entry.dropped, reason: entry.reason } } : entry));
                try {
                    const result = record(events);
                    stored += result.stored;
                    storeDropped += result.dropped;
                } catch (error) {
                    // The attempt has ended or the store refused: the events cannot be kept.
                    storeDropped += events.length;
                    log('relay_store_failed', { error: error?.code ?? error?.name ?? 'error' });
                }
                // Let the stream and the store breathe between batches.
                await Promise.resolve();
            }
        })().finally(() => {
            flushing = null;
            // Records that arrived after the loop's last look are flushed by a new timer, not lost.
            if (queue.length > 0) schedule();
        });
        return flushing;
    }

    return Object.freeze({
        // Never throws, never waits. `bytes` is the record's size on the wire.
        push(recordValue, bytes) {
            if (closed) return;
            if (bytes > OUTPUT_EVENT_MAX_BYTES) {
                const tail = gapAtTail();
                if (tail && tail.reason === 'record_too_large') tail.dropped += 1;
                else note({ gap: true, dropped: 1, reason: 'record_too_large' });
                return;
            }
            if (queuedRecords >= maxQueued) {
                const tail = gapAtTail();
                if (tail && tail.reason === 'relay_backlog') tail.dropped += 1;
                else note({ gap: true, dropped: 1, reason: 'relay_backlog' });
                return;
            }
            queuedRecords += 1;
            note({ type: 'ala', data: { record: recordValue } });
        },
        flush,
        // Flushes everything, then reports events the store refused as one last marker.
        async close() {
            if (closed) return { stored, dropped: storeDropped };
            if (timer !== null) { clearTimer(timer); timer = null; }
            await flush();
            closed = true;
            if (storeDropped > 0) {
                try { record([{ type: 'truncated', data: { dropped: storeDropped, reason: 'event_limit' } }]); } catch { /* the attempt has ended */ }
            }
            return { stored, dropped: storeDropped };
        },
        stats: () => ({ queued: queue.length, stored, storeDropped })
    });
}
