export const RESUME_REOBSERVE_INSTRUCTION = 'Human control has ended. Inspect the current visible desktop or browser state with the available MCP tools before taking any action. Previous element indices and window focus may be invalid. Preserve the human\'s changes and continue the original task from the current state.';

// This is intentionally not an agent controller. A future implementation may
// forward stop/resume requests to an agent runtime that lives inside the robot
// workstation. RoboTeam itself remains controller- and model-neutral.
export function createWorkstationControlAdapter() {
    return null;
}
