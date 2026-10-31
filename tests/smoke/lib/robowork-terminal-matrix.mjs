import fs from 'node:fs';
import path from 'node:path';

// Synthetic protected-name matrix: plain, folded, default-ignorable and nested spellings.
export function extendTerminalFixture(root) {
    const files = ['.env', 'master-key', 'x.secrets', '.ENV.', 'MASTER-KEY ', 'x.SECRETS', '.e\u200bnv', 'sub/deep/.env'];
    const directories = ['.ploinky', '.data', '.ploinky-box', '.roboteam', '.PLOINKY.', '.DATA ', '.ROBOTEAM', 'sub/deep/.data'];
    for (const relative of files) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), 'SYNTHETIC-PROTECTED-CONTENT\n');
    }
    for (const relative of directories) {
        fs.mkdirSync(path.join(root, relative), { recursive: true });
        fs.writeFileSync(path.join(root, relative, 'fixture.txt'), 'SYNTHETIC-PROTECTED-CONTENT\n');
    }
    fs.mkdirSync(path.join(root, 'late'), { recursive: true });
    return { files, directories };
}

// Runs as a real program inside the terminal, returning byte counts/error codes, never protected file contents.
// Targets come from the trusted worker-side inventory and have independently measured positive controls.
export function terminalMatrixSource({ files, directories, targets = [] }) {
    return `
        import fs from 'node:fs';
        import net from 'node:net';
        import { spawnSync } from 'node:child_process';
        const attempt = (fn) => { try { return fn(); } catch(e) { return e.code; } };
        const out = { files:{}, directories:{}, network:{}, homeNames:fs.readdirSync('/home').sort() };
        for(const file of ${JSON.stringify(files)}) out.files[file] = {
            bytes:attempt(() => fs.readFileSync(file).length),
            write:attempt(() => { fs.appendFileSync(file,'x'); return 'WROTE'; }),
            remove:attempt(() => { fs.unlinkSync(file); return 'REMOVED'; }),
            rename:attempt(() => { fs.renameSync(file,file+'.moved'); return 'MOVED'; }),
        };
        for(const dir of ${JSON.stringify(directories)}) out.directories[dir] = {
            entries:attempt(() => fs.readdirSync(dir).length),
            write:attempt(() => { fs.writeFileSync(dir+'/new','x'); return 'WROTE'; }),
            remove:attempt(() => { fs.rmdirSync(dir); return 'REMOVED'; }),
            rename:attempt(() => { fs.renameSync(dir,dir+'.moved'); return 'MOVED'; }),
        };
        out.rootWrite = attempt(() => { fs.writeFileSync('/run/robo-work/new','x'); return 'WROTE'; });
        out.normalWrite = attempt(() => { fs.writeFileSync('ordinary-terminal-control.txt','ok'); const text=fs.readFileSync('ordinary-terminal-control.txt','utf8'); fs.unlinkSync('ordinary-terminal-control.txt'); return text; });
        out.proc = Object.fromEntries(['/proc/kcore','/proc/keys','/proc/timer_list','/proc/sysrq-trigger'].map(file => [file,attempt(() => { const f=fs.openSync(file,'r'); const b=Buffer.alloc(1); try { return fs.readSync(f,b,0,1,0); } finally { fs.closeSync(f); } })]));
        const nr=process.arch==='arm64'?219:250;
        const k=spawnSync('perl',['-e','my $r = syscall('+nr+', 0, 0, 0, 0, 0); print "$r ", $!+0'],{encoding:'utf8'});
        out.keyctl=k.error ? 'MISSING_PERL' : k.stdout.trim();
        const tcp=(host,port)=>new Promise(resolve=>{ let done=false; const s=net.connect({host,port,timeout:1500}); const end=v=>{if(!done){done=true;s.destroy();resolve(v)}}; s.on('connect',()=>end('connected'));s.on('error',e=>end(e.code));s.on('timeout',()=>end('timeout')); });
        for(const [name,host,port] of ${JSON.stringify(targets)}) out.network[name]=await tcp(host,port);
        const publicReply=await fetch('https://opencode.ai',{signal:AbortSignal.timeout(15000)}).then(async r=>{await r.body?.cancel();return {status:r.status}}).catch(e=>({error:e.cause?.code||e.name}));
        out.https=publicReply;
        console.log(JSON.stringify(out));
    `;
}

export const networkInventorySource = `
    import os from 'node:os';
    import dns from 'node:dns/promises';
    import net from 'node:net';
    const tcp=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port,timeout:1500});s.on('connect',()=>{s.destroy();resolve('connected')});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();resolve('timeout')});});
    const worker=Object.entries(os.networkInterfaces()).filter(([name])=> !/^(lo|rw)/.test(name)).flatMap(([,a])=>a).find(a=>a.family==='IPv4'&&!a.internal)?.address;
    const router=await dns.lookup(process.env.PLOINKY_ROUTER_HOST||'host.containers.internal',{family:4}).then(a=>a.address).catch(()=>null);
    if(!worker||!router)throw Error('Worker/Router network addresses unavailable');
    const targets=[['coordinator',worker,7000],['providerLoopback','127.0.0.1',7300],['router8080',router,8080],['router8081',router,8081]];
    const controls={};for(const [name,host,port] of targets)controls[name]=await tcp(host,port);
    console.log(JSON.stringify({targets,controls}));
`;
