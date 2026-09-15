import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOnlyOfficeEditor, clearOnlyOfficeEditor, isOnlyOfficeEditorActive } from '../../services/onlyoffice/onlyoffice-editor-host.js';
const base='http://localhost:8080/base-agent-additional-server/onlyOffice/8080';
const config={document:{key:'first',title:'first.docx',fileType:'docx'},documentServerUrl:base};
function fixture(){
 const prior={window:globalThis.window,document:globalThis.document};
 const images=[];let children=[];
 const host={isConnected:true,set textContent(v){children=[];},get textContent(){return '';},appendChild(child){children.push(child);return child;},querySelector(s){return children.find(c=>s==='iframe'?c.tagName==='IFRAME':s==='.onlyoffice-editor-frame'?c.className==='onlyoffice-editor-frame':false)||null;}};
 globalThis.document={createElement(tagName){return {tagName:tagName.toUpperCase(),className:'',id:''};}};
 globalThis.window={Image:class{constructor(){images.push(this);}},DocsAPI:{DocEditor:class{constructor(){children=[{tagName:'IFRAME',src:base+'/9.3.1-build/web-apps/apps/documenteditor/main/index.html'}];}destroyEditor(){children=[];}}}};
 return{host,images,restore(){for(const [k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}},};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('concurrent same-session render also waits for the in-flight required asset',async()=>{
 const f=fixture();let secondDone=false;
 try{
  const first=renderOnlyOfficeEditor(f.host,config);await tick();
  assert.equal(f.images.length,1);
  const second=renderOnlyOfficeEditor(f.host,config).then(()=>{secondDone=true;});
  await tick();
  const premature=secondDone;
  f.images[0].onload();await Promise.all([first,second]);
  assert.equal(premature,false,'second render returned while status SVG was still pending');
 }finally{f.restore();}
});
test('failed required preload cannot leave a reusable ready editor',async()=>{
 const f=fixture();
 try{
  const first=renderOnlyOfficeEditor(f.host,config);const failure=assert.rejects(first,/could not load/);
  await tick();f.images[0].onerror();await failure;
  assert.equal(isOnlyOfficeEditorActive(f.host,config),false,'preload-failed editor is incorrectly reusable');
 }finally{f.restore();}
});
test('superseded preload failure cannot reject after another session becomes current',async()=>{
 const f=fixture();
 try{
  const first=renderOnlyOfficeEditor(f.host,config).then(()=>({ok:true}),error=>({ok:false,message:error.message}));
  await tick();const oldImage=f.images[0];
  const newer=renderOnlyOfficeEditor(f.host,{...config,document:{...config.document,key:'second'}});
  await tick();assert.equal(f.images.length,2);
  f.images[1].onload();await newer;
  oldImage.onerror();const oldOutcome=await first;
  assert.equal(oldOutcome.ok,true,'obsolete image failure leaked into superseded render result');
 }finally{f.restore();}
});


test('an async editor mount retains its original configuration when caller state changes during script loading', async () => {
 const f = fixture();
 const mutable = { ...config, document: { ...config.document } };
 try {
  const mounting = renderOnlyOfficeEditor(f.host, mutable).then(() => ({ ok: true }), error => ({ ok: false, message: error.message }));
  // Presenter state is live: selecting/reloading a file can clear it while
  // loadScript yields, even when the editor API is already cached.
  mutable.documentServerUrl = '';
  mutable.document.key = 'changed';
  await tick();
  if (f.images[0]) f.images[0].onload();
  const result = await mounting;
  assert.equal(result.ok, true, result.message);
  assert.equal(f.images.length, 1);
  assert.equal(f.images[0].src, base + '/9.3.1-build/web-apps/apps/common/main/resources/img/controls/warnings_s.svg');
  assert.equal(isOnlyOfficeEditorActive(f.host, config), true);
 } finally { f.restore(); }
});
