import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ──────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'https://soul.axiologic.dev';
const API_KEY =
    __ENV.API_KEY ||
    'sk-soul-eea0fd976aaa8a05712fe60b9db973727470e5edabaf31ca31953b65240e85a8';

const MODELS = ['axiologic-deep', 'axiologic-fast', 'axiologic-ultra'];

const PROMPT_TEMPLATES = [
    'What is {a}+{b}?',
    'Explain {topic} in one sentence.',
    'Name {n} {thing}.',
    'What is the capital of {country}?',
    'Write a haiku about {subject}.',
    'Define the word "{word}" briefly.',
    'What does {acronym} stand for?',
    'Translate "{phrase}" to {language}.',
];
const TOPICS = [
    'quicksort',
    'recursion',
    'TCP',
    'DNS',
    'hashing',
    'caching',
    'polymorphism',
    'garbage collection',
];
const THINGS = [
    'colors',
    'planets',
    'animals',
    'fruits',
    'rivers',
    'metals',
    'languages',
    'instruments',
];
const COUNTRIES = [
    'France',
    'Japan',
    'Brazil',
    'Egypt',
    'Canada',
    'India',
    'Norway',
    'Chile',
    'Kenya',
    'Turkey',
];
const SUBJECTS = [
    'code',
    'rain',
    'coffee',
    'stars',
    'trees',
    'bugs',
    'loops',
    'time',
];
const WORDS = [
    'ephemeral',
    'ubiquitous',
    'pragmatic',
    'serendipity',
    'entropy',
    'latency',
    'throughput',
    'idempotent',
];
const ACRONYMS = [
    'HTTP',
    'DNS',
    'TCP',
    'API',
    'REST',
    'SQL',
    'CSS',
    'HTML',
    'JWT',
    'SSH',
];
const PHRASES = [
    'hello',
    'goodbye',
    'thank you',
    'good morning',
    'how are you',
    'welcome',
    'cheers',
    'good night',
];
const LANGUAGES = [
    'Spanish',
    'French',
    'German',
    'Japanese',
    'Italian',
    'Portuguese',
    'Korean',
    'Russian',
];

// ──────────────────────────────────────────────────────────────
// Custom metrics
// ──────────────────────────────────────────────────────────────

const ttfbTrend = new Trend('ttfb_ms', true);
const modelErrors = new Counter('model_errors');
const modelSuccess = new Rate('model_success_rate');

const deepLatency = new Trend('axiologic_deep_latency', true);
const fastLatency = new Trend('axiologic_fast_latency', true);
const ultraLatency = new Trend('axiologic_ultra_latency', true);

const modelTrends = {
    'axiologic-deep': deepLatency,
    'axiologic-fast': fastLatency,
    'axiologic-ultra': ultraLatency,
};

// ──────────────────────────────────────────────────────────────
// Scenarios
// ──────────────────────────────────────────────────────────────

export const options = {
    scenarios: {
        // Warm-up: 2 VUs for 30s, one request per model
        warmup: {
            executor: 'constant-vus',
            vus: 2,
            duration: '30s',
            exec: 'roundRobin',
            startTime: '0s',
            tags: { phase: 'warmup' },
        },

        // Steady load: 5 VUs for 2 minutes, random model
        steady: {
            executor: 'constant-vus',
            vus: 5,
            duration: '2m',
            exec: 'randomModel',
            startTime: '35s',
            tags: { phase: 'steady' },
        },

        // Ramp-up spike: 1→15→1 VUs over 3 minutes
        spike: {
            executor: 'ramping-vus',
            startVUs: 1,
            stages: [
                { duration: '30s', target: 5 },
                { duration: '30s', target: 15 },
                { duration: '1m', target: 15 },
                { duration: '30s', target: 1 },
            ],
            exec: 'randomModel',
            startTime: '3m',
            tags: { phase: 'spike' },
        },

        // Per-model isolated: 3 VUs each model sequentially
        deep_only: {
            executor: 'constant-vus',
            vus: 3,
            duration: '1m',
            exec: 'deepOnly',
            startTime: '6m30s',
            tags: { phase: 'deep_only' },
        },
        fast_only: {
            executor: 'constant-vus',
            vus: 3,
            duration: '1m',
            exec: 'fastOnly',
            startTime: '7m40s',
            tags: { phase: 'fast_only' },
        },
        ultra_only: {
            executor: 'constant-vus',
            vus: 3,
            duration: '1m',
            exec: 'ultraOnly',
            startTime: '8m50s',
            tags: { phase: 'ultra_only' },
        },

        // Streaming test: 3 VUs, random model, streaming enabled
        streaming: {
            executor: 'constant-vus',
            vus: 3,
            duration: '1m',
            exec: 'streamingRandom',
            startTime: '10m',
            tags: { phase: 'streaming' },
        },
    },

    thresholds: {
        model_success_rate: ['rate>0.90'],
        axiologic_fast_latency: ['p(95)<30000'],
        axiologic_deep_latency: ['p(95)<60000'],
        axiologic_ultra_latency: ['p(95)<90000'],
        http_req_failed: ['rate<0.15'],
    },
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
};

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPrompt() {
    const tpl = pick(PROMPT_TEMPLATES);
    return tpl
        .replace('{a}', rand(1, 999))
        .replace('{b}', rand(1, 999))
        .replace('{topic}', pick(TOPICS))
        .replace('{n}', rand(2, 7))
        .replace('{thing}', pick(THINGS))
        .replace('{country}', pick(COUNTRIES))
        .replace('{subject}', pick(SUBJECTS))
        .replace('{word}', pick(WORDS))
        .replace('{acronym}', pick(ACRONYMS))
        .replace('{phrase}', pick(PHRASES))
        .replace('{language}', pick(LANGUAGES));
}

function chatCompletion(model, stream) {
    const payload = JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: randomPrompt() }],
        max_tokens: 100,
        stream: stream || false,
    });

    const start = Date.now();
    const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
        headers: headers,
        timeout: '120s',
        tags: { model: model },
    });
    const elapsed = Date.now() - start;

    ttfbTrend.add(res.timings.waiting);

    if (modelTrends[model]) {
        modelTrends[model].add(elapsed);
    }

    const ok = check(res, {
        'status is 200': (r) => r.status === 200,
        'has choices': (r) => {
            if (stream) return r.status === 200; // streaming returns SSE, not JSON
            try {
                return JSON.parse(r.body).choices?.length > 0;
            } catch {
                return false;
            }
        },
    });

    if (ok) {
        modelSuccess.add(1);
    } else {
        modelSuccess.add(0);
        modelErrors.add(1);
        if (res.status !== 200) {
            console.warn(
                `[${model}] status=${res.status} body=${res.body?.substring(0, 200)}`
            );
        }
    }

    // Pause between requests: real models need time, don't hammer
    sleep(Math.random() * 2 + 1);
}

// ──────────────────────────────────────────────────────────────
// Exported scenario functions
// ──────────────────────────────────────────────────────────────

export function roundRobin() {
    const idx = __ITER % MODELS.length;
    chatCompletion(MODELS[idx], false);
}

export function randomModel() {
    const model = MODELS[Math.floor(Math.random() * MODELS.length)];
    chatCompletion(model, false);
}

export function deepOnly() {
    chatCompletion('axiologic-deep', false);
}

export function fastOnly() {
    chatCompletion('axiologic-fast', false);
}

export function ultraOnly() {
    chatCompletion('axiologic-ultra', false);
}

export function streamingRandom() {
    const model = MODELS[Math.floor(Math.random() * MODELS.length)];
    chatCompletion(model, true);
}
