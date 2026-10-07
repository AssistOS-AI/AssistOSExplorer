import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkflowResponse, parseRoute, workflowResponseContext } from '../server/roboflow/result-parser.mjs';
import { normalizeWorkflow } from '../server/roboflow/graph.mjs';
import { generationPrompt, creatorPrompt, routingPrompt } from '../copilot/src/lib/prompts.mjs';

const graph = { edges: [{ id: 'Go', sourceTaskId: 'a', targetTaskId: 'b' }] };
const report = text => `<<human-report>>\n${text}\n<<human-report>>`;
const parseGraph = text => parseWorkflowResponse(text, { generation: true });
const draft = '# name\nExample\n# description\nA draft\n# entryTaskId\na\n# task\na\n# name\nFirst\n# executionType\nterminal\n# skillsets\n# prompt\nDo the work.';

test('routing accepts header depth, casing, separators, closing hashes and quoted IDs', () => {
    for (let depth = 1; depth <= 6; depth++) {
        for (const key of ['nextEdgeId', 'NEXTEDGE', 'Edge', 'next_edge_id', 'Next-Edge-Id', 'Next Edge Id']) {
            for (const value of ['Go', '"Go"', "'Go'", '`Go`', '```text\nGo\n```']) {
                const source = `\uFEFF${'#'.repeat(depth)}${key}: ###\n${value}\n`;
                assert.equal(parseRoute(source.replaceAll('\n', '\r\n'), graph, 'a').nextEdgeId, 'Go');
            }
        }
    }
    assert.throws(() => parseRoute('# edge\ngo', graph, 'a'), /not outgoing/);
    assert.equal(parseRoute('# nextEdgeId\nGo\n# EDGE\nGo', graph, 'a').nextEdgeId, 'Go');
});

test('creator Markdown returns ordered objects and preserves multiline prompts without JSON escaping', () => {
    const prompt = 'Inspect "quoted" values and C:\\work.\n\n## Acceptance criteria\n  Keep indentation.\nworkflowName#prompt is text.';
    const parsed = parseWorkflowResponse(report(`# message\nA plan\n# nextEdgeId\nGo\n# after-workflows-edge-id\nAfter\n##Workflow\ndefault\n# execution_type\nterminal\n# Prompt\n${prompt}\n# WORKFLOW\nreview\n# prompt\nVerify it.`));
    assert.deepEqual(parsed, {
        message: 'A plan', nextEdgeId: 'Go', afterWorkflowsEdgeId: 'After',
        workflows: [{ workflowTypeId: 'default', executionType: 'terminal', prompt }, { workflowTypeId: 'review', prompt: 'Verify it.' }],
    });
    assert.deepEqual(parseWorkflowResponse('# workflows\n# workflow\n# workflowTypeId\nreview\n# prompt\nCheck').workflows,
        [{ workflowTypeId: 'review', prompt: 'Check' }]);
});

test('fenced prose protects all reserved headings, embedded code and human-report examples', () => {
    const literal = '# workflow\nfake\n# nextEdgeId\nwrong\n# prompt\nExample:\n```js\nconst a = "quoted";\n```\n<<human-report>>\n  indented\n<<human-report>>';
    for (const fence of ['````', '~~~~']) {
        const parsed = parseWorkflowResponse(report(`# message\n${fence}markdown\n# nextEdgeId\nwrong\n${fence}\n# nextEdgeId\nGo\n# workflow\nreview\n# prompt\n${fence}text\n${literal}\n${fence}`));
        assert.equal(parsed.message, '# nextEdgeId\nwrong');
        assert.equal(parsed.nextEdgeId, 'Go');
        assert.deepEqual(parsed.workflows, [{ workflowTypeId: 'review', prompt: literal }]);
    }
    const mixed = parseWorkflowResponse('# nextEdgeId\nGo\n# message\nExample:\n```markdown\n# nextEdgeId\nwrong\n```\nEnd.');
    assert.equal(mixed.message, 'Example:\n```markdown\n# nextEdgeId\nwrong\n```\nEnd.');
});

