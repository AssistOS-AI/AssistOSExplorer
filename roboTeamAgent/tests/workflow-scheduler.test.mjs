import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';

const definition = { id: 'scheduled', name: 'Scheduled work', entryTaskId: 'one', tasks: [{ id: 'one', name: 'Work', executionType: 'terminal', prompt: 'Run the objective', skillsets: [] }], edges: [] };
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-scheduler-')));
    let now = Date.parse('2026-10-09T07:00:00Z');
    const robot = { id: 'default-id', name: 'default', codingAgents: ['opencode'] }, started = [];
    const runtimeManager = { resolveCwd: async folder => { if (!folder.startsWith(root)) throw new Error('Folder outside workspace'); return folder; },
        startTask: (robot, type, request) => { started.push(request); return { taskId: request.runtimeTaskId }; }, stopTask() {} };
    const service = new RoboFlowService({ databaseFile: path.join(root, 'roboflow.sqlite'), workspaceRoot: root,
        robotStore: { list: async () => [robot], getByName: async () => robot }, runtimeManager,
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        scheduleNow: () => now, schedulePollMs: 2147480000 });
    await service.initialize(); await service.presetReady; await service.createWorkflow(definition); service.scheduler.start();
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    const create = (extra = {}) => service.saveSchedule({ name: 'Hourly report', workflowTypeId: 'scheduled', folder: root, objective: 'Write the report', timing: { kind: 'interval', everyMinutes: 60 }, ...extra }, 'admin');
    return { service, root, started, create, advance: minutes => { now += minutes * 60000; }, now: () => now };
}
test('durable Cron jobs create ordinary workflow snapshots and do not launch twice on concurrent ticks', async t => {
    const f = await fixture(t), job = await f.create();
    assert.equal(job.nextRunAt, '2026-10-09T08:00:00.000Z'); assert.equal(job.createdBy, 'admin'); assert.equal(job.pendingLaunch, undefined);
    await f.service.scheduler.tick(); assert.equal(f.started.length, 0);
    f.advance(60); await Promise.all([f.service.scheduler.tick(), f.service.scheduler.tick()]);
    assert.equal(f.started.length, 1);
    const current = (await f.service.listSchedules())[0], flow = await f.service.store.get(current.lastFlowId);
    assert.equal(current.lastOutcome, 'started'); assert.equal(current.lastFlowStatus, 'running');
    assert.equal(flow.scheduleId, job.id); assert.equal(flow.scheduledAt, '2026-10-09T08:00:00.000Z'); assert.equal(flow.createdBy, 'admin');
    assert.equal(flow.graph.id, 'scheduled'); assert.equal(flow.objective, 'Write the report');
    assert.equal(current.nextRunAt, '2026-10-09T09:00:00.000Z');
});
test('running and paused scheduled flows skip subsequent slots; completion permits a future run', async t => {
    const f = await fixture(t); await f.create(); f.advance(60); await f.service.scheduler.tick();
    let job = (await f.service.listSchedules())[0];
    f.advance(60); await f.service.scheduler.tick(); assert.equal(f.started.length, 1); assert.equal((await f.service.listSchedules())[0].lastOutcome, 'skipped');
    await f.service.store.update(job.lastFlowId, flow => { flow.status = 'paused'; });
    f.advance(60); await f.service.scheduler.tick(); assert.equal(f.started.length, 1);
    await f.service.store.update(job.lastFlowId, flow => { flow.status = 'completed'; });
    f.advance(60); await f.service.scheduler.tick(); assert.equal(f.started.length, 2);
});
test('disable, optimistic editing and removal preserve a previously started workflow', async t => {
    const f = await fixture(t), original = await f.create(); f.advance(60); await f.service.scheduler.tick();
    const disabled = await f.service.saveSchedule({ revision: original.revision, enabled: false }, 'other-admin', original.id);
    assert.equal(disabled.nextRunAt, null); assert.equal(disabled.createdBy, 'admin'); assert.equal(disabled.updatedBy, 'other-admin');
    await assert.rejects(f.service.saveSchedule({ revision: original.revision, enabled: true }, 'admin', original.id), /changed/);
    f.advance(120); await f.service.scheduler.tick(); assert.equal(f.started.length, 1);
    const enabled = await f.service.saveSchedule({ revision: disabled.revision, enabled: true }, 'admin', original.id);
    assert.equal(enabled.nextRunAt, '2026-10-09T11:00:00.000Z');
    await f.service.deleteSchedule(original.id); assert.equal((await f.service.listSchedules()).length, 0);
    assert.equal((await f.service.store.get(enabled.lastFlowId)).status, 'running');
});
test('restart retains jobs and skips missed slots without retrying an interrupted launch', async t => {
    const f = await fixture(t), job = await f.create();
    f.service.schedules.saveSync({ ...f.service.schedules.getSync(job.id), pendingLaunch: { token: 'interrupted', scheduledAt: job.nextRunAt } });
    f.advance(190); await f.service.scheduler.close(); f.service.database.close(); f.service.database.initialize(); f.service.scheduler.initialize(); f.service.scheduler.start();
    const restored = (await f.service.listSchedules())[0];
    assert.equal(restored.id, job.id); assert.equal(restored.lastOutcome, 'failed'); assert.match(restored.lastError, /interrupted/);
    assert.equal(restored.nextRunAt, '2026-10-09T11:00:00.000Z'); await f.service.scheduler.tick(); assert.equal(f.started.length, 0);
});
test('folder failures are recorded once per slot without a retry loop', async t => {
    const f = await fixture(t); await f.create(); f.service.runtimeManager.resolveCwd = async () => { throw new Error('Working folder unavailable'); };
    f.advance(60); await f.service.scheduler.tick(); await f.service.scheduler.tick();
    const job = (await f.service.listSchedules())[0]; assert.equal(job.lastOutcome, 'failed'); assert.match(job.lastError, /unavailable/);
    assert.equal(job.nextRunAt, '2026-10-09T09:00:00.000Z'); assert.equal(f.started.length, 0);
});
test('editing, disabling or deleting a claimed job cancels its launch and rolls back the run record', async t => {
    for (const operation of ['edit', 'disable', 'delete']) {
        const f = await fixture(t), job = await f.create();
        let release, reached, blocked = false; const waiting = new Promise(resolve => { reached = resolve; });
        f.service.runtimeManager.resolveCwd = async () => {
            if (blocked) return f.root;
            blocked = true; reached(); return new Promise(resolve => { release = () => resolve(f.root); });
        };
        f.advance(60); const tick = f.service.scheduler.tick(); await waiting;
        if (operation === 'delete') await f.service.deleteSchedule(job.id);
        else await f.service.saveSchedule({ revision: job.revision, ...(operation === 'disable' ? { enabled: false } : { name: 'Edited before launch' }) }, 'admin', job.id);
        release(); await tick;
        assert.equal(f.started.length, 0, operation); assert.equal((await f.service.store.list()).length, 0, operation);
    }
});
test('schedule references prevent workflow deletion and each future run uses the latest workflow definition', async t => {
    const f = await fixture(t), job = await f.create();
    await assert.rejects(f.service.deleteWorkflow('scheduled'), /Cron jobs/);
    const workflow = await f.service.registry.get('scheduled'); await f.service.updateWorkflow('scheduled', { ...workflow, name: 'Revised work' });
    f.advance(60); await f.service.scheduler.tick();
    assert.equal((await f.service.store.get((await f.service.listSchedules())[0].lastFlowId)).graph.name, 'Revised work');
    await f.service.deleteSchedule(job.id); assert.equal(await f.service.deleteWorkflow('scheduled'), true);
});
test('invalid input, unavailable workflows and mode mismatches do not create jobs', async t => {
    const f = await fixture(t);
    for (const extra of [{ name: '' }, { objective: null }, { folder: '/outside' }, { workflowTypeId: 'missing' }, { enabled: 'yes' }, { executionType: 'browser' }, { timing: { kind: 'daily', times: ['27:00'], timeZone: 'UTC' } }]) await assert.rejects(f.create(extra));
    await assert.rejects(f.create({ workflowTypeId: 'default' }), /Execution mode/);
    const job = await f.create({ workflowTypeId: 'default', executionType: 'browser' }); assert.equal(job.executionType, 'browser');
    const changed = await f.service.saveSchedule({ revision: job.revision, workflowTypeId: 'scheduled' }, 'admin', job.id); assert.equal(changed.executionType, undefined);
});
test('Cron jobs inherit the current workflow objective while explicit legacy overrides stay unchanged', async t => {
    const f = await fixture(t);
    const inherited = await f.create({ objective: '' }); assert.equal(inherited.objective, '');
    const explicit = await f.create({ name: 'Explicit job', objective: 'Keep this request' });
    const previous = await f.service.registry.get('scheduled');
    await f.service.updateWorkflow('scheduled', { ...previous, defaultObjective: 'Produce the revised daily report' });
    f.advance(60); await f.service.scheduler.tick();
    const jobs = await f.service.listSchedules();
    assert.equal((await f.service.store.get(jobs.find(job => job.id === inherited.id).lastFlowId)).objective, 'Produce the revised daily report');
    assert.equal((await f.service.store.get(jobs.find(job => job.id === explicit.id).lastFlowId)).objective, 'Keep this request');
    await assert.rejects(f.create({ workflowTypeId: 'default', executionType: 'terminal', objective: '' }), /explicit objective/);
    await assert.rejects(f.create({ workflowTypeId: 'code-development', objective: '' }), /explicit objective/);
});
test('daily scheduled jobs launch at the selected local time and disabling before that time prevents execution', async t => {
    const f = await fixture(t), job = await f.create({ timing: { kind: 'daily', times: ['12:00', '18:00'], timeZone: 'Europe/Bucharest' } });
    assert.equal(job.nextRunAt, '2026-10-09T09:00:00.000Z'); f.advance(120); await f.service.scheduler.tick(); assert.equal(f.started.length, 1);
    assert.equal((await f.service.listSchedules())[0].nextRunAt, '2026-10-09T15:00:00.000Z');
    await f.service.saveSchedule({ revision: job.revision, enabled: false }, 'admin', job.id);
    await f.service.store.update((await f.service.listSchedules())[0].lastFlowId, flow => { flow.status = 'completed'; });
    f.advance(360); await f.service.scheduler.tick(); assert.equal(f.started.length, 1);
});
test('Run now launches immediately, resets the interval and captures the acting administrator', async t => {
    const f = await fixture(t), job = await f.create(); f.advance(20);
    const result = await f.service.runScheduleNow(job.id, job.revision, 'manual-admin');
    assert.equal(f.started.length, 1); assert.equal(result.flow.createdBy, 'manual-admin');
    assert.equal(result.flow.scheduleId, job.id); assert.equal(result.flow.scheduledAt, '2026-10-09T07:20:00.000Z');
    assert.equal(result.schedule.nextRunAt, '2026-10-09T08:20:00.000Z'); assert.equal(result.schedule.revision, 2);
    assert.equal(result.schedule.createdBy, 'admin'); assert.equal(result.schedule.updatedBy, 'manual-admin');
    await f.service.store.update(result.flow.id, flow => { flow.status = 'completed'; });
    f.advance(40); await f.service.scheduler.tick(); assert.equal(f.started.length, 1);
    f.advance(20); await f.service.scheduler.tick(); assert.equal(f.started.length, 2);
});
test('Run now for daily and disabled jobs preserves their scheduling configuration', async t => {
    const f = await fixture(t);
    const daily = await f.create({ timing: { kind: 'daily', times: ['12:00', '18:00'], timeZone: 'Europe/Bucharest' } });
    f.advance(130);
    const result = await f.service.runScheduleNow(daily.id, daily.revision, 'admin');
    assert.equal(result.schedule.nextRunAt, '2026-10-09T15:00:00.000Z'); assert.deepEqual(result.schedule.timing, daily.timing);
    const disabled = await f.create({ enabled: false });
    const manual = await f.service.runScheduleNow(disabled.id, disabled.revision, 'admin');
    assert.equal(manual.schedule.enabled, false); assert.equal(manual.schedule.nextRunAt, null);
    assert.equal(manual.schedule.lastFlowId, manual.flow.id); assert.equal(f.started.length, 2);
});
test('Run now rejects stale, missing and held jobs without changing their next occurrence', async t => {
    const f = await fixture(t), job = await f.create();
    await assert.rejects(f.service.runScheduleNow(job.id, undefined, 'admin'), { statusCode: 400 });
    await assert.rejects(f.service.runScheduleNow(job.id, 0, 'admin'), { statusCode: 409 });
    await assert.rejects(f.service.runScheduleNow('cron_missing', 1, 'admin'), { statusCode: 404 });
    assert.equal(f.service.schedules.getSync(job.id).nextRunAt, job.nextRunAt);
    f.advance(20); const { flow, schedule } = await f.service.runScheduleNow(job.id, 1, 'admin');
    for (const state of ['pending', 'running', 'paused']) {
        await f.service.store.update(flow.id, record => { record.status = state; });
        await assert.rejects(f.service.runScheduleNow(job.id, schedule.revision, 'admin'), { statusCode: 409 });
        assert.equal(f.service.schedules.getSync(job.id).nextRunAt, schedule.nextRunAt);
    }
    await f.service.scheduler.close();
    await assert.rejects(f.service.runScheduleNow(job.id, schedule.revision, 'admin'), { statusCode: 503 });
});
test('concurrent Run now requests and a due scheduler tick create only one execution', async t => {
    const f = await fixture(t), job = await f.create(); f.advance(60);
    const results = await Promise.allSettled([f.service.runScheduleNow(job.id, 1, 'admin'), f.service.runScheduleNow(job.id, 1, 'admin'), f.service.scheduler.tick()]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.statusCode, 409);
    assert.equal(f.started.length, 1); assert.equal((await f.service.listSchedules())[0].nextRunAt, '2026-10-09T09:00:00.000Z');
    const second = await fixture(t), due = await second.create(); second.advance(60);
    const tick = second.service.scheduler.tick();
    await assert.rejects(second.service.runScheduleNow(due.id, due.revision, 'admin'), { statusCode: 409 });
    await tick; assert.equal(second.started.length, 1);
});
test('Run now records launch failure and keeps its reset slot without automatic retry', async t => {
    const f = await fixture(t), job = await f.create(); f.advance(20);
    f.service.runtimeManager.resolveCwd = async () => { throw new Error('Folder unavailable'); };
    await assert.rejects(f.service.runScheduleNow(job.id, 1, 'admin'), /Folder unavailable/);
    const failed = (await f.service.listSchedules())[0];
    assert.equal(failed.nextRunAt, '2026-10-09T08:20:00.000Z'); assert.equal(failed.lastOutcome, 'failed');
    assert.equal(failed.launching, false); assert.equal(failed.lastError, 'Folder unavailable');
    await f.service.scheduler.tick(); assert.equal(f.started.length, 0);
});
test('an in-flight manual claim blocks duplicates and is invalidated by edits, removal or shutdown', async t => {
    for (const operation of ['edit', 'disable', 'delete', 'shutdown']) {
        const f = await fixture(t), job = await f.create();
        let release, reached, blocked = false;
        const waiting = new Promise(resolve => { reached = resolve; });
        f.service.runtimeManager.resolveCwd = async () => {
            if (blocked) return f.root;
            blocked = true; reached(); return new Promise(resolve => { release = () => resolve(f.root); });
        };
        const launch = f.service.runScheduleNow(job.id, job.revision, 'admin');
        const rejected = assert.rejects(launch, /Cron job changed before launch/);
        await waiting;
        await assert.rejects(f.service.runScheduleNow(job.id, 2, 'admin'), { statusCode: 409 });
        let closing;
        if (operation === 'delete') await f.service.deleteSchedule(job.id);
        else if (operation === 'shutdown') closing = f.service.scheduler.close();
        else await f.service.saveSchedule({ revision: 2, ...(operation === 'disable' ? { enabled: false } : { name: 'Changed' }) }, 'admin', job.id);
        release(); await rejected; await closing;
        assert.equal(f.started.length, 0, operation); assert.equal((await f.service.store.list()).length, 0, operation);
    }
});
