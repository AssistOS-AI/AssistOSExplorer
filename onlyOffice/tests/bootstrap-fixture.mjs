import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Exact compression command shapes from the pinned DocumentServer package.
export const pinnedStaticGzipCommands = [
    'find ./sdkjs ./web-apps ./sdkjs-plugins ./dictionaries -type f \\( -name *.js -o -name *.json -o -name *.htm -o -name *.html -o -name *.css -o -name *.bin -o -name *.wasm -o -name *.dic -o -name *.aff -o -name *.svg \\) -exec gzip -kf9 {} \\;',
    'find ./fonts -type f ! -name "*.*" -exec gzip -kf9 {} \\;',
];

export async function fixtureBootstrapEnv(directory) {
    directory = await realpath(directory);
    const commandDirectory = path.join(directory, 'bootstrap-commands');
    await mkdir(commandDirectory);
    await writeFile(path.join(commandDirectory, 'documentserver-generate-allfonts.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const staticDirectory = path.join(directory, 'static-assets');
    for (const leaf of ['sdkjs', 'web-apps', 'sdkjs-plugins', 'dictionaries', 'fonts']) {
        await mkdir(path.join(staticDirectory, leaf), { recursive: true });
    }
    await writeFile(path.join(commandDirectory, 'documentserver-static-gzip.sh'), [
        '#!/bin/bash', 'cd "$ONLYOFFICE_GZIP_FIXTURE_DIRECTORY"', ...pinnedStaticGzipCommands,
    ].join('\n'), { mode: 0o755 });
    const script = path.join(directory, 'bootstrap.mjs');
    await writeFile(script, `
import { runBootstrapCommand } from ${JSON.stringify(new URL('../scripts/document-server-bootstrap.mjs', import.meta.url).href)};
try {
    const result = await runBootstrapCommand(process.argv.slice(2), {
        stateDirectory: ${JSON.stringify(path.join(directory, 'bootstrap'))},
        readIdentity: async (pid) => {
            process.kill(pid, 0);
            return { pid, startTime: '123', bootId: '11111111-1111-1111-1111-111111111111' };
        },
    });
    if (result) process.stdout.write(result + '\\n');
} catch {
    process.stderr.write('OnlyOffice DocumentServer bootstrap is incomplete or invalid.\\n');
    process.exitCode = 1;
}
`);
    return {
        ONLYOFFICE_GZIP_FIXTURE_DIRECTORY: staticDirectory,
        ONLYOFFICE_BOOTSTRAP_SCRIPT: script,
        ONLYOFFICE_NODE_BIN: process.execPath,
        PATH: `${commandDirectory}:${process.env.PATH}`,
    };
}
