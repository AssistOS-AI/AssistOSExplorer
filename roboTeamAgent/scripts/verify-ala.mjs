import { resolveAlaCommand } from '../server/ala-command.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/alaInstallation.mjs';

try {
    await resolveAlaInstallation({ env: { ...process.env,
        ACHILLES_ALA_COMMAND: resolveAlaCommand() } });
} catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
}
