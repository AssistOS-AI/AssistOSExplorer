import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_BASE, liveSessionsScenario } from './live-sessions-scenario.mjs';

// Recorded RoboTeam Live Sessions producer output for the Explorer consumer's
// replay test: the administrator list payload and the stream frames of three
// runs, all from the shared scenario. Run this file to regenerate
// tests/fixtures/live-sessions-producer-payload.json.
export const FIXTURE_FILE = fileURLToPath(new URL('../fixtures/live-sessions-producer-payload.json', import.meta.url));
const STREAMED = ['robotTask', 'finished', 'failed'];

function frames(text) {
    return text.split('\n\n').filter((block) => block && !block.startsWith(':')).map((block) => {
        const frame = { id: null };
        for (const line of block.split('\n')) {
            const index = line.indexOf(': ');
            frame[line.slice(0, index)] = line.slice(index + 2);
        }
        return { id: frame.id, event: frame.event, data: frame.data };
    });
}

export function liveSessionsFixture() {
    const { registry, runs } = liveSessionsScenario();
    const admin = { principal: 'user:root', canAdmin: true };
    const list = { ok: true, version: 1, sessions: registry.list(admin) };
    const streams = STREAMED.map((name) => {
        const chunks = [];
        const res = { writeHead() {}, write(chunk) { chunks.push(chunk); return true; }, on() {}, once() {}, removeListener() {}, end() {} };
        registry.attach(runs[name], admin, res);
        return { title: list.sessions.find((row) => row.id === runs[name]).title, frames: frames(chunks.join('')) };
    });
    registry.close();
    return {
        note: 'Recorded RoboTeam Live Sessions producer output. Regenerate with node tests/helpers/generate-live-sessions-fixture.mjs.',
        source: { agent: 'roboTeamAgent', liveSessions: { version: 1, base: SOURCE_BASE } },
        list, streams,
    };
}

// Run ids, timestamps and URLs differ on every generation; everything else
// must match the recorded fixture.
export function comparableFixture(fixture) {
    return {
        rows: fixture.list.sessions.map(({ id, startedAt, lastActivityAt, endedAt, viewUrl, transcriptUrl, ...row }) => ({
            ...row, hasEndedAt: endedAt !== undefined, hasViewUrl: viewUrl !== undefined, hasTranscriptUrl: transcriptUrl !== undefined,
        })).sort((left, right) => left.title.localeCompare(right.title)),
        streams: fixture.streams.map(({ title, frames: list }) => ({ title, frames: list.map(({ event, data }) => ({ event, data })) })),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await fs.mkdir(path.dirname(FIXTURE_FILE), { recursive: true });
    await fs.writeFile(FIXTURE_FILE, `${JSON.stringify(liveSessionsFixture(), null, 2)}\n`);
    console.log(FIXTURE_FILE);
}
