import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=(await fs.readFile(new URL('../public/dashboard/billing.mjs',import.meta.url),'utf8'))
    .replace('export class UserpersistoBillingPresenter','class UserpersistoBillingSettings');
const keys=['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PUBLISHABLE_KEY'];
const saved={STRIPE_SECRET_KEY:'sk_tes********test',STRIPE_WEBHOOK_SECRET:'whsec_********test',STRIPE_PUBLISHABLE_KEY:'pk_test_public'};
function fixture({admin=true,call}={}){
    const calls=[];
    const inputs=keys.map((key,index)=>({dataset:{billingKey:key},type:index<2?'password':'text',value:'',required:index>=2}));
    const form={hidden:true,reportValidity:()=>true},controls={disabled:true},status={dataset:{}},webhook={};
    const nodes={'[data-billing-form]':form,'[data-billing-controls]':controls,'[data-billing-status]':status,'[data-webhook-url]':webhook};
    const element={querySelector:key=>nodes[key],querySelectorAll:()=>inputs};
    const Controller=vm.runInNewContext(source+'\nUserpersistoBillingSettings;',{URL,location:{origin:'http://localhost:8080'}});
    const callTool=async(name,args={})=>{calls.push({agent:'userPersistoAgent',name,args});return call?call(name,args):name==='userpersisto_profile_get'?{capabilities:admin?['admin.agentSettings.manage']:[]}:saved;};
    return {panel:new Controller(element,()=>{},callTool),calls,inputs,form,controls,status,webhook};

}

test('Explorer exposes a separate administrator Stripe settings component and preserves personal account entry',async()=>{
    const manifest=JSON.parse(await fs.readFile(new URL('../manifest.json',import.meta.url),'utf8'));
    const entry=manifest.ideSettings.find(item=>item.key==='userpersisto-billing-settings');
    assert.equal(entry.adminOnly,true);assert.equal(entry.settingsComponent,'userpersisto-billing-settings');assert.equal(entry.settingsUrl,undefined);
    assert.equal(manifest.ideSettings[0].key,'userpersisto-settings','Marketplace Configure preserves the existing UserPersisto navigation');
    assert.ok(manifest.ideSettings.find(item=>item.key==='userpersisto-settings').settingsUrl);
});
test('Stripe settings contain only provider secrets and never replay their masked placeholders',async()=>{
    const f=fixture();await f.panel.beforeRender();await f.panel.afterRender();
    assert.equal(f.form.hidden,false);assert.equal(f.controls.disabled,false);
    for(const input of f.inputs.slice(0,2)){assert.equal(input.value,'');assert.equal(input.required,false);assert.match(input.placeholder,/Configured/);}
    assert.match(f.webhook.value,/userPersistoAgent\/7000\/service\/billing\/stripe\/webhook$/);
    await f.panel.saveConnection();
    assert.deepEqual(Object.keys(f.calls.at(-1).args),['STRIPE_PUBLISHABLE_KEY']);
    f.inputs[0].value='sk_test_replacement';await f.panel.saveConnection();
    assert.equal(f.calls.at(-1).args.STRIPE_SECRET_KEY,'sk_test_replacement');assert.equal(f.inputs[0].value,'');
    f.inputs[1].value='whsec_unsaved';f.panel.afterUnload();assert.equal(f.inputs[1].value,'');assert.equal(f.form.hidden,true);
});
test('Stripe configuration refuses non-administrators and has no manual return-address inputs',async()=>{
    const member=fixture({admin:false});await member.panel.afterRender();assert.equal(member.calls.length,1);assert.equal(member.form.hidden,true);
    const html=await fs.readFile(new URL('../IDE-plugins/userpersisto-billing-settings/userpersisto-billing-settings.html',import.meta.url),'utf8');
    assert.doesNotMatch(html,/USERPERSISTO_BILLING_|type="url" data-billing-key/);
});
test('closing a Stripe form ignores late settings responses and cannot enable or refill it',async()=>{
    let resolve;
    const f=fixture({call:name=>name==='userpersisto_profile_get'?{capabilities:['admin.agentSettings.manage']}:new Promise(done=>{resolve=done;})});
    const pending=f.panel.afterRender();await new Promise(done=>setImmediate(done));f.panel.afterUnload();resolve(saved);await pending;
    assert.equal(f.controls.disabled,true);assert.equal(f.form.hidden,true);assert.equal(f.inputs[0].value,'');
});


test('existing UserPersisto pages retain every original destination and add Stripe alongside them',async()=>{
    for(const name of ['index.html','users.html','roles.html','applications.html','authentication.html','billing.html']){
        const html=await fs.readFile(new URL('../public/dashboard/'+name,import.meta.url),'utf8');
        for(const path of ['users.html','roles.html','applications.html','authentication.html','billing.html'])assert.ok(html.includes('href="'+path+'"'),name+' must link '+path);
    }
});
