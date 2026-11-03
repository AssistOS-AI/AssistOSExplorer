import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertBox, selectAgent, sha256, validateConfig, normalizeMcpOutcome } from './contracts.mjs';

const execute = promisify(execFile);
const nodeScript = (body, input) => ['node', '--input-type=module', '-e', body, JSON.stringify(input)];
const prelude = 'import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; const input=JSON.parse(process.argv[1]);';

// Command output remains private: inspect and MCP payloads can contain secrets.
export class ControllerRuntime {
    constructor(config) { this.config = validateConfig(config); this.receipts = []; }

    async command(command, args, options = {}) {
        try {
            const result = await execute(command, args, { timeout: 200000, maxBuffer: 16 * 1024 * 1024, ...options });
            this.receipts.push({ command: path.basename(command), argumentHash: sha256(JSON.stringify(args)), outputHash: sha256(result.stdout) });
            return result.stdout;
        } catch (error) {
            this.receipts.push({ command: path.basename(command), argumentHash: sha256(JSON.stringify(args)),
                failed: true, code: typeof error.code === 'number' ? error.code : 'COMMAND_FAILED',
                outputHash: sha256(String(error.stdout || '')), diagnosticHash: sha256(String(error.stderr || '')) });
            throw Object.assign(new Error('Controller command failed; private command output withheld.'), { code: 'CONTROLLER_COMMAND_FAILED' });
        }
    }

    box(args) { return this.command(this.config.engine, ['exec', this.config.box.id, ...args]); }
    inner(id, args) { return this.box(['podman', 'exec', id, ...args]); }
    async node(id, body, input = {}) { return JSON.parse(await this.inner(id, nodeScript(prelude + body, input))); }

    async verify() {
        const c = this.config;
        assert.equal(await fs.realpath(c.fixture), c.fixture, 'Fixture must be canonical, without symlink aliases.');
        const fixture = await fs.lstat(c.fixture);
        assert.ok(fixture.isDirectory() && !fixture.isSymbolicLink());
        const box = JSON.parse(await this.command(c.engine, ['inspect', c.box.id]));
        assert.equal(box.length, 1); assertBox(c, box[0]);
        await this.verifyRevision(c.ploinkyRoot, c.ploinkyRevision);
        const ownership = await import(pathToFileURL(path.join(c.ploinkyRoot, 'cli/sandbox/docker/containerOwnership.js')).href);
        this.registry = JSON.parse(await this.box(nodeScript(prelude + 'console.log(fs.readFileSync(path.join(input.workspace,".ploinky/agents.json"),"utf8"));', c)));
        assert.ok(this.registry && typeof this.registry === 'object' && !Array.isArray(this.registry));
        this.inspections = new Map();
        const workspaceHash = sha256(c.workspace).slice(0, 12);
        for (const [name, row] of Object.entries(this.registry).filter(([, row]) => row.type === 'agent')) {
            assert.equal(row.runtime, 'podman', 'Unsupported enabled-agent runtime.');
            assert.match(row.containerId || '', /^[a-f0-9]{64}$/u);
            const result = JSON.parse(await this.box(['podman', 'inspect', row.containerId]));
            assert.equal(result.length, 1);
            ownership.assertExactContainerOwnership(name, row, result[0], row.containerId, workspaceHash);
            assert.equal(result[0].State?.Running, true, 'Enabled agent is not running.');
            this.inspections.set(row.containerId, result[0]);
        }
        selectAgent(this.registry, c.rt, 'roboTeamAgent'); selectAgent(this.registry, c.rw, 'roboWorkAgent');
        const alaRoot = await this.node(c.rw, `
            const {resolveAlaCommand}=await import('/code/server/ala-command.mjs');
            console.log(JSON.stringify(path.dirname(path.dirname(fs.realpathSync(resolveAlaCommand())))));
        `);
        assert.equal(c.sources.find(source => source.role === 'ala').runtimePath, alaRoot,
            'Selected ALA path is not the installation RoboWork actually resolves.');
        const sdkRoot = await this.node(c.rt, 'console.log(JSON.stringify(process.env.PLOINKY_AGENT_LIB_DIR||"/Agent"));');
        await this.verifyFiles({ root: c.ploinkyRoot, subdir: 'Agent', runtimePath: sdkRoot }, c.rt);
        for (const source of c.sources) {
            await this.verifyRevision(source.root, source.revision);
            await this.verifyFiles(source, source.role === 'rt' ? c.rt : c.rw);
        }
        return { fixture: { dev: fixture.dev, ino: fixture.ino }, box: c.box, rt: c.rt, rw: c.rw,
            agents: Object.entries(this.registry).filter(([, row]) => row.type === 'agent').map(([name, row]) => ({
                name, id: row.containerId, instanceId: row.instanceId, enableGeneration: row.enableGeneration,
            })).sort((a, b) => a.name.localeCompare(b.name)),
            sources: c.sources.map(({ role, revision }) => ({ role, revision })) };
    }

