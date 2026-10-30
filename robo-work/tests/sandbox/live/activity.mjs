// M-35 live measurement: the CPU use of the processes of a workload sandbox (an idle or stalled `opencode serve`), and what the activity
// meter says at the 60 s watchdog cadence. Run as container root:
//   node activity.mjs [seconds=180] [match='opencode serve'] [pid]      (pid picks one of several matches)
// It finds the workload by command line, takes its pid namespace and bwrap init from /proc, then samples raw utime+stime of every member
// every 10 s (printed as % of one CPU) and runs the real meter at 0, 60, 120, ... s. Prints one JSON document; read-only.
import fs from 'node:fs';

import { createProcView } from '../../../server/execution/procView.mjs';
import { ACTIVITY_CPU_FRACTION, createActivityMeter, createWorkloadActivityWalk, parseCpuTicks } from '../../../server/sandbox/workloadActivity.mjs';

const seconds = Number(process.argv[2] ?? 180);
const match = process.argv[3] ?? 'opencode serve';
const view = createProcView({});
const all = view.listProcesses();
const wantedPid = process.argv[4] === undefined ? null : Number(process.argv[4]);
// a sandbox's bwrap monitor carries the workload's command line too: only a process INSIDE a sandbox namespace is the workload
const selfPidNs = view.selfNamespaces().pidNs;
const target = all.find((entry) => entry.pidNs !== selfPidNs && entry.cmdline.join(' ').includes(match) && (wantedPid === null || entry.pid === wantedPid));
if (!target) { process.stdout.write(`${JSON.stringify({ error: `no process matching "${match}"` })}\n`); process.exit(2); }
const init = all.find((entry) => entry.pid === target.ppid && entry.pidNs === target.pidNs) ?? target;
const workloads = [{ pidNs: target.pidNs, init: { pid: init.pid, startTime: init.startTime } }];
const walk = createWorkloadActivityWalk({ view });
const meter = createActivityMeter({ walk });
const membersNow = () => view.listProcesses().filter((entry) => entry.pidNs === target.pidNs);
const read = (pid) => { try { return parseCpuTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; } };
const out = { target: { pid: target.pid, cmd: target.cmdline.join(' ').slice(0, 80), pidNs: target.pidNs }, members: membersNow().map((entry) => ({ pid: entry.pid, cmd: entry.cmdline[0]?.slice(-40) })), threshold: `${ACTIVITY_CPU_FRACTION * 100}% of one CPU (${ACTIVITY_CPU_FRACTION * 60} s per 60 s)`, samples: [], meterAt60s: [] };
let previous = new Map(membersNow().map((entry) => [entry.pid, read(entry.pid)?.ticks ?? 0n]));
const started = Date.now();
out.meterAt60s.push({ atS: 0, activity: meter.sample(workloads), note: 'first sample: every member is new' });
for (let at = 10; at <= seconds; at += 10) {
    await new Promise((resolve) => setTimeout(resolve, started + at * 1000 - Date.now()));
    const current = new Map();
    let grown = 0n;
    for (const entry of membersNow()) {
        const ticks = read(entry.pid)?.ticks;
        if (ticks === undefined) continue;
        current.set(entry.pid, ticks);
        if (previous.has(entry.pid) && ticks > previous.get(entry.pid)) grown += ticks - previous.get(entry.pid);
    }
    out.samples.push({ atS: at, cpuPercentOfOneCpu: Number((Number(grown) / 100 / 10 * 100).toFixed(3)), members: current.size });
    previous = current;
    if (at % 60 === 0) out.meterAt60s.push({ atS: at, activity: meter.sample(workloads) });
}
const percents = out.samples.map((sample) => sample.cpuPercentOfOneCpu);
out.summary = { maxPercent: Math.max(...percents), meanPercent: Number((percents.reduce((a, b) => a + b, 0) / percents.length).toFixed(3)), thresholdPercent: ACTIVITY_CPU_FRACTION * 100 };
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
