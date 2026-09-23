import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
test('workflow board edits, generated drafts, saved layout and coverage refresh work in a browser', { timeout: 30000 }, async t => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-browser-'));
    let saved = [], matching = false;
    const coverage = graph => ({ warning: !matching && graph.tasks.some(task => task.skillsets.length), tasks: graph.tasks.map(task => ({ taskId: task.id, matchingRobotIds: matching || !task.skillsets.length ? ['robot'] : [] })) });
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = raw ? JSON.parse(raw) : {};
            const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
            if (url.pathname === '/auth/token') return json({ browserMutation: { csrfToken: 'test', routeKey: 'roboTeamAgent' } });
            if (url.pathname === '/api/robots') return json({ robots: [], canAdmin: true });
            if (url.pathname === '/api/roboflow/skillsets') return json({ skillsets: [{ id: 'repo/set', name: 'Review', repositoryName: 'Repo', description: 'Review changes' }], diagnostics: [] });
            if (url.pathname === '/api/roboflow/validate') return json({ coverage: coverage(body), diagnostics: [] });
            if (url.pathname === '/api/roboflow/workflows') {
                if (req.method === 'POST') { saved.push({ ...body, id: 'saved', revision: 1 }); return json({ workflow: saved.at(-1) }); }
                return json({ workflows: saved.map(graph => ({ ...graph, coverage: coverage(graph) })) });
            }
            if (url.pathname === '/test-robot') { matching = true; return json({ ok: true }); }
            if (url.pathname === '/config.js') { res.setHeader('content-type', 'text/javascript'); return res.end('globalThis.ROBOTEAM_CONFIG={publicBasePath:"/",routeKey:"roboTeamAgent"};'); }
            if (url.pathname === '/MCPBrowserClient.js') {
                res.setHeader('content-type', 'text/javascript');
                return res.end(`export const createAgentClient = () => ({ close: async () => {}, callTool: async (name, input, options) => { globalThis.calledGenerator = {name,input}; options.onTaskUpdate({id:'generation',status:'running'}); return { content: [{ type:'text',text:JSON.stringify({graph:{name:'Generated',description:'Generated graph',entryTaskId:'generated',tasks:[{id:'generated',name:'Generated task',description:'Do it',skillsets:[],executionType:'browser'}],edges:[],layout:{generated:{x:70,y:70}}}}) }] }; } });`);
            }
            const file = path.join(publicRoot, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
            if (!file.startsWith(publicRoot)) { res.statusCode = 404; return res.end(); }
            res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
            res.end(await fs.readFile(file));
        } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let ws;
    t.after(async () => { ws?.close(); chrome.kill('SIGTERM'); await new Promise(resolve => server.close(resolve)); await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    const browserEndpoint = await new Promise((resolve, reject) => {
        let text = ''; chrome.stderr.on('data', chunk => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); }); chrome.on('error', reject); chrome.on('exit', code => reject(new Error(`Chrome exited ${code}`)));
    });
    const debugRoot = browserEndpoint.replace(/^ws:/, 'http:').split('/devtools/')[0];
    const targets = await (await fetch(`${debugRoot}/json`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    let serial = 0; const requests = new Map();
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); const request = requests.get(message.id); if (request) { requests.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); } });
    const call = (method, params) => new Promise((resolve, reject) => { const id = ++serial; requests.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + JSON.stringify(result.exceptionDetails.exception));
        return result.result.value;
    };
    const wait = async expression => { for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(`Browser condition failed: ${expression}`); };
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait('document.querySelector("#addWorkflowButton")?.onclick && !document.querySelector("#addWorkflowButton").disabled');
    await evaluate('document.querySelector("#addWorkflowButton").click()');
    await wait('document.querySelector("#workflowDialog").open');
    const addTask = async (name, description) => {
        await evaluate('document.querySelector("#addTaskButton").click()');
        await wait('document.querySelector("#addTaskDialog").open');
        await evaluate(`(() => { const f = document.querySelector("#addTaskForm"); f.elements.name.value=${JSON.stringify(name)}; f.elements.description.value=${JSON.stringify(description)}; f.requestSubmit(); })()`);
        await wait('!document.querySelector("#addTaskDialog").open');
    };
    await addTask('Task one', 'First task');
    await addTask('Task two', 'Second task');
    assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 2);
    await evaluate('document.querySelector("#taskList .task-list-item").click()');
    await evaluate('document.querySelector("#workflowForm").elements.name.value="Manual"; document.querySelector("#workflowForm").elements.name.dispatchEvent(new Event("input")); document.querySelector(".task-editor input").value="Review"; document.querySelector(".task-editor input").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelector(".graph-node strong").textContent'), 'Review');
    await evaluate('document.querySelector("#workflowBoard").scrollIntoView({block:"center"})');
    const points = await evaluate(`(() => { const port=document.querySelector('.graph-port').getBoundingClientRect(), target=document.querySelectorAll('.graph-node')[1].getBoundingClientRect(); return {sx:port.x+port.width/2,sy:port.y+port.height/2,tx:target.x+50,ty:target.y+30}; })()`);
    await call('Input.dispatchMouseEvent', {type:'mousePressed', x:points.sx, y:points.sy, button:'left', clickCount:1});
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:points.tx, y:points.ty, buttons:1});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:points.tx, y:points.ty, button:'left', clickCount:1});
    assert.equal(await evaluate('document.querySelectorAll(".graph-edge").length'), 1);
    await evaluate('document.querySelector("#workflowBoard").scrollIntoView({block:"center"})');
    const origin = await evaluate(`(() => { const box=document.querySelector('.graph-node').getBoundingClientRect(); return {x:box.x+30,y:box.y+60}; })()`);
    assert.equal(await evaluate(`document.elementFromPoint(${origin.x},${origin.y})?.closest('.graph-node') !== null`), true, JSON.stringify(origin));
    await call('Input.dispatchMouseEvent', {type:'mousePressed', ...origin, button:'left', clickCount:1});
    await call('Input.dispatchMouseEvent', {type:'mouseMoved', x:origin.x+20, y:origin.y+10, buttons:1});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', x:origin.x+20, y:origin.y+10, button:'left', clickCount:1});
    await evaluate('document.querySelector(".graph-node").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    await wait('document.querySelector(".skillset-option input")');
    await evaluate('document.querySelector(".skillset-option input").click()');
    await wait('document.querySelector("#workflowMessage").textContent.includes("No robot")');
    await evaluate('document.querySelector("#workflowCreateButton").click()');
    await wait('!document.querySelector("#workflowDialog").open');
    assert.equal(saved.length, 1); assert.equal(saved[0].edges.length, 1); assert.equal(Object.values(saved[0].layout)[0].x, 70);
    await wait('document.querySelector(".workflow-warning")');
    await evaluate('fetch("/test-robot").then(()=>window.dispatchEvent(new Event("focus")))');
    await wait('!document.querySelector(".workflow-warning")');
    await evaluate('document.querySelector("#workflowsList button").click()');
    await wait('document.querySelectorAll(".graph-node").length===2');
    assert.equal(await evaluate('document.querySelector(".graph-node").style.left'), '70px');
    await evaluate('document.querySelector("#generationDescription").value="Generate a browser task"; document.querySelector("#generateWorkflow").click()');
    await wait('document.querySelector(".graph-node strong")?.textContent==="Generated task"');
    assert.equal(await evaluate('globalThis.calledGenerator.name'), 'roboflow_generate_workflow');
    assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 1);
});
