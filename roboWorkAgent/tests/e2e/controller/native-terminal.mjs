import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { assertAdminToken, privateJson, prerequisite } from './auth-session.mjs';
import { assertNoMarker, selectAgent, sha256 } from './contracts.mjs';

const ID = /^[A-Za-z0-9_-]{32}$/u;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const requireSmoke = createRequire(new URL('../../../../tests/smoke/package.json', import.meta.url));

// This is one finite I10 command, sent through the real WebTTY input route.
// It stays alive until the controller has independently joined its /proc identity
// to the private recovery receipt, then exits normally on the one-time release.
export const NATIVE_PROBE = String.raw`
const fs=require('node:fs'), input=JSON.parse(process.argv[1]);
const stat=fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ');
let denial=null, readable=false;
try { fs.readFileSync(input.project+'/victim-link/marker-B'); readable=true; }
catch(error) { denial=error.code; }
const out={nonce:input.nonce,home:process.env.HOME,user:process.env.USER,cwd:process.cwd(),
    pid:process.pid,startToken:stat[19],pidNamespace:fs.readlinkSync('/proc/self/ns/pid'),
    tty:process.stdin.isTTY===true&&process.stdout.isTTY===true,
    profileEnv:Object.keys(process.env).some(key=>key.startsWith('PLOINKY_')),
    link:fs.readlinkSync(input.project+'/victim-link'),readable,denial};
console.log('I10_'+'NATIVE_'+input.nonce+' '+Buffer.from(JSON.stringify(out)).toString('base64'));
const timer=setTimeout(()=>process.exit(91),45000);
process.stdin.once('data',data=>{clearTimeout(timer);process.exit(data.toString().trim()===input.release?0:92);});
`;

export function assertNativeReceipt(record, target, profile, project) {
    assert.equal(record?.schema, 'ploinky-webtty-recovery/v2');
    assert.equal(record.targetKind, 'agent');
    assert.equal(record.ptyState, 'pty-ready', 'Native terminal receipt is not ready.');
    assert.equal(record.cleanupState, undefined, 'Native terminal cleanup was already unproven.');
    assert.deepEqual(record.target, target, 'Native terminal targets a foreign container or generation.');
    assert.match(record.marker || '', /^[A-Za-z0-9_-]{24,128}$/u);
    assert.equal(record.agent?.marker, record.marker);
    assert.equal(record.agent?.containerId, target.containerId);
    assert.equal(record.agentStartup?.containerId, target.containerId);
    assert.equal(record.agentStartup?.marker, record.marker);
    assert.equal(record.agent?.translatedCwd, project);
    assert.equal(record.agentStartup?.translatedCwd, project);
    assert.equal(record.agentStartup?.profile?.provider, 'roboWorkAgent');
    assert.equal(record.agentStartup?.profile?.id, profile);
    assert.equal(typeof record.agentStartup?.translatedHome, 'string');
    assert.equal(record.agentStartup.translatedHome.endsWith(`/terminal/${profile.split('.')[0]}`), true);
    assert.match(record.agent.execId || '', /^[a-f0-9]{64}$/u);
    for (const row of [record.worker, record.agent.clientProcess]) {
        assert.ok(Number.isSafeInteger(row?.pid) && row.pid > 1);
        assert.match(row.startToken || '', /^linux-proc:[1-9][0-9]*$/u);
    }
    for (const key of ['innerPid', 'boxPid', 'innerSessionId']) assert.ok(Number.isSafeInteger(record.agent.innerProcess?.[key])
        && record.agent.innerProcess[key] > 1, 'Native receipt process anchor is incomplete.');
    for (const key of ['innerStartToken', 'boxStartToken']) assert.match(record.agent.innerProcess[key] || '', /^linux-proc:[1-9][0-9]*$/u);
    return record;
}