test('complete Markdown wrappers and historical report placement remain accepted', () => {
    for (const source of ['# nextEdgeId\nGo', '```markdown\n# nextEdgeId\nGo\n```', '~~~md\n# nextEdgeId\nGo\n~~~']) {
        assert.equal(parseRoute(source, graph, 'a').nextEdgeId, 'Go');
        assert.equal(parseRoute(report(source), graph, 'a').nextEdgeId, 'Go');
        assert.equal(parseRoute(source + '\n' + report('Done'), graph, 'a').nextEdgeId, 'Go');
        assert.equal(parseRoute(report('Done') + '\n\n' + source, graph, 'a').nextEdgeId, 'Go');
    }
});

test('downstream context separates human findings from structured output without losing ordinary answers', () => {
    const branching = { tasks: [{ id: 'a' }, { id: 'b' }], edges: [...graph.edges, { id: 'Retry', sourceTaskId: 'a', targetTaskId: 'a' }] };
    const payload = '# nextEdgeId\nGo';
    for (const source of [report('Verified the changes.') + '\n\n' + payload, payload + '\n\n' + report('Verified the changes.')]) {
        assert.deepEqual(workflowResponseContext(source, branching, 'a'), { response: payload, humanReport: 'Verified the changes.' });
    }
    for (const [source, response] of [[payload, payload], [report(payload), payload], [report('{"nextEdgeId":"Go"}'), '{"nextEdgeId":"Go"}']]) {
        assert.deepEqual(workflowResponseContext(source, branching, 'a'), { response });
    }
    const answer = 'Plain answer with a literal routing example:\n# nextEdgeId\nGo';
    assert.deepEqual(workflowResponseContext(report(answer), branching, 'b'), { response: answer });
    assert.deepEqual(workflowResponseContext('Unmarked answer', branching, 'b'), { response: 'Unmarked answer' });
    const creator = { tasks: [{ id: 'a', creator: true }], edges: graph.edges };
    assert.deepEqual(workflowResponseContext(report('Delegate.') + '\n' + payload, creator, 'a'), { response: payload, humanReport: 'Delegate.' });
});

test('JSON fallback supports decisions, child plans and graph objects without changing prose', () => {
    const input = { Message: 'Literal "quotes"\n# workflow\nnot a child', Edge: 'Go', afterWorkflowsEdgeId: 'After',
        workflows: [{ workflowTypeId: 'default', executionType: 'terminal', prompt: '```\n# prompt\n```' }] };
    for (const source of [JSON.stringify(input), '```JSON\n' + JSON.stringify(input, null, 2) + '\n```', 'Legacy result:\n~~~json\n' + JSON.stringify(input) + '\n~~~']) {
        const parsed = parseWorkflowResponse(report(source));
        assert.equal(parsed.nextEdgeId, 'Go');
        assert.equal(parsed.message, input.Message);
        assert.deepEqual(parsed.workflows, input.workflows);
    }
    const expected = normalizeWorkflow(parseGraph(draft));
    expected.name = 'The "Example"';
    expected.tasks[0].name = '"Quoted name"';
    assert.deepEqual(normalizeWorkflow(parseGraph(JSON.stringify(expected))), expected);
});

test('generation produces typed task, edge and layout objects', () => {
    const source = draft.replace('# skillsets\n', '# skillsets\n- `repo/build`\n* "repo/review"\n')
        + '\n# allows_human_input\nTRUE\n# creator\nfalse'
        + '\n##TASK\nb\n# name\nSecond\n# executionType\nbrowser\n# skillsets\n[]\n# prompt\nVerify.'
        + '\n# edge\nGo\n# sourceTaskId\na\n# targetTaskId\nb\n# sourcePort\nleft\n# targetPort\nright'
        + '\n# layout\n# position\na\n# x\n120.5\n# y\n240';
    const parsed = parseGraph(source);
    assert.deepEqual(parsed.tasks[0].skillsets, ['repo/build', 'repo/review']);
    assert.equal(parsed.tasks[0].allowsHumanInput, true);
    assert.equal(parsed.tasks[0].creator, false);
    assert.deepEqual(parsed.edges, [{ id: 'Go', sourceTaskId: 'a', targetTaskId: 'b', sourcePort: 'left', targetPort: 'right' }]);
    assert.deepEqual(parsed.layout, { a: { x: 120.5, y: 240 } });
    assert.equal(normalizeWorkflow(parsed).tasks.length, 2);
    assert.deepEqual(normalizeWorkflow(parseGraph(draft)).edges, []);
    assert.deepEqual(parseGraph(draft.replace('# skillsets\n', '# skillsets\n`repo/build`\n`repo/review`\n')).tasks[0].skillsets,
        ['repo/build', 'repo/review']);
});

