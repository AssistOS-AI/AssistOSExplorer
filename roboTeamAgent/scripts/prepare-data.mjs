import fs from 'node:fs/promises';
import { TOOL_CACHE_DIR } from '../server/constants.mjs';

await fs.mkdir(TOOL_CACHE_DIR, { recursive: true, mode: 0o700 });
await fs.chmod(TOOL_CACHE_DIR, 0o700);
