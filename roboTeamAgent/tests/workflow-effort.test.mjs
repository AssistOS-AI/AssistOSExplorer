import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskEffortSelect, workflowCopy} from '../public/workflow-editor.js';
import {WorkflowFiles} from '../server/roboflow/workflow-files.mjs';
import {normalizeWorkflow} from '../server/roboflow/graph.mjs';

// The native select's event callback is exercised directly; no browser library is required.
const document = {createElement(tag) {return {tag,children:[],attributes:{},append(child) {this.children.push(child);},setAttribute(name,value) {this.attributes[name]=value;}};}};
const task = effort => ({id:'check',name:'Check',prompt:'Check the package',executionType:'terminal',skillsets:[],...(effort ? {effort} : {})});
const graph = step => ({id:'effort-example',schemaVersion:2,name:'Example',description:'Check package',entryTaskId:step.id,tasks:[step],edges:[],layout:{}});

test('editor defaults to robot settings, changes levels and removes the override when inheritance is selected', () => {
    const step=task();let changes=0;
    const select=createTaskEffortSelect(step,()=>{changes++;},document);
    assert.equal(select.value,'');
    assert.equal(select.children[0].textContent,'Use robot settings');
    assert.equal(select.attributes['aria-label'],'Reasoning effort');
    select.value='high';select.onchange();assert.equal(step.effort,'high');
    select.value='low';select.onchange();assert.equal(step.effort,'low');
    select.value='';select.onchange();assert.equal(Object.hasOwn(step,'effort'),false);
    assert.equal(changes,3);
});

test('opening a saved task retains its selected level, including native levels outside the presets', () => {
    for (const value of ['low','medium','high','xhigh','max','provider-specific']) {
        const step=task(value);const select=createTaskEffortSelect(step,()=>{},document);
        assert.equal(select.value,value);assert.ok(select.children.some(option=>option.value===value));
        assert.equal(step.effort,value);
    }
});

test('editor choices survive normalization, file save, reopen and Save as; inheritance omits effort in JSON',async t => {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workflow-effort-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const files=new WorkflowFiles({workspaceRoot:root});
    const step=task();const select=createTaskEffortSelect(step,()=>{},document);
    select.value='medium';select.onchange();
    const saved=await files.createIn(root,normalizeWorkflow(graph(step)));
    assert.equal(saved.error,undefined);assert.equal(saved.graph.tasks[0].effort,'medium');
    const reopened=createTaskEffortSelect(saved.graph.tasks[0],()=>{},document);
    assert.equal(reopened.value,'medium');
    const copy=workflowCopy(saved.graph);assert.equal(copy.tasks[0].effort,'medium');
    const copied=await files.createIn(root,normalizeWorkflow(copy));
    assert.equal(copied.graph.tasks[0].effort,'medium');
    reopened.value='';reopened.onchange();
    await files.write(saved,saved.graph);
    const json=JSON.parse(await fs.readFile(saved.file,'utf8'));
    assert.equal(Object.hasOwn(json.tasks[0],'effort'),false);
    assert.equal(createTaskEffortSelect(files.readSync(saved.file).graph.tasks[0],()=>{},document).value,'');
});
