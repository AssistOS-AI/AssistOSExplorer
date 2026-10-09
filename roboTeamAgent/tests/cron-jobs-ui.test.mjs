import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { scheduleSummary, schedulePayload } from '../public/cron-jobs.js';

test('Cron job summaries show clear intervals and daily times with their time zone', () => {
    for (const [minutes, label] of [[1, 'Every 1 minute'], [15, 'Every 15 minutes'], [60, 'Every 1 hour'], [120, 'Every 2 hours'], [1440, 'Every 1 day'], [2880, 'Every 2 days']]) assert.equal(scheduleSummary({ kind: 'interval', everyMinutes: minutes }), label);
    assert.equal(scheduleSummary({ kind: 'daily', times: ['09:00', '18:00'], timeZone: 'Europe/Bucharest' }), 'Daily at 09:00, 18:00 · Europe/Bucharest');
});
test('form payload keeps task objective and folder, converts intervals and limits mode overrides to default workflows', () => {
    const values = { name: ' Report ', objective: ' Work ', folder: ' /workspace/project ', workflowTypeId: 'example', enabled: true, scheduleKind: 'interval', intervalValue: '2', intervalUnit: '60', executionType: 'browser', defaultWorkflow: false };
    const input = schedulePayload(values, []);
    assert.equal(input.timing.everyMinutes, 120); assert.equal(input.folder, '/workspace/project'); assert.equal(input.objective, 'Work'); assert.equal(input.executionType, undefined);
    assert.deepEqual(schedulePayload({ ...values, scheduleKind: 'daily', timeZone: ' Europe/Bucharest ', defaultWorkflow: true }, ['09:00']).timing, { kind: 'daily', times: ['09:00'], timeZone: 'Europe/Bucharest' });
    assert.equal(schedulePayload({ ...values, defaultWorkflow: true }, []).executionType, 'browser');
});
test('dashboard uses matching cards, discreet status and metadata, grouped editing and an accessible dialog', async () => {
    const [html, js, app, server] = await Promise.all(['../public/index.html', '../public/cron-jobs.js', '../public/app.js', '../server/http-server.mjs'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
    assert.match(html, /class="robot-card cron-card"/); assert.match(html, /class="run-state cron-state"/);
    assert.doesNotMatch(html, /cron-id/); assert.doesNotMatch(js, /querySelector\('\.cron-id'\)/);
    assert.match(html, /id="cronDialog"[^>]*aria-labelledby="cronDialogTitle"/);
    assert.match(html, /id="cronObjectiveField" hidden/); assert.doesNotMatch(html, /name="objective"[^>]*required/);
    assert.match(js, /control\('objective'\)\.required = requiresObjective/);
    assert.match(js, /!workflow\?\.defaultObjective/);
    assert.match(html, /name="folder" type="hidden"/); assert.doesNotMatch(html, /Absolute path to a workspace folder/);
    assert.match(html, /id="cronFolderLabel">Workspace \/ cron-jobs-results/);
    assert.match(html, /id="cronFolderDialog"[^>]*aria-labelledby="cronFolderDialogTitle"/);
    assert.match(html, /id="cronFolderNew"/); assert.match(html, /id="cronFolderUse"/);
    assert.match(html, /id="cronExecutionField" hidden/);
    assert.match(js, /revision: job\.revision/); assert.match(js, /initRobotMenu/); assert.match(js, /initCreateRobotDialog/);
    assert.match(js, /bindLink\(run\)/); assert.match(js, /requestController\?\.abort\(\); clearInterval\(timer\)/);
    assert.match(js, /epoch !== requestEpoch/);
    assert.match(js, /timer = setInterval\(\(\) => \{ if \(!root\.hidden\) void refresh\(\); \}, 60_000\)/);
    assert.match(js, /if \(saved\) \{[^\n]*await refresh\(true, false\)/);
    assert.match(js, /pendingMutations\.delete\(job\.id\); await refresh\(true, false\)/);
    assert.match(js, /panel\.hidden \|\| dialog\.open/); assert.match(js, /if \(!admin \|\| busy\) return/);
    assert.match(app, /requestedTab === 'cron-jobs' \? 'kronJobsTab'/);
    assert.match(server, /pathname === '\/cron-jobs\.js'/);
});
test('all Cron job actions live in the menu, with guarded immediate execution', async () => {
    const [html, js] = await Promise.all(['../public/index.html', '../public/cron-jobs.js'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
    const actions = html.match(/<div class="robot-actions cron-actions">([\s\S]*?)<\/article>/)[1];
    const menu = actions.slice(actions.indexOf('data-robot-menu-options'));
    for (const name of ['cron-run-now', 'cron-toggle', 'cron-edit', 'cron-delete']) {
        assert.equal(actions.indexOf(name), menu.indexOf(name) + actions.indexOf('data-robot-menu-options'));
    }
    assert.match(js, /schedules\/\$\{job\.id\}\/run-now/);
    assert.match(js, /runNow\.disabled = held/);
    assert.match(js, /pendingMutations\.has\(job\.id\)/);
    assert.match(js, /\['pending', 'running', 'paused'\]\.includes\(job\.lastFlowStatus\)/);
});
test('Cron job timing, next run and last-run link share a responsive row with matching typography', async () => {
    const [html, css] = await Promise.all(['../public/index.html', '../public/styles.css'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
    assert.match(html, /class="cron-schedule"><p class="cron-timing"><\/p><p class="cron-next"><\/p><a class="view-logs cron-view-run" hidden>View last run<\/a><\/div>/);
    assert.doesNotMatch(html, /class="robot-title-row">[^\n]*cron-view-run/);
    assert.match(css, /\.cron-schedule \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    assert.match(css, /\.cron-schedule \{[^}]*font-size: var\(--font-sm\)/);
    assert.match(css, /\.cron-schedule p \{ margin: 0; \}/);
});
test('Cron job and folder dialogs share stable responsive dimensions and pinned actions', async () => {
    const [html, css] = await Promise.all(['../public/index.html', '../public/styles.css'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
    assert.match(html, /id="cronDialog" class="create-robot-dialog cron-dialog"/);
    assert.match(html, /id="cronFolderDialog" class="create-robot-dialog cron-dialog folder-dialog"/);
    assert.match(html, /class="cron-form-fields"/);
    assert.match(css, /\.cron-dialog \{ width: min\(840px, calc\(100vw - 48px\)\); height: min\(760px, calc\(100dvh - 48px\)\)/);
    assert.doesNotMatch(css, /\.folder-dialog \{[^}]*(?:width|height):/);
    assert.match(css, /\.cron-form-fields \{[^}]*overflow-y: auto; scrollbar-gutter: stable/);
    assert.match(css, /\.cron-dialog \.create-robot-actions \{ flex: 0 0 auto;/);
    assert.match(css, /\.folder-footer \{[^}]*flex: 0 0 auto;/);
    assert.match(css, /\.cron-form-fields \{ grid-template-columns: minmax\(0, 1fr\);/);
});
