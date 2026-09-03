export const RESUME_REOBSERVE_INSTRUCTION = 'Human control has ended. Inspect the current desktop with get_app_state before taking any action. Previous element indices and window focus are invalid. Continue the original task from the current desktop state.';

// This is intentionally not an agent controller. A future implementation may
// forward stop/resume requests to an agent runtime that lives inside the robot
// workstation. RoboTeam itself remains controller- and model-neutral.
export function createWorkstationControlAdapter() {
    return null;
}
