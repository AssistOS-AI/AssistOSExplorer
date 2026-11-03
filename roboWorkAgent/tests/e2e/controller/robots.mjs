import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const FREE_MODEL = 'soul-gateway/openrouter-free/nvidia/nemotron-3-ultra-550b-a55b:free';
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

export function assertFreeConfig(config) {
    assert.ok(config?.ok === true, 'Robot configuration request failed.');
    assert.equal(config.codingAgent, 'opencode', 'Probe is not configured for OpenCode.');
    assert.equal(config.models?.opencode, FREE_MODEL, 'Probe would use an unapproved model or fallback.');
    // CLI availability is not model selection. A freshly provisioned robot may
    // still be downloading its tools; no availability=false result is erased.
}

export class ProbeRobots {
    constructor(runtime) { this.runtime = runtime; this.owned = new Map(); this.evidence = []; }
    get session() { assert.ok(this.runtime.auth, 'Authenticated controller session is required.'); return this.runtime.auth; }

    async list() {
        const result = await this.session.roboTeam('GET', 'api/robots');
        assert.ok(result.status === 200 && result.payload?.ok === true && result.payload.canAdmin === true
            && Array.isArray(result.payload.robots), 'Administrator robot registry listing is unavailable.');
        return result.payload.robots;
    }

    async configure(id) {
        assert.match(id || '', ID);
        const result = await this.session.roboTeam('PATCH', `api/robots/${id}/coding-agents`,
            { codingAgents: ['opencode'], model: FREE_MODEL });
        assert.ok(result.status === 200 && result.payload?.ok === true, 'Normal RoboTeam model PATCH failed.');
        const current = await this.session.roboTeam('GET', `api/robots/${id}/coding-agents`);
        assert.equal(current.status, 200); assertFreeConfig(current.payload);
        const evidence = { robotId: id, model: FREE_MODEL, route: `api/robots/${id}/coding-agents`,
            method: 'PATCH+GET', proofGeneration: result.proofGeneration };
        this.evidence.push(evidence); return evidence;
    }

    async setup({ includeVictim = true } = {}) {
        const robots = await this.list();
        const defaults = robots.filter(robot => robot.name === 'default');
        assert.equal(defaults.length, 1, 'Default robot registry identity is missing or ambiguous.');
        await this.configure(defaults[0].id);
        if (includeVictim) {
            assert.equal(robots.filter(robot => robot.id === this.runtime.config.victim).length, 1,
                'Victim must be a real RoboTeam registry robot.');
            await this.configure(this.runtime.config.victim);
        }
    }

    async create(prefix) {
        const name = `controller-${String(prefix).slice(0, 28)}-${randomUUID()}`;
        const robots = await this.list();
        assert.ok(!robots.some(robot => robot.name === name));
        const result = await this.session.roboTeam('POST', 'api/robots', { name, codingAgents: ['opencode'] });
        assert.ok(result.status === 201 && result.payload?.ok === true, 'Normal RoboTeam probe creation failed.');
        const robot = result.payload.robot;
        assert.match(robot?.id || '', ID); assert.equal(robot.name, name);
        assert.ok(!robots.some(row => row.id === robot.id), 'Created probe reused a preexisting robot identity.');
        // Ownership is recorded before PATCH so a failed setup still has one
        // exact normal-API cleanup target. Never adopt caller-selected IDs.
        assert.equal(typeof robot.createdAt, 'string');
        this.owned.set(robot.id, { name, createdAt: robot.createdAt });
        await this.configure(robot.id);
        return robot.id;
    }

    async remove(id) {
        const owner = this.owned.get(id); assert.ok(owner, 'Probe deletion requires this invocation’s creation receipt.');
        const metadata = await this.runtime.node(this.runtime.config.rt, `
            const file='/data/robots/'+input.id+'/metadata.json'; const stat=fs.lstatSync(file);
            if(!stat.isFile()||stat.isSymbolicLink()) throw Error('Unsafe probe metadata');
            const robot=JSON.parse(fs.readFileSync(file,'utf8'));
            console.log(JSON.stringify({id:robot.id,name:robot.name,createdAt:robot.createdAt}));`, { id });
        assert.deepEqual(metadata, { id, ...owner }, 'Probe registry ownership changed.');
        const result = await this.session.roboTeam('POST', 'api/control', { robotId: id, operation: 'robot-delete' });
        assert.ok(result.status === 200 && result.payload?.ok === true && result.payload.deleted === owner.name,
            'Normal RoboTeam probe cleanup failed.');
        await this.runtime.node(this.runtime.config.rt, `
            try {fs.lstatSync('/data/robots/'+input.id); throw Error('Deleted probe registry remains');}
            catch(error) {if(error.code!=='ENOENT') throw error;} console.log('true');`, { id });
        await this.runtime.node(this.runtime.config.rw, `
            try {fs.lstatSync('/data/robots/'+input.id); throw Error('Deleted probe home remains');}
            catch(error) {if(error.code!=='ENOENT') throw error;} console.log('true');`, { id });
        this.owned.delete(id);
        return { ok: true, result: { deleted: true } };
    }

    async cleanup() {
        const errors = [];
        for (const id of this.owned.keys()) {
            try { await this.remove(id); } catch { errors.push(id); }
        }
        assert.deepEqual(errors, [], 'One or more normally provisioned probes could not be cleaned up.');
    }
}