export function assertNativeObservation(observed, expected, processProof) {
    assert.equal(observed?.nonce, expected.nonce, 'Native response nonce differs.');
    assert.equal(observed.home, `/home/${expected.attacker}`, 'Native HOME differs.');
    assert.equal(observed.user, expected.attacker);
    assert.equal(observed.cwd, expected.project, 'Native cwd differs.');
    assert.equal(observed.tty, true, 'Native command has no controlling TTY.');
    assert.equal(observed.profileEnv, false, 'Outer profile environment reached the command.');
    assert.equal(observed.link, `/data/robots/${expected.victim}/home`);
    assert.equal(observed.readable, false, 'Native sandbox read the victim through the workspace link.');
    assert.ok(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(observed.denial), 'Native read did not produce an exact filesystem denial.');
    assert.match(observed.pidNamespace || '', /^pid:\[[1-9][0-9]*\]$/u);
    assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
    assert.match(observed.startToken || '', /^[1-9][0-9]*$/u);
    assert.equal(processProof?.nonce, expected.nonce);
    assert.equal(processProof.innerPid, observed.pid);
    assert.equal(processProof.startToken, observed.startToken);
    assert.equal(processProof.pidNamespace, observed.pidNamespace);
    assert.match(processProof.serviceNamespace || '', /^pid:\[[1-9][0-9]*\]$/u);
    assert.notEqual(processProof.pidNamespace, processProof.serviceNamespace, 'Command used the unsandboxed RoboWork process namespace.');
    assert.equal(processProof.homeMatches, true, 'Native home is not the owned RoboWork home.');
    assert.equal(processProof.ttyMatches, true);
    assert.equal(processProof.receiptAncestor, true, 'Native command is not a descendant of this receipt.');
}

async function records(runtime) {
    return JSON.parse(await runtime.box(['node', '--input-type=module', '-e', `
        import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
        const root='/run/ploinky/webtty'; const st=fs.lstatSync(root);
        if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&511)!==448||st.uid!==process.getuid()) throw Error('Unsafe receipt directory');
        const rows=fs.readdirSync(root).sort().map(name=>{
            if(!/^[A-Za-z0-9_-]{20,80}\\.json$/.test(name)) throw Error('Unexpected receipt entry');
            const file=path.join(root,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
            let bytes;
            try {const s=fs.fstatSync(fd);
                if(!s.isFile()||s.nlink!==1||(s.mode&511)!==384||s.uid!==process.getuid()||s.size>16384) throw Error('Unsafe receipt');
                bytes=fs.readFileSync(fd); const after=fs.fstatSync(fd);
                for(const key of ['dev','ino','size','mtimeMs','ctimeMs']) if(s[key]!==after[key]) throw Error('Receipt changed');
            } finally {fs.closeSync(fd);}
            const r=JSON.parse(bytes.toString('utf8'));
            const pick=(value,keys)=>value?Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])):null;
            const agent=pick(r.agent,['containerId','marker','translatedCwd','execId']);
            if(agent) {agent.clientProcess=pick(r.agent.clientProcess,['pid','startToken']);
                agent.innerProcess=pick(r.agent.innerProcess,['boxPid','boxStartToken','innerPid','innerStartToken','innerSessionId']);}
            const startup=pick(r.agentStartup,['containerId','marker','translatedCwd','translatedHome']);
            if(startup) startup.profile=pick(r.agentStartup.profile,['provider','id','label']);
            return {name,hash:crypto.createHash('sha256').update(bytes).digest('hex'),record:{schema:r.schema,targetKind:r.targetKind,ptyState:r.ptyState,
                target:pick(r.target,['runtime','containerId','containerName','instanceId','enableGeneration']),
                marker:r.marker,worker:pick(r.worker,['pid','startToken']),agent,agentStartup:startup,
                ...(r.cleanupState?{cleanupState:r.cleanupState}:{})}};
        }); console.log(JSON.stringify(rows));
    `]));
}

