// Preloaded with `node --import` only by the AgentServer integration test.
// It replaces MainAgent inference inside the spawned `src/index.mjs -mcp` tool
// process with a fixed answer, so the real AgentServer schema path, envelope,
// session binding and AKU persistence run without a model or credentials. It
// records the runtime prompt and the trusted execution context it received.
import fs from 'node:fs';
import path from 'node:path';

const entry = String(process.argv[1] || '');
const recordDir = String(process.env.WEBASSIST_TEST_INFERENCE_RECORD_DIR || '');

if (recordDir && entry.endsWith(`${path.sep}src${path.sep}index.mjs`)) {
    const { MainAgent } = await import('achillesAgentLib');
    MainAgent.prototype.executePrompt = async function stubbedExecutePrompt(runtimePrompt, options = {}) {
        const record = { runtimePrompt, context: options.context ?? null };
        fs.writeFileSync(path.join(recordDir, `execute-${process.pid}-${Date.now()}.json`), JSON.stringify(record));
        return { result: 'Stubbed webAssist answer.' };
    };
}
