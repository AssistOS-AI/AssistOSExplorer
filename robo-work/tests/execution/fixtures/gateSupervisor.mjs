// A stand-in supervisor for the crash case: it starts the gated helper with a gate pipe, reports the helper's PID, and
// then idles holding the write end until it is killed.
//   node gateSupervisor.mjs <result file> <exec marker file>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , resultFile, markerFile] = process.argv;
const helper = fileURLToPath(new URL('./gateHelper.mjs', import.meta.url));
const child = spawn(process.execPath, [helper, '3', resultFile, markerFile], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
child.stdio[3].on('error', () => {});
process.stdout.write(`helper ${child.pid}\n`);
setInterval(() => {}, 1000);
