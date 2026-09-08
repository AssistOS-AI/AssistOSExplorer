#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './index.mjs';

export { parseCliOptions } from './lib/cliOptions.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error) => {
        console.error('Fatal error:', error.message);
        process.exitCode = error?.name === 'AbortError' || error?.exitCode === 130 ? 130 : 1;
    });
}
