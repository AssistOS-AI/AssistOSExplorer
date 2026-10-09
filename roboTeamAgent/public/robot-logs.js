import { api, endpoint } from './roboflow-api.js';
import { initRobotLogViewer } from './robot-log-viewer.js';

const robotId = location.pathname.match(/\/robots\/([a-z0-9][a-z0-9-]{2,63})\/logs$/)?.[1];
const title = document.querySelector('#robotLogsTitle');
const status = document.querySelector('#robotLogsStatus');
const output = document.querySelector('#robotLogsOutput');
document.querySelector('#robotsLink').href = endpoint('');
document.querySelector('#closeLogsButton').addEventListener('click', () => {
    window.close();
    if (!window.closed) status.textContent = 'Close this tab to return to the unchanged dashboard.';
});

if (!robotId) {
    status.textContent = 'Invalid robot logs address.';
    document.querySelector('#refreshLogsButton').disabled = true;
} else {
    document.querySelector('#robotLogsId').textContent = robotId;
    const viewer = initRobotLogViewer({ output, status,
        loadLogs: signal => api(`api/robots/${encodeURIComponent(robotId)}/logs?tail=200`, { signal }),
    });
    document.querySelector('#refreshLogsButton').addEventListener('click', () => { void viewer.start(); });
    window.addEventListener('pagehide', () => viewer.pause());
    window.addEventListener('pageshow', () => { void viewer.start(); });
    void viewer.start();
    void api(`api/robots/${encodeURIComponent(robotId)}/run`).then(({ robot }) => {
        title.textContent = `Container logs · ${robot.name}`;
        document.title = `RoboTeam · ${robot.name} · Logs`;
    }).catch(() => {
        // The logs request reports access or availability errors in the page.
        title.textContent = `Container logs · ${robotId}`;
    });
}