test('generated task prompts protect nested routing examples and managed coordinator fields', () => {
    const prompt = 'Return:\n# nextEdgeId\nGo\n# task\nThis is an example.\n```js\nconst x = 1;\n```';
    const source = draft.replace('Do the work.', `~~~~text\n${prompt}\n~~~~`)
        + '\n# creator\ntrue\n# task\nrun-workflows\n# name\nRun workflows\n# kind\nrun-workflows\n# skillsets'
        + '\n# edge\nGo\n# sourceTaskId\na\n# targetTaskId\nrun-workflows';
    const parsed = normalizeWorkflow(parseGraph(source));
    assert.equal(parsed.tasks[0].prompt, prompt);
    assert.equal(parsed.tasks[1].kind, 'run-workflows');
});

test('ambiguous or malformed fields fail instead of choosing a partial response', () => {
    for (const source of [
        '# nextEdgeId\nGo\n# Edge\nother', '{"Edge":"Go","nextEdgeId":"other"}',
        '# nextEdgeId\nGo\n# misspelled\nother', '# nextEdgeId\nGo\n# workflow\n',
        '# nextEdgeId\nGo\n# workflow\nfirst\n# prompt\n```text\nunclosed',
        '# nextEdgeId\nGo\n# prompt\nNo workflow', '# nextEdgeId\nGo\nExtra prose',
        '[]', 'null', '```json\n{"Edge":"Go"}\n```\n```json\n{"Edge":"other"}\n```',
    ]) assert.throws(() => parseWorkflowResponse(source), { statusCode: 400, message: /^Error parsing response: ".+"$/ }, source);
    for (const suffix of ['\n# creator\nyes', '\n# position\na\n# x\nNaN', '\n# task',
        '\n# position\na\n# x\n1\n# position\na\n# x\n2']) {
        assert.throws(() => parseGraph(draft + suffix), { statusCode: 400, message: /^Error parsing response: ".+"$/ });
    }
});

test('conflicting prompts identify response parsing and retain the payload line number', () => {
    const source = '# workflow\ndefault\n# prompt\nFirst prompt.</think># workflow\ndefault\n# prompt\nSecond prompt.';
    assert.throws(() => parseWorkflowResponse(report('Plan ready.') + '\n\n' + source), {
        statusCode: 400,
        message: 'Error parsing response: "Conflicting prompt in line 6"',
    });
});

test('structured Markdown wins over JSON examples inside prose', () => {
    const parsed = parseWorkflowResponse('# message\nExample:\n```json\n{"nextEdgeId":"wrong"}\n```\n# nextEdgeId\nGo');
    assert.equal(parsed.nextEdgeId, 'Go');
    assert.match(parsed.message, /wrong/);
});

test('generation prompt example is parseable and system instructions request Markdown', () => {
    const prompt = generationPrompt({ skillsets: [] });
    const example = prompt.split('Technical payload example, placed after the human report:\n')[1];
    assert.equal(normalizeWorkflow(parseGraph(example)).tasks.length, 2);
    for (const text of [prompt, creatorPrompt(graph, 'a', []), routingPrompt(graph, 'a')]) {
        assert.match(text, /Markdown/);
        assert.doesNotMatch(text, /Return one JSON object/);
        assert.match(text, /fenced text block/);
        assert.match(text, /human report first/);
        assert.match(text, /after the closing marker/);
    }
});
