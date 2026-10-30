// In-container /proc poller (no ps in the worker image). One JSON line per newly seen process ("new") and per disappearance
// ("gone"), plus the file names (not contents) under the worker runtime dir. Read-only; secrets are never read.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const out = process.argv[2] || '/tmp/proc-poll.jsonl';
const live = new Map();
const files = new Set();
const t = () => new Date().toISOString();
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
function walk(dir, depth) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (!files.has(p)) { files.add(p); fs.appendFileSync(out, JSON.stringify({ at: t(), ev: 'file', path: p, dir: e.isDirectory() }) + '\n'); }
    if (e.isDirectory() && depth > 0) walk(p, depth - 1);
  }
}
function scan() {
  let names; try { names = fs.readdirSync('/proc'); } catch { return; }
  const now = new Set();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const stat = read(`/proc/${n}/stat`); if (!stat) continue;
    const s = stat.toString(); const rp = s.lastIndexOf(')'); const f = s.slice(rp + 2).split(' ');
    const key = `${n}:${f[19]}`; now.add(key);
    if (live.has(key)) continue;
    const cmd = (read(`/proc/${n}/cmdline`) ?? Buffer.alloc(0)).toString().split('\0').join(' ').trim();
    const status = (read(`/proc/${n}/status`) ?? '').toString();
    const pick = (k) => (status.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1];
    let cwd = null, exe = null; try { cwd = fs.readlinkSync(`/proc/${n}/cwd`); } catch {} try { exe = fs.readlinkSync(`/proc/${n}/exe`); } catch {}
    live.set(key, { pid: +n });
    fs.appendFileSync(out, JSON.stringify({ at: t(), ev: 'new', pid: +n, ppid: +f[1], start: f[19], exe, cwd, uid: pick('Uid'), capEff: pick('CapEff'), nspid: pick('NSpid'), seccomp: pick('Seccomp'), cmd: cmd.slice(0, 1200) }) + '\n');
  }
  for (const [key, v] of live) {
    if (v.z) continue;
    const st = read(`/proc/${v.pid}/stat`); if (!st) continue;
    const ss = st.toString(); const r2 = ss.lastIndexOf(")"); const g = ss.slice(r2 + 2).split(" ");
    if (g[0] === "Z") { v.z = true; const code = Number(g[49]); fs.appendFileSync(out, JSON.stringify({ at: t(), ev: "zombie", key, exitCode: code, exitStatus: code >> 8, termSignal: code & 0x7f }) + "\n"); }
  }
  for (const key of [...live.keys()]) if (!now.has(key)) { live.delete(key); fs.appendFileSync(out, JSON.stringify({ at: t(), ev: 'gone', key }) + '\n'); }
}
let i = 0;
for (;;) { scan(); if (i++ % 4 === 0) walk('/var/lib/robo-work/runtime', 6); await sleep(4); }
