// A portable stand-in for a gated pre-exec stage: it holds at the gate, and only an explicit commit byte lets it reach
// the "final exec", which here is writing the marker file. It records its decision in <result> first.
//   node gateHelper.mjs <gate fd> <result file> <exec marker file>
import fs from 'node:fs';
import { GATE_COMMIT, awaitGate } from '../../../server/execution/gateProtocol.mjs';

const [, , fdText, resultFile, markerFile] = process.argv;
const decision = awaitGate(Number(fdText));
// Published atomically (a temporary file in the same directory, then rename): a reader that waits for <result> to exist
// never sees it empty, as it could between writeFileSync's open and write.
const temporary = `${resultFile}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${decision}\n`);
fs.renameSync(temporary, resultFile);
if (decision === GATE_COMMIT) {
    fs.writeFileSync(markerFile, 'final-exec\n');
    process.exit(0);
}
process.exit(99);