async function processProof(runtime, input) {
    return runtime.node(runtime.config.rw, `
        const rows=[]; const self=fs.readlinkSync('/proc/self/ns/pid');
        for(const name of fs.readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/.test(name))) {
            const base='/proc/'+name;
            try {
                const args=fs.readFileSync(base+'/cmdline','utf8').split('\\0');
                if(args.length!==5||args[4]!==''||args[0]!==input.executable||args[1]!=='-e'||args[2]!==input.code||args[3]!==input.argument) continue;
                if(fs.realpathSync(base+'/exe')!==input.executable) throw Error('Wrong native executable');
                const stat=fs.readFileSync(base+'/stat','utf8').split(') ').at(-1).split(' ');
                const status=fs.readFileSync(base+'/status','utf8'),nspid=status.match(/^NSpid:\\s+(.+)$/m);
                if(!nspid) throw Error('Missing namespace PID');
                const env=fs.readFileSync(base+'/environ','utf8').split('\\0');
                if(!env.includes('HOME=/home/'+input.attacker)||fs.realpathSync(base+'/cwd')!==input.project) throw Error('Wrong native process');
                const home=fs.statSync(base+'/root/home/'+input.attacker),owned=fs.statSync('/data/robots/'+input.attacker+'/home');
                let pid=Number(name),receiptAncestor=false;
                for(let depth=0;depth<32&&pid>1;depth++) {
                    const s=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');
                    if(pid===input.anchor.innerPid&&s[19]===input.anchor.innerStartToken.replace(/^linux-proc:/,'')) {receiptAncestor=true;break;}
                    pid=Number(s[1]);
                }
                const after=fs.readFileSync(base+'/stat','utf8').split(') ').at(-1).split(' ');
                if(after[19]!==stat[19]) throw Error('Native identity changed');
                const members=[];
                for(const entry of fs.readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/.test(name))) {
                    try {const s=fs.readFileSync('/proc/'+entry+'/stat','utf8').split(') ').at(-1).split(' ');
                        if(Number(s[3])===input.anchor.innerSessionId) members.push({pid:Number(entry),startToken:s[19]});}
                    catch(error) {if(!['ENOENT','ESRCH'].includes(error.code)) throw error;}
                }
                if(!members.some(row=>row.pid===Number(name))) throw Error('Native process left receipt session');
                rows.push({pid:Number(name),innerPid:Number(nspid[1].trim().split(/\\s+/).at(-1)),startToken:stat[19],members,
                    nonce:input.nonce,pidNamespace:fs.readlinkSync(base+'/ns/pid'),serviceNamespace:self,
                    ttyMatches:/^\\/dev\\/pts\\/[0-9]+$/.test(fs.readlinkSync(base+'/fd/0'))&&Number(stat[4])!==0,
                    homeMatches:home.dev===owned.dev&&home.ino===owned.ino,receiptAncestor});
            } catch(error) {if(!['ENOENT','ESRCH'].includes(error.code)) throw error;}
        }
        if(rows.length!==1) throw Error('Missing or ambiguous native nonce process'); console.log(JSON.stringify(rows[0]));
    `, input);
}

export function assertNativeCleanup(result) {
    assert.equal(result?.recordAbsent, true, 'Owned terminal receipt remains.');
    assert.equal(result.processesAbsent, true, 'Owned terminal process remains.');
    assert.equal(result.execAbsent, true, 'Owned terminal ExecID remains.');
    assert.equal(result.stubEmpty, true, 'Owned terminal stub is not empty.');
    assert.equal(result.sessionAbsent, true, 'Owned terminal session remains.');
}

async function cleanupProof(runtime, baseline, receipt, native, attacker, stubOwner) {
    assert.deepEqual(await records(runtime), baseline, 'Terminal receipt inventory did not return to baseline.');
    const anchors = [{ pid: receipt.record.worker.pid, token: receipt.record.worker.startToken },
        { pid: receipt.record.agent.clientProcess.pid, token: receipt.record.agent.clientProcess.startToken },
        { pid: receipt.record.agent.innerProcess.boxPid, token: receipt.record.agent.innerProcess.boxStartToken }];
    await runtime.box(['node', '-e', `const fs=require('node:fs'),rows=JSON.parse(process.argv[1]);
        for(const row of rows) {try {const fields=fs.readFileSync('/proc/'+row.pid+'/stat','utf8').split(') ').at(-1).split(' ');
            if('linux-proc:'+fields[19]===row.token) throw Error('Owned terminal process remains');}
            catch(error) {if(error.code!=='ENOENT'&&error.code!=='ESRCH') throw error;}} console.log('true');`, JSON.stringify(anchors)]);
    await runtime.node(runtime.config.rw, `
        for(const row of input.native?.members||[]) {try {const fields=fs.readFileSync('/proc/'+row.pid+'/stat','utf8').split(') ').at(-1).split(' ');
            if(fields[19]===row.startToken) throw Error('Owned terminal session member remains');}
            catch(error) {if(error.code!=='ENOENT'&&error.code!=='ESRCH') throw error;}}
        const stub=path.join(input.workspace,'.data/roboWorkAgent/terminal',input.attacker),st=fs.lstatSync(stub);
        if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||fs.readdirSync(stub).length
            ||st.dev!==input.stubOwner.dev||st.ino!==input.stubOwner.ino) throw Error('Nonempty or changed terminal stub');
        console.log('true');`, { native, workspace: runtime.config.workspace, attacker, stubOwner });
    const inspection = JSON.parse(await runtime.box(['podman', 'inspect', runtime.config.rw]));
    assert.equal(inspection.length, 1); assert.equal(inspection[0].Id, runtime.config.rw);
    assert.ok(Array.isArray(inspection[0].ExecIDs) && !inspection[0].ExecIDs.includes(receipt.record.agent.execId), 'Owned terminal ExecID remains.');
    return { recordAbsent: true, processesAbsent: true, execAbsent: true, stubEmpty: true };
}

