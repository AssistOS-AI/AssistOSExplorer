import { validateMountedRequiredSkills } from '../server/required-skills.mjs';

try {
    await validateMountedRequiredSkills();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
