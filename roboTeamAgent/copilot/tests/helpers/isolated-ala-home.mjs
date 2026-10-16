import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Without ACHILLES_ALA_HOME a standalone engine uses the user's home for ALA
// configuration. Tests always get a private home instead.
if (!process.env.ACHILLES_ALA_HOME) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-ala-home-'));
    process.env.ACHILLES_ALA_HOME = home;
    process.once('exit', () => fs.rmSync(home, { recursive: true, force: true }));
}
