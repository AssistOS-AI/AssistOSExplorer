import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTiming, nextRun } from '../server/roboflow/schedule-timing.mjs';
const utc = value => Date.parse(value);
const iso = value => new Date(value).toISOString();
const daily = (times, timeZone = 'Europe/Bucharest') => normalizeTiming({ kind: 'daily', times, timeZone });

test('interval scheduling preserves its anchor and advances past missed slots without replay', () => {
    const timing = normalizeTiming({ kind: 'interval', everyMinutes: 60 }), anchor = utc('2026-10-09T07:00:00Z');
    assert.equal(iso(nextRun(timing, anchor)), '2026-10-09T08:00:00.000Z');
    assert.equal(iso(nextRun(timing, anchor + 130 * 60000, anchor)), '2026-10-09T10:00:00.000Z');
    for (const everyMinutes of [0, -1, 1.5, '1', 525601, null]) assert.throws(() => normalizeTiming({ kind: 'interval', everyMinutes }));
});
test('daily times use the explicit time zone, sort and deduplicate, and advance to the following day', () => {
    const timing = daily(['18:00', '09:00', '09:00']);
    assert.deepEqual(timing.times, ['09:00', '18:00']);
    assert.equal(iso(nextRun(timing, utc('2026-10-09T05:59:59Z'))), '2026-10-09T06:00:00.000Z');
    assert.equal(iso(nextRun(timing, utc('2026-10-09T06:00:00Z'))), '2026-10-09T15:00:00.000Z');
    assert.equal(iso(nextRun(timing, utc('2026-10-09T15:00:00Z'))), '2026-10-10T06:00:00.000Z');
});
test('spring daylight-saving gap is skipped and autumn repeated local time launches only once', () => {
    assert.equal(iso(nextRun(daily(['03:30']), utc('2026-03-28T22:00:00Z'))), '2026-03-30T00:30:00.000Z');
    const repeated = daily(['03:30']);
    assert.equal(iso(nextRun(repeated, utc('2026-10-24T21:00:00Z'))), '2026-10-25T00:30:00.000Z');
    assert.equal(iso(nextRun(repeated, utc('2026-10-25T00:30:00Z'))), '2026-10-26T01:30:00.000Z');
});
test('daily schedules support UTC, fractional-offset time zones and year boundaries', () => {
    assert.equal(iso(nextRun(daily(['00:15'], 'UTC'), utc('2026-12-31T23:59:00Z'))), '2027-01-01T00:15:00.000Z');
    assert.equal(iso(nextRun(daily(['09:00'], 'Asia/Kathmandu'), utc('2026-10-09T00:00:00Z'))), '2026-10-09T03:15:00.000Z');
    assert.equal(iso(nextRun(daily(['09:00'], 'Pacific/Auckland'), utc('2026-10-09T00:00:00Z'))), '2026-10-09T20:00:00.000Z');
});
test('invalid modes, zones and daily time lists fail validation', () => {
    for (const times of [[], ['25:00'], ['09:60'], ['9:00'], ['09:00:00'], [42], Array(25).fill('09:00')]) assert.throws(() => daily(times));
    for (const timeZone of ['', 'Not/AZone', null]) assert.throws(() => daily(['09:00'], timeZone));
    assert.throws(() => normalizeTiming({ kind: 'cron', expression: '* * * * *' }));
});
