import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createWebAssistAgent } from '../src/WebAssistAgent.mjs';
import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { guestGrant, toolEnvelope } from './fixtures/verified-grant.mjs';
import { ScriptedPlannerLLM } from './fixtures/scripted-llm.mjs';

// A19: with debug capture enabled the session secret appears exactly once, in
// the creating response, and nowhere else the agent writes or sends text.
const SITE_ID = 'demo-site';

function countOccurrences(text, needle) {
    return String(text).split(needle).length - 1;
}

async function readTree(root) {
    const out = [];
    async function walk(dir) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) out.push({ file: full, text: await fs.readFile(full, 'latin1') });
        }
    }
    await walk(root);
    return out;
}

function captureProcessOutput() {
    const chunks = [];
    const originals = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = function write(chunk, ...rest) {
        chunks.push(String(chunk));
        return originals.out.call(this, chunk, ...rest);
    };
    process.stderr.write = function write(chunk, ...rest) {
        chunks.push(String(chunk));
        return originals.err.call(this, chunk, ...rest);
    };
    return {
        text: () => chunks.join(''),
        restore() {
            process.stdout.write = originals.out;
            process.stderr.write = originals.err;
        },
    };
}

test('the session secret is returned exactly once and never logged, persisted or sent to the model (A19)', async (t) => {
    const sandbox = await createWebAssistSandbox();
    const debugDir = path.join(sandbox.sandboxRoot, 'debuglogs');
    const previous = { debug: process.env.ACHILLES_DEBUG, dir: process.env.WEBASSIST_DEBUG_DIR };
    process.env.ACHILLES_DEBUG = '1';
    process.env.WEBASSIST_DEBUG_DIR = debugDir;
    const output = captureProcessOutput();
    t.after(async () => {
        output.restore();
        for (const [key, value] of [['ACHILLES_DEBUG', previous.debug], ['WEBASSIST_DEBUG_DIR', previous.dir]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await sandbox.cleanup();
    });
    await ensureSiteAku({ siteId: SITE_ID });

    const { handleMcpRequest } = await import('../src/index.mjs');
    const { getSessionHistory } = await import('../src/mcp/get-session-history.mjs');
    const { callerAccessFromEnvelope, hashSessionSecret } = await import('../src/runtime/sessionAccess.mjs');
    const llms = [];
    const executeContexts = [];
    const createAgent = async () => {
        const llm = new ScriptedPlannerLLM([
            { tool: 'webassist-session', toolPrompt: JSON.stringify({ siteId: SITE_ID, sessionId: 'model-chosen', profileDetails: ['Exposure probe'] }) },
            { tool: 'webassist-site-context', toolPrompt: JSON.stringify({ message: 'session secret' }) },
        ]);
        llms.push(llm);
        const agent = await createWebAssistAgent({ llmAgent: llm });
        const original = agent.mainAgent.executePrompt.bind(agent.mainAgent);
        agent.mainAgent.executePrompt = async (runtimePrompt, options = {}) => {
            executeContexts.push(JSON.stringify({ runtimePrompt, context: options.context }));
            return original(runtimePrompt, options);
        };
        return agent;
    };
    const run = (grant, input) => handleMcpRequest(JSON.stringify(toolEnvelope(grant, { siteId: SITE_ID, json: true, ...input })), { createAgent });

    const created = await run(await guestGrant(), { message: 'hello' });
    assert.equal(created.exitCode, 0, created.stderr);
    const { sessionId, sessionSecret } = JSON.parse(created.stdout);
    assert.match(sessionSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(countOccurrences(created.stdout, sessionSecret), 1, 'creating response carries the secret once');

    const otherGrant = await guestGrant();
    const reused = await run(otherGrant, { sessionId, sessionSecret, message: 'again' });
    assert.equal(reused.exitCode, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).sessionId, sessionId);
    const invalid = await run(otherGrant, { sessionId: '../bad', sessionSecret, message: 'again' });
    assert.equal(invalid.exitCode, 1);
    const history = await getSessionHistory({
        siteId: SITE_ID,
        sessionId,
        sessionSecret,
        access: await callerAccessFromEnvelope(toolEnvelope(otherGrant, {}, 'web_cli_history')),
    });
    assert.equal(history.exists, true);
    output.restore();

    for (const [label, text] of [
        ['reuse stdout', reused.stdout],
        ['reuse stderr', reused.stderr],
        ['creating stderr', created.stderr],
        ['invalid stdout/stderr', invalid.stdout + invalid.stderr],
        ['history response', JSON.stringify(history)],
        ['process stdout/stderr', output.text()],
        ['model calls', llms.map((llm) => llm.allCallsText()).join('\n')],
        ['executePrompt prompt and context', executeContexts.join('\n')],
    ]) {
        assert.equal(countOccurrences(text, sessionSecret), 0, `${label} contains the secret`);
    }
    assert.ok(executeContexts.length >= 2, 'both chats reached inference');

    const debugFiles = await readTree(debugDir);
    assert.ok(debugFiles.some((entry) => path.basename(entry.file).startsWith('runtime-prompt-')), 'debug capture ran');
    assert.ok(debugFiles.some((entry) => path.basename(entry.file).startsWith('aku-search-')), 'aku-search capture ran');
    for (const entry of [...debugFiles, ...await readTree(sandbox.webAssistDataDir)]) {
        assert.equal(entry.text.includes(sessionSecret), false, `${entry.file} contains the secret`);
    }
    const owner = JSON.parse(await fs.readFile(path.join(sandbox.webAssistDataDir, 'sites', SITE_ID, 'session-owners', `${sessionId}.json`), 'utf8'));
    assert.equal(owner.secretHash, hashSessionSecret(sessionSecret));
});
