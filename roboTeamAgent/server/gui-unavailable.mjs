// Decision M-67: with the worker configured RoboTeam's own Browser/Desktop container is refused, because it would run the robot's
// old HOME, bind the project cwd read-write without the worker's masks and run outside the worker's ledger. The status is a 409
// so that the HTTP layer shows the plain message; the code is the stable part.
export const GUI_UNAVAILABLE_WITH_WORKER = 'gui_unavailable_with_worker';
export const GUI_UNAVAILABLE_MESSAGE = "Browser and Desktop robots aren't available with the worker yet";
export const GUI_EXECUTION_TYPES = Object.freeze(['browser', 'desktop']);
export function guiUnavailableWithWorkerError() {
    return Object.assign(new Error(GUI_UNAVAILABLE_MESSAGE), { code: GUI_UNAVAILABLE_WITH_WORKER, publicCode: GUI_UNAVAILABLE_WITH_WORKER, status: 409, statusCode: 409 });
}
