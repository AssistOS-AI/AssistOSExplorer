import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toGatewayNormalizedStream } from '../../runtime/backends/achilles/bridge.mjs';

async function* source(chunks) {
    for (const chunk of chunks) yield chunk;
}

async function collect(chunks) {
    const events = [];
    for await (const event of toGatewayNormalizedStream(source(chunks), { model: 'm' })) {
        events.push(event);
    }
    return events;
}

describe('Achilles bridge liveness', () => {
    it('maps reasoning to a content-free liveness event without starting the message', async () => {
        const events = await collect([
            { type: 'thinking_delta', thinking: 'secret reasoning' },
            { type: 'thinking_delta', thinking: 'more' },
            { type: 'text_delta', text: 'Answer' },
            { type: 'done', stopReason: 'stop' },
        ]);
        assert.deepEqual(events.map((event) => event.type), [
            'activity',
            'activity',
            'message_start',
            'text_delta',
            'done',
        ]);
        assert.deepEqual(events[0].data, { kind: 'reasoning' });
        assert.doesNotMatch(JSON.stringify(events), /secret reasoning/);
    });
});
