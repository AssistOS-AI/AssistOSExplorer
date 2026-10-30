import { PassThrough } from 'node:stream';

import { createControlStreamReader } from '../execution/controlStreamReader.mjs';

// Reads the three standard streams of an ALA invocation in protocol mode.
//
// Plan/contract deviation (evidence): the plan reads JSON records on ALA's stdout. ALA at cf2996dc writes its structured
// events to STDERR as `@@ALA_EVENT@@<json>` lines (src/runtime-events.mjs:1-7; cli.mjs:312-313 forces ALA_EVENT_STREAM for a
// persistent session) and keeps STDOUT for the final result text (docs/specs/DS004:42; tests/embedded-mode.test.mjs:68).
// This module therefore feeds the section 5.5 control-stream reader (record size, buffering, rate, stall and stdin bounds
// unchanged) with the event lines of stderr, and collects stdout as bounded final text. Unprefixed stderr lines stay
// diagnostic: they go to the reader's 64 KiB ring and are never parsed or relayed.

export const EVENT_PREFIX = Buffer.from('@@ALA_EVENT@@', 'utf8');
const NEWLINE = 0x0a;
export const DEFAULT_MAX_FINAL_BYTES = 16 * 1024 * 1024;

// Splits `source` (ALA's stderr) into an event stream (prefix removed, newline kept) and a diagnostic stream.
// Backpressure: when the event stream is full the source is paused, so ALA's writes block on a full pipe.
export function splitEventLines(source) {
    const events = new PassThrough({ highWaterMark: 64 * 1024 });
    const diagnostics = new PassThrough({ highWaterMark: 64 * 1024 });
    let mode = 'start';
    let head = Buffer.alloc(0);

    const write = (stream, buffer) => {
        if (buffer.length === 0) return;
        if (!stream.write(buffer) && stream === events) {
            source.pause();
            events.once('drain', () => source.resume());
        }
    };

    function feed(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
            if (mode === 'start') {
                const need = EVENT_PREFIX.length - head.length;
                const take = chunk.subarray(offset, Math.min(chunk.length, offset + need));
                const newline = take.indexOf(NEWLINE);
                if (newline >= 0) {
                    // A short line: diagnostic.
                    write(diagnostics, Buffer.concat([head, take.subarray(0, newline + 1)]));
                    head = Buffer.alloc(0);
                    offset += newline + 1;
                    continue;
                }
                head = Buffer.concat([head, take]);
                offset += take.length;
                if (head.length < EVENT_PREFIX.length) continue;
                if (head.equals(EVENT_PREFIX)) mode = 'event';
                else { write(diagnostics, head); mode = 'diag'; }
                head = Buffer.alloc(0);
                continue;
            }
            const newline = chunk.indexOf(NEWLINE, offset);
            const end = newline < 0 ? chunk.length : newline + 1;
            write(mode === 'event' ? events : diagnostics, chunk.subarray(offset, end));
            offset = end;
            if (newline >= 0) mode = 'start';
        }
    }

    source.on('data', feed);
    source.on('end', () => {
        if (mode === 'start' && head.length > 0) write(diagnostics, head);
        events.end();
        diagnostics.end();
    });
    source.on('error', () => { events.destroy(); diagnostics.destroy(); });
    return { events, diagnostics };
}

// Collects ALA's stdout (the final result text) up to `maxBytes`; further bytes are counted and discarded.
export function collectFinalText(stdout, maxBytes = DEFAULT_MAX_FINAL_BYTES, onData = () => {}) {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    let ended = false;
    const done = new Promise((resolve) => {
        const finish = () => { ended = true; resolve(); };
        stdout.on('end', finish);
        stdout.on('close', finish);
        stdout.on('error', finish);
    });
    stdout.on('data', (chunk) => {
        onData();
        if (size >= maxBytes) { overflowed = true; return; }
        const room = maxBytes - size;
        if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size += room; overflowed = true; return; }
        chunks.push(chunk);
        size += chunk.length;
    });
    return {
        done,
        get ended() { return ended; },
        get overflowed() { return overflowed; },
        text: () => Buffer.concat(chunks).toString('utf8')
    };
}

const validateAlaRecord = (record) => (typeof record.type === 'string' && record.type.length > 0 && record.type.length <= 128 ? null : 'record_without_type');

// Wires the three streams of one invocation. `onRecord(record, bytes)` is called for each ALA event record and must not
// block (the dispatcher's relay only queues it). `onEnd(reason, detail)` is the reader's single end notification.
export function openAlaStreams({ stdin, stdout, stderr, limits, onRecord, onEnd, timers, onActivity = () => {} }) {
    const { events, diagnostics } = splitEventLines(stderr);
    const reader = createControlStreamReader({ stdout: events, stderr: diagnostics, stdin, limits, validateRecord: validateAlaRecord, onRecord, onEnd, timers });
    const final = collectFinalText(stdout, DEFAULT_MAX_FINAL_BYTES, onActivity);
    return { reader, final };
}
