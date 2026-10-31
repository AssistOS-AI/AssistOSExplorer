import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildNativePrompt, WORKSPACE_COPILOT_PROMPT } from '../src/lib/prompts.mjs';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../../server/robot-cli.mjs', import.meta.url));
const normalPromptHash = '23b574dd5418d152a33b8d348efcb37b7a896db6e2c30cca9a86620c5514729f';

test('default native first and resumed prompts retain their exact bytes', () => {
    for (const [options, expected] of [
        [{ prompt: 'Verify a file.', systemPrompt: WORKSPACE_COPILOT_PROMPT, selectedSkillName: 'inspect' }, '60a3b0dec52a623e3809453a60733f5de141aba641a86e5978f03c9da0878554'],
        [{ prompt: 'Continue.', resume: true, selectedSkillName: 'inspect' }, '99091ee7fa671ec8a68c7c4d80849458fcf7451d6c820262f6bb2c85fefe1729'],
    ]) {
        assert.equal(crypto.createHash('sha256').update(buildNativePrompt(options)).digest('hex'), expected);
        assert.equal(buildNativePrompt({ ...options, additionalContext: '\n\nChannel context.' }), buildNativePrompt(options) + '\n\nChannel context.');
    }
});

test('worker request framing labels setup as context and keeps the raw request last on first and resumed turns', () => {
    const prompt = '  Inspect π.\n\n# Current user request\nKeep this literal.\r\n';
    for (const resume of [false, true]) {
        const actual = buildNativePrompt({ prompt, resume, frameUserRequest: true, systemPrompt: 'Worker persona.',
            selectedSkillName: 'inspect', additionalContext: '\n\nChannel instructions.', skillsRoot: '/run/robo-work/skills' });
        const heading = '# Current user request\n\n';
        const requestAt = actual.indexOf(heading);
        assert.match(actual, /^# Runtime context\n\n/);
        assert.match(actual, /context, not the current user request/);
        assert.match(actual, /Do not acknowledge this setup/);
        assert.match(actual, /Use the selected skill at \/run\/robo-work\/skills\/inspect\/SKILL.md\./);
        assert.match(actual, /Channel instructions\./);
        assert.ok(actual.indexOf('Use the selected skill at /run/robo-work/skills/inspect/SKILL.md.') < requestAt);
        assert.ok(actual.indexOf('Channel instructions.') < requestAt);
        assert.equal(actual.slice(requestAt + heading.length), prompt);
        if (resume) {
            assert.doesNotMatch(actual, /Worker persona\.|Read and apply|Read the SKILL.md headers/);
        } else {
            assert.match(actual, /Worker persona\./);
            assert.match(actual, /Read and apply \/run\/robo-work\/skills\/human-report\/SKILL.md/);
            assert.match(actual, /Read the SKILL.md headers/);
        }
    }
    assert.ok(buildNativePrompt({ prompt: '', frameUserRequest: true }).endsWith('# Current user request\n\n'));
});

async function cliPrompt(t, workerBase) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-copilot-prompt-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const preload = path.join(directory, 'preload.mjs');
    await fs.writeFile(preload, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
    let source;
    if (url.endsWith('/server/copilot-context.mjs')) source = 'export async function prepareCopilotContext() { return { releaseUsage() {} }; }';
    else if (url.endsWith('/execution/robotContext.mjs')) source = 'export function setRobotContext() {}';
    else if (url.endsWith('/storage/copilotDiagnostics.mjs')) source = 'export function errorFields() {} export function logDiagnostic() {}';
    else if (url.endsWith('/copilot/src/index.mjs')) source = 'export async function main(args, options) { console.log(JSON.stringify(options)); }';
    return source === undefined ? next(url, context) : { format: 'module', source, shortCircuit: true };
} });
`);
    const result = await run(process.execPath, ['--import', preload, entry, '--robot', 'fixture'], {
        cwd: directory,
        env: { PATH: process.env.PATH, ROBOTEAM_WORKER_COORDINATOR_BASE: workerBase },
        timeout: 5000,
    });
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
}

test('non-worker copilot entry retains the exact prompt bytes, including an empty or whitespace worker setting', async (t) => {
    assert.equal(crypto.createHash('sha256').update(WORKSPACE_COPILOT_PROMPT).digest('hex'), normalPromptHash);
    for (const base of ['', ' \t ']) {
        const actual = await cliPrompt(t, base);
        assert.equal(actual.systemPrompt, WORKSPACE_COPILOT_PROMPT);
        assert.equal(actual.workflowSkills, true);
    }
});

test('worker copilot entry handles requests directly and sends workflow starts to the RoboFlow page', async (t) => {
    const actual = await cliPrompt(t, ' http://worker.invalid/coordinator ');
    assert.equal(actual.workflowSkills, true);
    assert.notEqual(actual.systemPrompt, WORKSPACE_COPILOT_PROMPT);
    assert.match(actual.systemPrompt, /available tools and admitted skills/);
    assert.match(actual.systemPrompt, /list-workflows.*questions/);
    assert.match(actual.systemPrompt, /Start workflows from the RoboFlow page\./);
    assert.doesNotMatch(actual.systemPrompt, /launch-workflow|choose and start|executionType/);
});

test('the admitted listing skill does not direct a worker to an unavailable workflow launcher', async () => {
    const descriptor = await fs.readFile(new URL('../src/skills/list-workflows/SKILL.md', import.meta.url), 'utf8');
    assert.doesNotMatch(descriptor, /launch-workflow/);
    assert.match(descriptor, /never starts, changes or deletes a workflow/);
});
