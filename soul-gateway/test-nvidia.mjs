// Quick smoke test for NVIDIA provider through Soul Gateway
const BASE = 'https://soul.axiologic.dev';
const API_KEY = process.env.PLOINKY_AGENT_API_KEY || '';
const MODEL = 'nvidia/nemotron-3-super-120b-a12b';

const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
};

async function test(name, fn) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
    } catch (e) {
        console.error(`FAIL  ${name}: ${e.message}`);
        process.exitCode = 1;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg);
}

await test('Model is listed in /v1/models', async () => {
    const res = await fetch(`${BASE}/v1/models`, { headers });
    const body = await res.json();
    const model = body.data.find((m) => m.id === MODEL);
    assert(model, `Model "${MODEL}" not found in models list`);
});

await test('Non-streaming chat completion', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {
                    role: 'user',
                    content:
                        'What is the capital of France? Reply in one word.',
                },
            ],
            stream: false,
        }),
    });
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status}: ${JSON.stringify(body)}`);
    assert(body.choices?.[0]?.message?.content, 'No content in response');
    const answer = body.choices[0].message.content.toLowerCase();
    assert(
        answer.includes('paris'),
        `Expected "Paris", got: "${body.choices[0].message.content}"`
    );
    console.log(`       Response: "${body.choices[0].message.content}"`);
    console.log(`       Tokens: ${body.usage?.total_tokens || '?'}`);
});

await test('Streaming chat completion', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'user', content: 'Say "hello" and nothing else.' },
            ],
            stream: true,
        }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const text = await res.text();
    const lines = text
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
    assert(lines.length > 0, 'No SSE chunks received');
    const chunks = lines.map((l) => JSON.parse(l.slice(6)));
    const content = chunks
        .map((c) => c.choices?.[0]?.delta?.content || '')
        .join('');
    assert(
        content.toLowerCase().includes('hello'),
        `Expected "hello" in stream, got: "${content}"`
    );
    console.log(
        `       Streamed: "${content.trim()}" (${lines.length} chunks)`
    );
});