export async function nativeSymlinkControl(runtime, { attacker, project, victim }) {
    if (!runtime.auth?.principalHash || !runtime.probes?.owned?.has(attacker)) {
        throw prerequisite('I10 needs the authenticated controller and its newly provisioned robot receipt.');
    }
    let chromium;
    try { ({ chromium } = requireSmoke('@playwright/test')); }
    catch { throw prerequisite('I10 requires the existing tests/smoke @playwright/test dependency and Chromium.'); }
    const [containerName, row] = selectAgent(runtime.registry, runtime.config.rw, 'roboWorkAgent');
    const target = { runtime: 'podman', containerId: row.containerId, containerName,
        instanceId: row.instanceId, enableGeneration: row.enableGeneration };
    const identity = await runtime.verify();
    const executable = await runtime.node(runtime.config.rw, 'console.log(JSON.stringify(fs.realpathSync(process.execPath)));');
    assert.ok(typeof executable === 'string' && executable.startsWith('/') && !executable.includes('\0'));
    const profile = `${attacker}.default`, nonce = randomUUID(), release = randomUUID();
    const expected = { attacker, project, victim: runtime.config.victim, nonce };
    const argument = JSON.stringify({ ...expected, release });
    const baseline = await records(runtime);
    let browser, context, page, sessionId, receipt, native, result, primary, stubOwner,
        created = false, launched = false, cleanup;
    const state = await privateJson(runtime.config.explorer.storageState);
    try {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ storageState: state });
        page = await context.newPage(); page.setDefaultTimeout(30000);
        await page.goto(`${runtime.auth.origin}/webtty/`);
        const auth = await page.evaluate(async () => { const r=await fetch('/auth/token', {signal:AbortSignal.timeout(30000)}); return {status:r.status,body:await r.json()}; });
        assert.equal(auth.status, 200);
        assert.equal(assertAdminToken(auth.body), runtime.auth.principalHash, 'Browser and controller principals differ.');
        const selected = await page.evaluate(async ({ profile, project, attacker }) => {
            const api=await import('/base-agent-additional-server/roboTeamAgent/3001/terminal.js');
            const prepared=await api.prepareRobotTerminal(profile);
            if(prepared?.ok!==true||prepared.id!==profile||prepared.root!=='.data/roboWorkAgent/terminal/'+attacker) throw Error('Wrong profile preparation');
            return (await api.discoverRobotTerminal(project,profile)).url;
        }, { profile, project: project.slice(runtime.config.workspace.length + 1), attacker });
        assert.match(selected, /^\/webtty\/#launch=[A-Za-z0-9_-]{32}$/u);
        stubOwner = await runtime.node(runtime.config.rw, `
            const stub=path.join(input.workspace,'.data/roboWorkAgent/terminal',input.attacker),st=fs.lstatSync(stub);
            if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||fs.readdirSync(stub).length) throw Error('Unsafe prepared stub');
            console.log(JSON.stringify({dev:st.dev,ino:st.ino}));`, { workspace: runtime.config.workspace, attacker });
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/webtty/sessions'
            && response.request().method() === 'POST');
        launched = true;
        await page.goto(new URL(selected, runtime.auth.origin).href);
        const response = await responsePromise;
        created = response.status() === 201;
        const payload = await response.json();
        sessionId = ID.test(payload?.session?.id || '') ? payload.session.id : null;
        assert.equal(response.status(), 201, 'Normal WebTTY launch did not create a terminal.');
        assert.ok(sessionId, 'Created terminal identity is unavailable.');
        assert.equal(payload.ok, true); assert.equal(payload.session.role, 'owner');
        assert.equal(payload.session.target?.kind, 'agent');
        assert.equal(payload.session.target?.detail, 'AchillesIDE/roboWorkAgent');
        assert.equal(payload.session.target?.access, 'rw');
        assert.equal(payload.session.target?.cwdDisplay, project);
        assert.equal(response.request().postDataJSON().launch, selected.split('=')[1], '201 response belongs to a different launch.');
        const newRecords = (await records(runtime)).filter(entry => !baseline.some(old => old.name === entry.name));
        assert.equal(newRecords.length, 1, 'Launch receipt is missing or ambiguous.');
        receipt = newRecords[0];
        assertNativeReceipt(receipt.record, target, profile, project);
        assert.equal(receipt.record.agentStartup.profile.label, payload.session.profileLabel);
        assert.equal(payload.session.profileLabel, runtime.probes.owned.get(attacker).name);
        const input = async data => {
            const reply=await page.evaluate(async ({id,data}) => {const r=await fetch('/webtty/sessions/'+id+'/input',{
                method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data}),signal:AbortSignal.timeout(30000)});return {status:r.status,body:await r.json()};}, { id: sessionId, data });
            assert.ok(reply.status===200&&reply.body?.ok===true, 'Native terminal input was refused.');
        };
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
        const code = `eval(Buffer.from(${JSON.stringify(Buffer.from(NATIVE_PROBE).toString('base64'))},'base64').toString())`;
        const command = `${quote(executable)} -e ${quote(code)} ${quote(argument)}; i10_status=$?; printf '\\nI10_EXIT_${nonce} %s\\n' "$i10_status"; exit "$i10_status"\r`;
        await input(command);
        await page.waitForFunction(prefix => {
            const text=document.querySelector('#terminal .xterm-rows')?.textContent||'';
            const part=text.slice(text.indexOf(prefix)+prefix.length).match(/^[A-Za-z0-9+/=]+/u)?.[0];
            if(!text.includes(prefix)||!part) return false;
            try {JSON.parse(atob(part));return true;} catch {return false;}
        }, `I10_NATIVE_${nonce} `);
        const text = await page.locator('#terminal .xterm-rows').textContent();
        assertNoMarker(text, victim.markerHash, victim.markerLength);
        const match = new RegExp(`I10_NATIVE_${nonce} ([A-Za-z0-9+/=]+)`, 'u').exec(text);
        assert.ok(match, 'Native command did not produce a nonce response.');
        const observed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
        native = await processProof(runtime, { ...expected, argument, code, executable, anchor: receipt.record.agent.innerProcess });
        assertNativeObservation(observed, expected, native);
        await input(`${release}\r`);
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Closed');
        const ended = await page.locator('#terminal .xterm-rows').textContent();
        assertNoMarker(ended, victim.markerHash, victim.markerLength);
        assert.ok(ended.includes(`I10_EXIT_${nonce} 0`), 'Native command did not exit zero.');
        assert.equal(await page.locator('#message').textContent(), 'Terminal closed: terminal_clean.');
        result = { nonce, sessionId, target, profile, commandHash: sha256(command), codeHash: sha256(code),
            markerHash: sha256(receipt.record.marker), native, denial: observed.denial, exitCode: 0 };
    } catch (error) { primary = error; }
    finally {
        try {
            // Exit through the owned session even when receipt readiness failed.
            // Never force DELETE or erase a quarantined recovery record.
            if (sessionId && page && !result) {
                await page.evaluate(async ({id,release}) => {await fetch('/webtty/sessions/'+id+'/input',{
                    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data:release+'\rexit 1\r'}),signal:AbortSignal.timeout(30000)});}, { id: sessionId, release });
            }
            if (launched) {
                assert.ok(sessionId && receipt, 'Owned launch cleanup identity is incomplete; retain fixture.');
                for (let attempt=0;attempt<40;attempt++) {
                    try { cleanup=await cleanupProof(runtime,baseline,receipt,native,attacker,stubOwner); break; }
                    catch (error) {if(attempt===39) throw error;await delay(250);}
                }
                const listed=await page.evaluate(async () => {const r=await fetch('/webtty/live-sessions', {signal:AbortSignal.timeout(30000)});return {status:r.status,body:await r.json()};});
                assert.ok(listed.status===200&&listed.body?.ok===true&&listed.body.available!==false&&Array.isArray(listed.body.sessions));
                assert.ok(!listed.body.sessions.some(row=>row.id===sessionId&&row.status!=='exited'), 'Owned terminal remains live.');
                cleanup.sessionAbsent=true; assertNativeCleanup(cleanup);
            }
            assert.deepEqual(await runtime.verify(), identity, 'Runtime/source identity changed during native control.');
        } catch (error) {
            primary = Object.assign(new Error('Native terminal cleanup is unproven; retain owned robot and project.'), {
                code: 'CONTROLLER_CLEANUP_FAILED', evidence: { nativeTerminal: { cleanupConfirmed: false, attacker, project, sessionId,
                    created, receiptName: receipt?.name, target, primaryFailureCode: primary?.code || primary?.name, failureCode: error.code || error.name } },
            });
            runtime.retainedNativeTerminal = primary.evidence.nativeTerminal;
        }
        try { await context?.close(); await browser?.close(); }
        catch { primary ||= Object.assign(new Error('Native terminal browser cleanup failed.'), { code: 'CONTROLLER_CLEANUP_FAILED' }); }
    }
    if (primary) throw primary;
    return { ...result, cleanup };
}