    async verifyFiles(source, containerId) {
        const listed = await this.command('git', ['-C', source.root, 'ls-files', '-z', '--', source.subdir || '.']);
        const files = listed.split('\0').filter(Boolean).map(file => path.posix.relative(source.subdir || '.', file));
        assert.ok(files.length > 0);
        const expected = [];
        for (const file of files) {
            const local = path.join(source.root, source.subdir, file);
            const stat = await fs.lstat(local);
            assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Unsupported tracked source entry.');
            expected.push([file, stat.isSymbolicLink() ? 'link' : 'file', stat.isSymbolicLink()
                ? await fs.readlink(local) : sha256(await fs.readFile(local))]);
        }
        const observed = await this.node(containerId, `
            console.log(JSON.stringify(input.files.map(([file])=>{
                const target=path.join(input.root,file); const stat=fs.lstatSync(target);
                if(!stat.isFile()&&!stat.isSymbolicLink()) throw Error('Unsafe source');
                return [file,stat.isSymbolicLink()?'link':'file',stat.isSymbolicLink()?fs.readlinkSync(target)
                    :crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')];
            })));
        `, { files: expected, root: source.runtimePath });
        assert.deepEqual(observed, expected, 'Runtime source differs from frozen source revision.');
    }

    async verifyRevision(root, revision) {
        assert.equal((await this.command('git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), revision, 'Wrong source revision.');
        assert.equal((await this.command('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'])).trim(), '', 'Dirty source revision.');
    }

    async mcp(tool, input) {
        // Inherit the genuine RT process environment and canonical SDK. No actor,
        // callback grant, token, or claimed caller is accepted from runner config.
        return this.node(this.config.rt, `
            const normalize=${normalizeMcpOutcome.toString()};
            const {pathToFileURL}=await import('node:url');
            const {createAgentClient}=await import(pathToFileURL(path.join(process.env.PLOINKY_AGENT_LIB_DIR||'/Agent','client/AgentMcpClient.mjs')).href);
            try {
                const client=await createAgentClient('roboWorkAgent');
                const result=await client.callTool(input.tool,input.input,{timeoutMs:180000});
                console.log(JSON.stringify(normalize(result)));
            } catch(error) { console.log(JSON.stringify(normalize(null,{code:error.code,message:error.message}))); }
        `, { tool, input });
    }

    async snapshot(id) {
        return this.node(this.config.rw, `
            const root='/data/robots/'+input.id+'/home';
            const rootStat=fs.lstatSync(root); if(!rootStat.isDirectory()||rootStat.isSymbolicLink()) throw Error('Unsafe victim home');
            const marker=path.join(root,'marker-B'); const st=fs.lstatSync(marker);
            if(!st.isFile()||st.isSymbolicLink()||st.size===0||st.size>4096) throw Error('Missing marker control');
            const rows=[]; function walk(file,relative) {
                const stat=fs.lstatSync(file); let content='';
                if(stat.isSymbolicLink()) content=fs.readlinkSync(file);
                else if(stat.isFile()) content=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
                else if(!stat.isDirectory()) throw Error('Unsupported victim tree entry');
                rows.push([relative,stat.mode,content]);
                if(stat.isDirectory()) for(const name of fs.readdirSync(file).sort()) walk(path.join(file,name),path.join(relative,name));
            } walk(root,'.');
            console.log(JSON.stringify({markerHash:crypto.createHash('sha256').update(fs.readFileSync(marker)).digest('hex'),markerLength:st.size,treeHash:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),entries:rows.length}));
        `, { id });
    }
}
