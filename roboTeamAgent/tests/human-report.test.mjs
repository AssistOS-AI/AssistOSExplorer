import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSummaryLines, summaryRanges, withoutSummaryMarkers } from '../shared/impact-summary.mjs';
import { advanceSummaryFile } from '../shared/summary-file-index.mjs';
import { parseRoute, extractJson } from '../server/roboflow/result-parser.mjs';
import { requiredHumanReportSkill } from '../server/required-skills.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { buildNativePrompt, buildTaskPrompt, HUMAN_REPORT_INSTRUCTIONS } from '../copilot/src/lib/prompts.mjs';

const report = text => `<<human-report>>\n${text}\n<<human-report>>`;

test('reports index unicode text and ignore marker examples in code fences', () => {
    const text = '```\n' + report('example') + '\n```\n' + report('Am corectat afișarea.');
    assert.deepEqual(summaryRanges(text).map(range => text.slice(range.start, range.end)), ['Am corectat afișarea.\n']);
    assert.equal(summaryRanges('<<human-report>>\nunfinished').length, 0);
    assert.equal(scanSummaryLines(report('ok'), { bytes: true }).ranges.length, 1);
});

test('streamed reports survive split markers and multibyte text in indexed files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'human-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'output');
    const index = { state: {} };
    let start = 0;
    const ranges = [];
    for (const chunk of ['<<human-', 'report>>\nRăspuns util.\n<<human-', 'report>>']) {
        await fs.appendFile(file, chunk);
        const end = start + Buffer.byteLength(chunk);
        ranges.push(...await advanceSummaryFile(file, index, { start, end, assistant: true, complete: chunk === 'report>>', outputId: 'one' }));
        start = end;
    }
    const bytes = await fs.readFile(file);
    assert.deepEqual(ranges.map(range => bytes.subarray(range.start, range.end).toString()), ['Răspuns util.\n']);
});

test('workflow payloads work inside reports and alongside a separate report', () => {
    const graph = { edges: [{ id: 'done', sourceTaskId: 'review', targetTaskId: 'end' }] };
    const payload = { message: 'Changes verified.', nextEdgeId: 'done', workflows: [{ workflowTypeId: 'default', prompt: 'Check the result.' }] };
    assert.deepEqual(extractJson(report(JSON.stringify(payload))), payload);
    assert.deepEqual(extractJson(report('```json\n' + JSON.stringify(payload) + '\n```')), payload);
    for (const text of [report('# message\nChanges verified.\n# nextEdgeId\ndone'), report(JSON.stringify(payload)), JSON.stringify(payload) + '\n' + report('Changes verified.'),
        report('Changes verified.') + '\n# nextEdgeId\ndone', report('Changes verified.') + '\n' + JSON.stringify(payload)]) {
        assert.equal(parseRoute(text, graph, 'review').nextEdgeId, 'done');
    }
    assert.throws(() => parseRoute(report('# nextEdgeId\ninvalid'), graph, 'review'));
});

test('the debug log view appends the complete final response once when it was not streamed', async () => {
    const { runInNewContext } = await import('node:vm');
    const source = (await fs.readFile(new URL('../public/log-render.js', import.meta.url), 'utf8'))
        .replace(/^import .*\n/, '').replace('export function', 'function');
    const final = report('Verified.') + '\n\n# nextEdgeId\ndone';
    for (const log of ['Working...', 'Working...\n\n' + final]) {
        const calls = [];
        const sandbox = { renderTaskLog: (_container, text, _empty, task) => calls.push({ text, task }) };
        runInNewContext(source, sandbox);
        sandbox.renderLog({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 }, log, final);
        assert.equal(calls[0].text, 'Working...\n\n' + final);
        const { finalOutputOffset: offset, finalOutputLength: length } = calls[0].task;
        assert.equal(calls[0].text.slice(offset, offset + length), final);
    }
});

test('the report contract opens a session once; resumed turns and queued messages carry only the user text', async () => {
    for (const text of [buildNativePrompt({ prompt: 'Question' }), buildTaskPrompt({ task: 'Work', systemPrompt: 'Routing' }), buildTaskPrompt({ task: 'Follow up' })]) {
        assert.ok(text.includes(HUMAN_REPORT_INSTRUCTIONS));
    }
    assert.equal(buildNativePrompt({ prompt: 'Continue', resume: true }), 'Continue');
    const task = { robotId: 'robot', state: 'starting', controlReady: false, pendingMessages: [] };
    const manager = { tasks: new Map([['task', task]]) };
    const result = await RuntimeManager.prototype.sendTaskMessage.call(manager, { id: 'robot' }, 'task', 'Check again');
    assert.equal(result.delivery, 'queued');
    // The copilot engine wraps live messages once before they reach ALA.
    assert.equal(task.pendingMessages[0].message, 'Check again');
});

test('required skill resolves the renamed source as enabled and read-only', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'required-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const skill = path.join(root, 'skills', 'human-report');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: human-report\ndescription: Final response\n---\nReport.');
    const entry = await requiredHumanReportSkill({ repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'workspace' }] }, discover: async () => [{ name: 'human-report', description: 'Final response' }] });
    assert.equal(entry.identity, 'required/human-report');
    assert.equal(entry.sourcePath, skill);
    for (const flag of ['enabled', 'required', 'readOnly']) assert.equal(entry[flag], true);
});

test('chat text drops report marker lines, keeps the report and fenced examples', () => {
    assert.equal(withoutSummaryMarkers('<<human-report>>\nAll done.\n<<human-report>>'), 'All done.');
    assert.equal(withoutSummaryMarkers('{"edge":"a"}\n\n<<human-report>>\nRouted.\n<<human-report>>\n'), '{"edge":"a"}\n\nRouted.');
    const fenced = 'Example:\n```\n<<human-report>>\n```';
    assert.equal(withoutSummaryMarkers(fenced), fenced);
    assert.equal(withoutSummaryMarkers('No markers here.\n'), 'No markers here.\n');
    assert.equal(withoutSummaryMarkers('Inline <<human-report>> text'), 'Inline <<human-report>> text');
});
