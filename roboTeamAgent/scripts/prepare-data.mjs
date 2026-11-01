import fs from 'node:fs/promises';
import { DATA_DIR } from '../server/constants.mjs';

await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await fs.chmod(DATA_DIR, 0o700);
